import {Command} from "commander";
import {execSync, spawn, spawnSync} from "child_process";
import fs from "fs-extra";
import path from "path";
import os from "os";
import * as tar from "tar";
import semver from "semver";
import {apiAi} from "../utils/api-ai.js";
import {minimatch} from "minimatch";
import chokidar from "chokidar";
import crypto from "crypto";

const AGENTS_DIR = path.join(os.homedir(), ".lifectl", "agents");
const CONTAINERS_DIR = path.join(os.homedir(), ".lifectl", "containers");

const ALLOWED_RUNTIMES = new Set(["node", "python", "python3", "deno", "bun", "npx", "ts-node", "tsx"]);

function generateId(): string {
    return crypto.randomBytes(6).toString("hex");
}

function sanitizeName(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9\-_.\/]/g, "");
    if (safe.includes("..") || safe.startsWith("/") || safe.endsWith("/") || safe.includes("//")) throw new Error(`Invalid agent name: '${name}'`);
    return safe;
}

function sanitizeLog(s: string): string {
    return String(s).replace(/[\r\n]/g, " ");
}

function validateCmd(cmd: string): void {
    if (/[;&|`$<>]/.test(cmd)) throw new Error("Invalid characters in script command");
    const {bin} = parseCmd(cmd);
    if (!ALLOWED_RUNTIMES.has(path.basename(bin))) throw new Error(`Command must start with an allowed runtime. Allowed: ${[...ALLOWED_RUNTIMES].join(", ")}`);
}

function parseCmd(cmd: string): { bin: string; args: string[] } {
    const tokens: string[] = [];
    let current = "";
    let quote: string | null = null;
    for (const ch of cmd) {
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
        } else if (ch === "'" || ch === '"') {
            quote = ch;
        } else if (ch === " ") {
            if (current) { tokens.push(current); current = ""; }
        } else {
            current += ch;
        }
    }
    if (current) tokens.push(current);
    if (tokens.length === 0) throw new Error("Empty command");
    return {bin: tokens[0], args: tokens.slice(1)};
}

function resolveAgentPath(name: string, ...parts: string[]): string {
    const resolved = path.resolve(AGENTS_DIR, ...name.split("/"), ...parts);
    if (!resolved.startsWith(path.resolve(AGENTS_DIR))) throw new Error(`Path traversal detected for agent name: '${name}'`);
    return resolved;
}

function resolveContainerPath(containerId: string, ...parts: string[]): string {
    const resolved = path.resolve(CONTAINERS_DIR, containerId, ...parts);
    if (!resolved.startsWith(path.resolve(CONTAINERS_DIR))) throw new Error(`Path traversal detected for container: '${containerId}'`);
    return resolved;
}

export const aiCommand = new Command("ai").description("AI agent commands");
const agentCommand = new Command("agent").description("Manage AI agents");

async function tarDirectory(sourceDir: string, outPath: string): Promise<void> {
    const ignoreFile = path.join(sourceDir, ".agentignore");
    const ignorePatterns = ["*.tar.gz", ".agentignore"];
    if (await fs.pathExists(ignoreFile)) {
        const lines = (await fs.readFile(ignoreFile, "utf-8")).split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
        ignorePatterns.push(...lines);
    }
    const entries = (await fs.readdir(sourceDir)).filter(f => !ignorePatterns.some(p => minimatch(f, p)));
    await tar.create({gzip: true, file: outPath, cwd: sourceDir}, entries);
}

function agentPath(name: string, ...parts: string[]): string {
    return resolveAgentPath(name, ...parts);
}

async function getLatestLocalVersion(name: string): Promise<string> {
    const registry = await loadRegistry();
    const versions = Object.keys(registry[name]?.versions ?? {});
    const latest = semver.maxSatisfying(versions, "*");
    if (!latest) throw new Error(`No versions found for agent '${name}'`);
    return latest;
}

async function loadRegistry(): Promise<Record<string, any>> {
    const registryFile = path.join(AGENTS_DIR, "registry.json");
    if (await fs.pathExists(registryFile)) return await fs.readJson(registryFile);
    // fallback: rebuild — use stable hash as agentId to avoid changing on every rebuild
    const registry: Record<string, any> = {};
    if (!await fs.pathExists(AGENTS_DIR)) return registry;
    for (const rawAgentName of await fs.readdir(AGENTS_DIR)) {
        let agentName: string;
        try { agentName = sanitizeName(rawAgentName); } catch { continue; }
        const agentNameDir = path.join(AGENTS_DIR, agentName);
        if (!(await fs.stat(agentNameDir)).isDirectory()) continue;
        const allEntries = await fs.readdir(agentNameDir);
        const versions = (await Promise.all(
            allEntries.map(async v => ((await fs.stat(path.join(agentNameDir, v))).isDirectory() ? v : null))
        )).filter(Boolean) as string[];
        registry[agentName] = {versions: {}};
        for (const ver of versions) {
            const agentJson = path.join(agentNameDir, ver, "agent.json");
            if (!await fs.pathExists(agentJson)) continue;
            const agent = await fs.readJson(agentJson);
            const stableId = crypto.createHash("sha256").update(`${agentName}@${ver}`).digest("hex").slice(0, 12);
            registry[agentName].versions[ver] = {
                agentId: stableId,
                name: agent.name ?? agentName,
                version: agent.version ?? ver,
                description: agent.description ?? "",
                runtime: agent.runtime ?? "",
                pulledAt: Date.now(),
            };
        }
    }
    await fs.writeJson(registryFile, registry, {spaces: 2});
    return registry;
}

async function pullAgent(name: string): Promise<void> {
    const tmpFile = path.join(os.tmpdir(), `agent-${Date.now()}.tar.gz`);
    try {
        const response = await apiAi.post("/agents/pull", {name}, {responseType: "arraybuffer"});
        await fs.writeFile(tmpFile, Buffer.from(response.data));
        const agentVersion = sanitizeName(String(response.headers["x-agent-version"] ?? "unknown"));
        const agentDir = agentPath(name, agentVersion);
        await fs.ensureDir(agentDir);
        await tar.extract({file: tmpFile, cwd: agentDir, filter: (p) => !p.includes("..")});
        const agentJson = path.join(agentDir, "agent.json");
        const agent = await fs.pathExists(agentJson) ? await fs.readJson(agentJson) : {};
        const registryFile = path.join(AGENTS_DIR, "registry.json");
        const registry = await fs.pathExists(registryFile) ? await fs.readJson(registryFile) : {};
        if (!registry[name]) registry[name] = {versions: {}};
        const agentId = generateId();
        registry[name].versions[agentVersion] = {
            agentId,
            name: agent.name ?? name,
            version: agent.version ?? agentVersion,
            description: agent.description ?? "",
            runtime: agent.runtime ?? "",
            pulledAt: Date.now(),
        };
        await fs.writeJson(registryFile, registry, {spaces: 2});
        console.log(`✅ Pulled ${sanitizeLog(name)}@${sanitizeLog(agentVersion)} (${agentId})`);
    } finally {
        await fs.remove(tmpFile);
    }
}

async function loadContainers(): Promise<Record<string, any>> {
    const containersFile = path.join(CONTAINERS_DIR, "containers.json");
    if (await fs.pathExists(containersFile)) return await fs.readJson(containersFile);
    return {};
}

async function saveContainers(containers: Record<string, any>): Promise<void> {
    await fs.ensureDir(CONTAINERS_DIR);
    await fs.writeJson(path.join(CONTAINERS_DIR, "containers.json"), containers, {spaces: 2});
}

function isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// push
agentCommand
    .command("push")
    .description("Push agent to registry")
    .action(async () => {
        const tmpDir = path.join(os.tmpdir(), "lifetimesoft");
        await fs.ensureDir(tmpDir);
        const zipPath = path.join(tmpDir, `agent-${Date.now()}.tar.gz`);
        try {
            const agentJson = path.join(process.cwd(), "agent.json");
            if (!await fs.pathExists(agentJson)) throw new Error("agent.json not found");
            const agent = await fs.readJson(agentJson);
            console.log("📦 Packing agent...");
            await tarDirectory(process.cwd(), zipPath);
            const zipBuffer = await fs.readFile(zipPath);
            const {data} = await apiAi.post("/agents/push", zipBuffer, {
                headers: {
                    "Content-Type": "application/gzip",
                    "X-Agent-Name": agent.name,
                    "X-Agent-Version": agent.version,
                    "X-Agent-Meta": Buffer.from(JSON.stringify(agent)).toString("base64"),
                },
            });
            if (!data.success) throw new Error(data.message ?? "Push rejected by server");
            console.log(`✅ Pushed ${sanitizeLog(agent.name)}@${sanitizeLog(agent.version)}`);
        } catch (err: any) {
            console.error("❌ Push failed:", err.message);
            process.exit(1);
        } finally {
            await fs.remove(zipPath);
        }
    });

// pull
agentCommand
    .command("pull <name>")
    .description("Pull agent from registry")
    .action(async (rawName: string) => {
        try {
            await pullAgent(sanitizeName(rawName));
        } catch (err: any) {
            console.error("❌ Pull failed:", err.message);
            process.exit(1);
        }
    });

const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const LOG_MAX_FILES = 5;

async function rotateLog(logFile: string): Promise<void> {
    if (!await fs.pathExists(logFile)) return;
    const {size} = await fs.stat(logFile);
    if (size < LOG_MAX_BYTES) return;
    for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
        const src = `${logFile}.${i}`;
        const dst = `${logFile}.${i + 1}`;
        if (await fs.pathExists(src)) await fs.move(src, dst, {overwrite: true});
    }
    await fs.move(logFile, `${logFile}.1`, {overwrite: true});
}

async function spawnProcess(containerId: string, agentDir: string, startCmd: string): Promise<number> {
    const containerDir = resolveContainerPath(containerId);
    const logFile = path.join(containerDir, "agent.log");
    const pidFile = path.join(containerDir, "agent.pid");
    await rotateLog(logFile);
    const logFd = fs.openSync(logFile, "a");
    const {bin: cmd, args} = parseCmd(startCmd);
    const child = spawn(cmd, args, {cwd: agentDir, detached: true, stdio: ["ignore", logFd, logFd]});
    fs.closeSync(logFd);
    child.unref();
    if (child.pid == null) throw new Error("Failed to spawn agent process");
    await fs.writeJson(pidFile, {pid: child.pid, startedAt: Date.now(), cmd: startCmd});
    return child.pid;
}

// run — pull if needed + create new container + start (like docker run)
agentCommand
    .command("run <name>")
    .description("Run an agent (pull if needed, create new container)")
    .action(async (nameArg: string) => {
        try {
            const [rawName, versionArg] = nameArg.split(":");
            const name = sanitizeName(rawName);

            let registry = await loadRegistry();
            if (!registry[name]) {
                console.log(`🔍 Agent '${sanitizeLog(name)}' not found locally, pulling...`);
                await pullAgent(name);
                registry = await loadRegistry();
            }

            const entry = registry[name];
            const version = versionArg ?? await getLatestLocalVersion(name);
            const versionEntry = entry.versions[version];
            if (!versionEntry) throw new Error(`Version '${sanitizeLog(version)}' not found for agent '${sanitizeLog(name)}'`);

            const agentDir = agentPath(name, version);
            const agentJson = path.join(agentDir, "agent.json");
            const agent = await fs.readJson(agentJson);

            const installCmd = agent.scripts?.install;
            if (installCmd) {
                validateCmd(installCmd);
                console.log("📦 Installing dependencies...");
                execSync(installCmd, {cwd: agentDir, stdio: "inherit"});
            }

            const startCmd = agent.scripts?.start;
            if (!startCmd) throw new Error("No start script defined in agent.json");
            validateCmd(startCmd);

            const containerId = generateId();
            await fs.ensureDir(resolveContainerPath(containerId));
            const pid = await spawnProcess(containerId, agentDir, startCmd);

            const containers = await loadContainers();
            containers[containerId] = {
                containerId,
                agentId: versionEntry.agentId,
                name,
                version,
                pid,
                startedAt: Date.now(),
                status: "running",
            };
            await saveContainers(containers);
            console.log(containerId);
        } catch (err: any) {
            console.error("❌ Run failed:", err.message);
            process.exit(1);
        }
    });

// start — start a stopped container
agentCommand
    .command("start <containerId>")
    .description("Start a stopped container")
    .action(async (rawId: string) => {
        try {
            const containerId = sanitizeName(rawId);
            const containers = await loadContainers();
            const container = containers[containerId];
            if (!container) throw new Error(`Container '${sanitizeLog(containerId)}' not found`);
            if (isProcessAlive(container.pid)) throw new Error(`Container '${sanitizeLog(containerId)}' is already running`);

            const agentDir = agentPath(container.name, container.version);
            const agentJson = path.join(agentDir, "agent.json");
            const agent = await fs.readJson(agentJson);
            const startCmd = agent.scripts?.start;
            if (!startCmd) throw new Error("No start script defined in agent.json");
            validateCmd(startCmd);

            await fs.remove(resolveContainerPath(containerId, "agent.pid")).catch(() => {});
            const pid = await spawnProcess(containerId, agentDir, startCmd);
            containers[containerId].pid = pid;
            containers[containerId].startedAt = Date.now();
            containers[containerId].status = "running";
            await saveContainers(containers);
            console.log(`✅ Container '${sanitizeLog(containerId)}' started (pid: ${pid})`);
        } catch (err: any) {
            console.error("❌ Start failed:", err.message);
            process.exit(1);
        }
    });

async function stopContainer(containerId: string): Promise<void> {
    const containers = await loadContainers();
    const container = containers[containerId];
    if (!container) throw new Error(`Container '${sanitizeLog(containerId)}' not found`);

    const containerDir = resolveContainerPath(containerId);
    const pidFile = path.join(containerDir, "agent.pid");

    // try stop script first
    const agentDir = agentPath(container.name, container.version);
    const agentJson = path.join(agentDir, "agent.json");
    if (await fs.pathExists(agentJson)) {
        const agent = await fs.readJson(agentJson);
        const stopCmd = agent.scripts?.stop;
        if (stopCmd) {
            validateCmd(stopCmd);
            const {bin, args} = parseCmd(stopCmd);
            spawnSync(bin, args, {cwd: agentDir, stdio: "inherit"});
            await fs.remove(pidFile).catch(() => {});
            containers[containerId].status = "stopped";
            await saveContainers(containers);
            console.log(`✅ Container '${sanitizeLog(containerId)}' stopped`);
            return;
        }
    }

    if (await fs.pathExists(pidFile)) {
        const pidData = await fs.readJson(pidFile);
        const pidRaw = pidData.pid;
        if (!Number.isFinite(pidRaw) || pidRaw <= 0) throw new Error("Invalid PID in agent.pid");
        try {
            process.kill(pidRaw, 0);
            const procStat = path.join("/proc", String(pidRaw), "stat");
            if (await fs.pathExists(procStat)) {
                const stat = await fs.readFile(procStat, "utf-8");
                const startTicks = parseInt(stat.split(" ")[21]);
                const bootStat = await fs.readFile("/proc/stat", "utf-8");
                const btime = parseInt(bootStat.split("\n").find(l => l.startsWith("btime"))!.split(" ")[1]);
                const procStartMs = (btime + startTicks / 100) * 1000;
                if (procStartMs > pidData.startedAt + 5000) throw new Error("PID reuse detected, refusing to kill");
            }
            process.kill(pidRaw);
        } catch (e: any) {
            if (e.code !== "ESRCH") throw e;
        }
    } else {
        // process already dead, just clean up
        await fs.remove(pidFile).catch(() => {});
    }

    await fs.remove(pidFile).catch(() => {});
    containers[containerId].status = "stopped";
    await saveContainers(containers);
    console.log(`✅ Container '${sanitizeLog(containerId)}' stopped`);
}

async function resolveContainerId(nameOrId: string, requireSingle = false): Promise<string> {
    const containers = await loadContainers();
    if (containers[nameOrId]) return nameOrId;
    const matches = Object.values(containers as Record<string, any>)
        .filter(c => c.name === nameOrId && isProcessAlive(c.pid));
    if (matches.length === 0) throw new Error(`No running container found for '${sanitizeLog(nameOrId)}'\nUse 'lifectl ai agent ps' to list containers.`);
    if (requireSingle && matches.length > 1) {
        const ids = matches.map(c => (c.containerId as string).slice(0, 12)).join(", ");
        throw new Error(`Multiple running containers found for '${sanitizeLog(nameOrId)}': ${ids}\nUse container id to specify which one.`);
    }
    return matches.sort((a, b) => b.startedAt - a.startedAt)[0].containerId;
}

// stop
agentCommand
    .command("stop <name>")
    .description("Stop a running container by name or container id")
    .action(async (nameArg: string) => {
        try {
            const containerId = await resolveContainerId(sanitizeName(nameArg), true);
            await stopContainer(containerId);
        } catch (err: any) {
            console.error("❌ Stop failed:", err.message);
            process.exit(1);
        }
    });

// restart
agentCommand
    .command("restart <name>")
    .description("Restart a container")
    .action(async (nameArg: string) => {
        try {
            const containerId = await resolveContainerId(sanitizeName(nameArg), true);
            await stopContainer(containerId);

            const containers = await loadContainers();
            const container = containers[containerId];
            const agentDir = agentPath(container.name, container.version);
            const agentJson = path.join(agentDir, "agent.json");
            const agent = await fs.readJson(agentJson);
            const startCmd = agent.scripts?.start;
            if (!startCmd) throw new Error("No start script defined in agent.json");
            validateCmd(startCmd);

            const pid = await spawnProcess(containerId, agentDir, startCmd);
            containers[containerId].pid = pid;
            containers[containerId].startedAt = Date.now();
            containers[containerId].status = "running";
            await saveContainers(containers);

            console.log(`✅ Container '${sanitizeLog(containerId)}' restarted (pid: ${pid})`);
        } catch (err: any) {
            console.error("❌ Restart failed:", err.message);
            process.exit(1);
        }
    });

// rma — remove a pulled agent (like docker rmi)
agentCommand
    .command("rma <name>")
    .description("Remove a pulled agent")
    .action(async (nameArg: string) => {
        try {
            const [rawName, versionArg] = nameArg.split(":");
            const name = sanitizeName(rawName);

            const registryFile = path.join(AGENTS_DIR, "registry.json");
            const registry = await loadRegistry();
            if (!registry[name]) throw new Error(`Agent '${sanitizeLog(name)}' not found`);

            const allContainers = await loadContainers();
            const running = Object.values(allContainers as Record<string, any>).filter(
                c => c.name === name && (!versionArg || c.version === versionArg) && isProcessAlive(c.pid)
            );
            if (running.length > 0) {
                const ids = running.map(c => (c.containerId as string).slice(0, 12)).join(", ");
                throw new Error(`Agent '${sanitizeLog(name)}' has running containers: ${ids}\nStop them first.`);
            }

            if (versionArg) {
                const version = sanitizeName(versionArg);
                if (!registry[name].versions[version]) throw new Error(`Version '${sanitizeLog(version)}' not found for agent '${sanitizeLog(name)}'`);
                await fs.remove(agentPath(name, version));
                delete registry[name].versions[version];
                if (Object.keys(registry[name].versions).length === 0) delete registry[name];
                console.log(`${sanitizeLog(name)}:${sanitizeLog(version)}`);
            } else {
                await fs.remove(agentPath(name));
                delete registry[name];
                console.log(sanitizeLog(name));
            }
            await fs.writeJson(registryFile, registry, {spaces: 2});

            // clean up stopped containers referencing this agent
            let changed = false;
            for (const [cid, c] of Object.entries(allContainers as Record<string, any>)) {
                if (c.name === name && (!versionArg || c.version === versionArg) && !isProcessAlive(c.pid)) {
                    await fs.remove(resolveContainerPath(cid)).catch(() => {});
                    delete allContainers[cid];
                    changed = true;
                }
            }
            if (changed) await saveContainers(allContainers);
        } catch (err: any) {
            console.error("❌ Remove agent failed:", err.message);
            process.exit(1);
        }
    });

// rm — remove a stopped container
agentCommand
    .command("rm <containerId>")
    .description("Remove a stopped container")
    .action(async (rawId: string) => {
        try {
            const containerId = sanitizeName(rawId);
            const containers = await loadContainers();
            const container = containers[containerId];
            if (!container) throw new Error(`Container '${sanitizeLog(containerId)}' not found`);
            if (isProcessAlive(container.pid)) throw new Error(`Container '${sanitizeLog(containerId)}' is running. Stop it first.`);
            await fs.remove(resolveContainerPath(containerId));
            delete containers[containerId];
            await saveContainers(containers);
            console.log(containerId);
        } catch (err: any) {
            console.error("❌ Remove failed:", err.message);
            process.exit(1);
        }
    });

// list — like docker image ls
agentCommand
    .command("list")
    .description("List pulled agents (like docker image ls)")
    .action(async () => {
        const registry = await loadRegistry();
        const entries = Object.values(registry) as any[];
        if (entries.length === 0) { console.log("No agents pulled."); return; }

        const formatDate = (ts: number) => {
            const d = new Date(ts);
            return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        };

        const rows = entries.flatMap((entry) =>
            Object.values(entry.versions ?? {}).map((v: any) => ({
                agentId: (v.agentId ?? "-").slice(0, 12),
                name: v.name ?? "-",
                version: v.version ?? "-",
                runtime: v.runtime ?? "-",
                pulledAt: formatDate(v.pulledAt),
            }))
        );

        const pad = (s: string, n: number) => s.padEnd(n);
        const w = {
            agentId: Math.max(8, ...rows.map(r => r.agentId.length)),
            name: Math.max(4, ...rows.map(r => r.name.length)),
            version: Math.max(7, ...rows.map(r => r.version.length)),
            runtime: Math.max(7, ...rows.map(r => r.runtime.length)),
        };

        console.log(`${pad("AGENT ID", w.agentId)}  ${pad("NAME", w.name)}  ${pad("VERSION", w.version)}  ${pad("RUNTIME", w.runtime)}  PULLED AT`);
        for (const r of rows) {
            console.log(`${pad(r.agentId, w.agentId)}  ${pad(r.name, w.name)}  ${pad(r.version, w.version)}  ${pad(r.runtime, w.runtime)}  ${r.pulledAt}`);
        }
    });

// ps — like docker ps
agentCommand
    .command("ps")
    .description("List running agent containers (like docker ps)")
    .action(async () => {
        const containers = await loadContainers();
        const all = Object.values(containers as Record<string, any>);
        if (all.length === 0) { console.log("No containers."); return; }

        const formatDate = (ts: number) => {
            const d = new Date(ts);
            return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        };

        const rows = all.map((c) => {
            const alive = Number.isFinite(c.pid) && c.pid > 0 && isProcessAlive(c.pid);
            return {
                containerId: (c.containerId ?? "-").slice(0, 12),
                agentId: (c.agentId ?? "-").slice(0, 12),
                name: c.name ?? "-",
                version: c.version ?? "-",
                status: alive ? "running" : "stopped",
                pid: String(c.pid ?? "-"),
                startedAt: formatDate(c.startedAt),
            };
        });

        const pad = (s: string, n: number) => s.padEnd(n);
        const w = {
            containerId: Math.max(12, ...rows.map(r => r.containerId.length)),
            agentId: Math.max(8, ...rows.map(r => r.agentId.length)),
            name: Math.max(4, ...rows.map(r => r.name.length)),
            version: Math.max(7, ...rows.map(r => r.version.length)),
            status: Math.max(6, ...rows.map(r => r.status.length)) + 2,
            pid: Math.max(3, ...rows.map(r => r.pid.length)),
        };

        console.log(`${pad("CONTAINER ID", w.containerId)}  ${pad("AGENT ID", w.agentId)}  ${pad("NAME", w.name)}  ${pad("VERSION", w.version)}  ${pad("STATUS", w.status)}  ${pad("PID", w.pid)}  STARTED AT`);
        for (const r of rows) {
            const statusLabel = r.status === "running" ? "🟢 running" : "⚫ stopped";
            console.log(`${pad(r.containerId, w.containerId)}  ${pad(r.agentId, w.agentId)}  ${pad(r.name, w.name)}  ${pad(r.version, w.version)}  ${pad(statusLabel, w.status)}  ${pad(r.pid, w.pid)}  ${r.startedAt}`);
        }
    });

// logs — by container id or name
agentCommand
    .command("logs <name>")
    .description("Show logs of a container")
    .option("-n, --lines <number>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log output")
    .action(async (nameArg: string, opts: { lines: string; follow?: boolean }) => {
        try {
            const containerId = await resolveContainerId(sanitizeName(nameArg), true);
            const logFile = resolveContainerPath(containerId, "agent.log");

            if (!await fs.pathExists(logFile)) {
                console.log(`No log file found for container '${sanitizeLog(containerId)}'`);
                return;
            }

            const lines = Math.max(1, parseInt(opts.lines) || 50);

            if (!opts.follow) {
                const logFiles = [logFile];
                for (let i = 1; i <= LOG_MAX_FILES; i++) {
                    const f = `${logFile}.${i}`;
                    if (await fs.pathExists(f)) logFiles.push(f);
                    else break;
                }
                let collected: string[] = [];
                for (const f of logFiles) {
                    if (collected.length >= lines) break;
                    const content = (await fs.readFile(f, "utf-8")).split("\n").filter(l => l);
                    collected = content.concat(collected);
                }
                console.log(collected.slice(-lines).join("\n") || "(empty log)");
                return;
            }

            const CHUNK = 65536;
            let lastSize = (await fs.stat(logFile)).size;
            let pos = lastSize;
            let collectedStr = "";
            let lineCount = 0;
            const fd = await fs.open(logFile, "r");
            try {
                while (pos > 0 && lineCount <= lines) {
                    const readSize = Math.min(CHUNK, pos);
                    pos -= readSize;
                    const buf = Buffer.alloc(readSize);
                    await fs.read(fd, buf, 0, readSize, pos);
                    collectedStr = buf.toString("utf-8") + collectedStr;
                    lineCount = collectedStr.split("\n").length - 1;
                }
            } finally {
                await fs.close(fd);
            }
            const tailLines = collectedStr.split("\n").slice(-lines - 1).join("\n").trimStart();
            if (tailLines) process.stdout.write(tailLines + "\n");

            const watcher = chokidar.watch(logFile, {usePolling: false, persistent: true});
            watcher.on("change", async () => {
                try {
                    const size = (await fs.stat(logFile)).size;
                    if (size > lastSize) {
                        const rfd = await fs.open(logFile, "r");
                        const buf = Buffer.alloc(size - lastSize);
                        await fs.read(rfd, buf, 0, buf.length, lastSize);
                        await fs.close(rfd);
                        process.stdout.write(buf.toString("utf-8"));
                        lastSize = size;
                    }
                } catch { watcher.close(); }
            });
            process.on("SIGINT", () => { watcher.close(); process.exit(0); });
        } catch (err: any) {
            console.error("❌ Log failed:", err.message);
            process.exit(1);
        }
    });

aiCommand.addCommand(agentCommand);
