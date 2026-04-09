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

const AGENTS_DIR = path.join(os.homedir(), ".lifectl", "agents");

const ALLOWED_RUNTIMES = new Set(["node", "python", "python3", "deno", "bun", "npx", "ts-node", "tsx"]);

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
            if (current) {
                tokens.push(current);
                current = "";
            }
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
    if (!resolved.startsWith(path.resolve(AGENTS_DIR))) {
        throw new Error(`Path traversal detected for agent name: '${name}'`);
    }
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
            if (!await fs.pathExists(agentJson)) {
                throw new Error("agent.json not found");
            }

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
            if (!data.success) {
                throw new Error(data.message ?? "Push rejected by server");
            }

            console.log(`✅ Pushed ${sanitizeLog(agent.name)}@${sanitizeLog(agent.version)}`);
        } catch (err: any) {
            console.error("❌ Push failed:", err.message);
            process.exit(1);
        } finally {
            await fs.remove(zipPath);
        }
    });

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
    if (await fs.pathExists(registryFile)) {
        return await fs.readJson(registryFile);
    }
    // fallback: rebuild from agent.json in each folder
    const registry: Record<string, any> = {};
    if (!await fs.pathExists(AGENTS_DIR)) return registry;
    for (const rawAgentName of await fs.readdir(AGENTS_DIR)) {
        let agentName: string;
        try {
            agentName = sanitizeName(rawAgentName);
        } catch {
            continue;
        }
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
            registry[agentName].versions[ver] = {
                name: agent.name ?? agentName,
                version: agent.version ?? ver,
                description: agent.description ?? "",
                runtime: agent.runtime ?? "",
                installed: false,
                pulledAt: Date.now(),
            };
        }
    }
    await fs.writeJson(registryFile, registry, {spaces: 2});
    return registry;
}

// pull
agentCommand
    .command("pull <name>")
    .description("Pull agent from registry")
    .action(async (rawName: string) => {
        const name = sanitizeName(rawName);
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
            registry[name].versions[agentVersion] = {
                name: agent.name ?? name,
                version: agent.version ?? agentVersion,
                description: agent.description ?? "",
                runtime: agent.runtime ?? "",
                installed: false,
                pulledAt: Date.now(),
            };
            await fs.writeJson(registryFile, registry, {spaces: 2});

            console.log(`✅ Pulled ${sanitizeLog(name)}@${sanitizeLog(agentVersion)}`);
        } catch (err: any) {
            console.error("❌ Pull failed:", err.message);
            process.exit(1);
        } finally {
            await fs.remove(tmpFile);
        }
    });

async function startAgent(name: string, version: string): Promise<void> {
    const registry = await loadRegistry();
    const entry = registry[name];
    if (!entry) throw new Error(`Agent '${sanitizeLog(name)}' not found. Run: lifectl ai agent pull ${sanitizeLog(name)}`);
    const agentDir = agentPath(name, version);
    if (!await fs.pathExists(agentDir)) throw new Error(`Agent '${sanitizeLog(name)}:${sanitizeLog(version)}' not found. Run: lifectl ai agent pull ${sanitizeLog(name)}`);

    const pidFile = path.join(agentDir, "agent.pid");
    if (await fs.pathExists(pidFile)) {
        const pidData = await fs.readJson(pidFile).catch(() => null);
        const existingPid = pidData?.pid;
        if (Number.isFinite(existingPid) && existingPid > 0) {
            try { process.kill(existingPid, 0); } catch { await fs.remove(pidFile); }
        }
        if (await fs.pathExists(pidFile)) throw new Error(`Agent '${sanitizeLog(name)}:${sanitizeLog(version)}' is already running. Stop it first.`);
    }

    const agentJson = path.join(agentDir, "agent.json");
    const agent = await fs.readJson(agentJson);
    const registryFile = path.join(AGENTS_DIR, "registry.json");
    const installCmd = agent.scripts?.install;
    if (!installCmd) {
        registry[name].versions[version].installed = true;
        await fs.writeJson(registryFile, registry, {spaces: 2});
    } else {
        const versionEntry = entry.versions?.[version];
        if (!versionEntry?.installed) {
            validateCmd(installCmd);
            console.log("📦 Installing dependencies...");
            execSync(installCmd, {cwd: agentDir, stdio: "inherit"});
            registry[name].versions[version].installed = true;
            await fs.writeJson(registryFile, registry, {spaces: 2});
        }
    }

    const startCmd = agent.scripts?.start;
    if (!startCmd) throw new Error("No start script defined in agent.json");
    validateCmd(startCmd);

    const logFile = path.join(agentDir, "agent.log");
    const logFd = fs.openSync(logFile, "a");
    const {bin: cmd, args} = parseCmd(startCmd);
    const child = spawn(cmd, args, {cwd: agentDir, detached: true, stdio: ["ignore", logFd, logFd]});
    fs.closeSync(logFd);
    child.unref();

    if (child.pid == null) throw new Error("Failed to spawn agent process");
    await fs.writeJson(pidFile, {pid: child.pid, startedAt: Date.now(), cmd: startCmd});
    console.log(`✅ Agent '${sanitizeLog(name)}:${sanitizeLog(version)}' started (pid: ${child.pid})`);
    console.log(`📄 Log: ${logFile}`);
}

async function stopAgent(name: string, version: string): Promise<void> {
    const registry = await loadRegistry();
    if (!registry[name]) throw new Error(`Agent '${sanitizeLog(name)}' not found`);
    const agentDir = agentPath(name, version);
    if (!await fs.pathExists(agentDir)) throw new Error(`Agent '${sanitizeLog(name)}@${sanitizeLog(version)}' not found`);
    const agentJson = path.join(agentDir, "agent.json");
    if (!await fs.pathExists(agentJson)) throw new Error(`agent.json not found for '${sanitizeLog(name)}@${sanitizeLog(version)}'`);

    const agent = await fs.readJson(agentJson);
    const pidFile = path.join(agentDir, "agent.pid");
    const stopCmd = agent.scripts?.stop;

    if (stopCmd) {
        validateCmd(stopCmd);
        const {bin: stopBin, args: stopArgs} = parseCmd(stopCmd);
        spawnSync(stopBin, stopArgs, {cwd: agentDir, stdio: "inherit"});
    } else if (await fs.pathExists(pidFile)) {
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
        throw new Error(`Agent '${sanitizeLog(name)}@${sanitizeLog(version)}' is not running`);
    }

    await fs.remove(pidFile).catch(() => {});
    console.log(`✅ Agent '${sanitizeLog(name)}@${sanitizeLog(version)}' stopped`);
}

// start
agentCommand
    .command("start <name>")
    .description("Start an agent")
    .action(async (nameArg: string) => {
        try {
            const [rawName, versionArg] = nameArg.split(":");
            const name = sanitizeName(rawName);
            const version = versionArg ?? await getLatestLocalVersion(name);
            await startAgent(name, version);
        } catch (err: any) {
            console.error("❌ Start failed:", err.message);
            process.exit(1);
        }
    });

// stop
agentCommand
    .command("stop <name>")
    .description("Stop an agent")
    .action(async (nameArg: string) => {
        try {
            const [rawName, versionArg] = nameArg.split(":");
            const name = sanitizeName(rawName);
            const version = versionArg ?? await getLatestLocalVersion(name);
            await stopAgent(name, version);
        } catch (err: any) {
            console.error("❌ Stop failed:", err.message);
            process.exit(1);
        }
    });

// restart
agentCommand
    .command("restart <name>")
    .description("Restart an agent")
    .action(async (nameArg: string) => {
        try {
            const [rawName, versionArg] = nameArg.split(":");
            const name = sanitizeName(rawName);
            const version = versionArg ?? await getLatestLocalVersion(name);
            await stopAgent(name, version);
            await startAgent(name, version);
        } catch (err: any) {
            console.error("❌ Restart failed:", err.message);
            process.exit(1);
        }
    });

// list
agentCommand
    .command("list")
    .description("List installed agents")
    .action(async () => {
        const registry = await loadRegistry();
        const entries = Object.values(registry) as any[];
        if (entries.length === 0) {
            console.log("No agents installed.");
            return;
        }

        const formatDate = (ts: number) => {
            const d = new Date(ts);
            const dd = String(d.getDate()).padStart(2, "0");
            const mm = String(d.getMonth() + 1).padStart(2, "0");
            const yyyy = d.getFullYear();
            const hh = String(d.getHours()).padStart(2, "0");
            const min = String(d.getMinutes()).padStart(2, "0");
            return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
        };

        const rows = await Promise.all(entries.flatMap((entry) => {
            const versions = Object.values(entry.versions ?? {}) as any[];
            return versions.map(async (v) => {
                let status = "stopped";
                try {
                    const pidFile = agentPath(v.name, v.version, "agent.pid");
                    if (await fs.pathExists(pidFile)) {
                        const pidData = await fs.readJson(pidFile).catch(() => null);
                        const pid = pidData?.pid;
                        if (Number.isFinite(pid) && pid > 0) {
                            try {
                                process.kill(pid, 0);
                                status = "running";
                            } catch {
                                await fs.remove(pidFile);
                            }
                        }
                    }
                } catch { /* invalid name, skip */
                }
                return {
                    status,
                    name: v.name ?? "-",
                    version: v.version ?? "-",
                    runtime: v.runtime ?? "-",
                    installed: v.installed ? "yes" : "no",
                    pulledAt: formatDate(v.pulledAt),
                };
            });
        }));

        const pad = (s: string, n: number) => s.padEnd(n);
        const w = {
            status: Math.max(6, ...rows.map(r => r.status.length)) + 2, // +2 for emoji
            name: Math.max(4, ...rows.map(r => r.name.length)),
            version: Math.max(7, ...rows.map(r => r.version.length)),
            runtime: Math.max(7, ...rows.map(r => r.runtime.length)),
            installed: Math.max(9, ...rows.map(r => r.installed.length)),
        };

        console.log(`${pad("STATUS", w.status)}  ${pad("NAME", w.name)}  ${pad("VERSION", w.version)}  ${pad("RUNTIME", w.runtime)}  ${pad("INSTALLED", w.installed)}  PULLED AT`);
        for (const r of rows) {
            const statusLabel = r.status === "running" ? "🟢 running" : "⚫ stopped";
            console.log(`${pad(statusLabel, w.status)}  ${pad(r.name, w.name)}  ${pad(r.version, w.version)}  ${pad(r.runtime, w.runtime)}  ${pad(r.installed, w.installed)}  ${r.pulledAt}`);
        }
    });

// log
agentCommand
    .command("log <name>")
    .description("Show logs of an agent")
    .option("-n, --lines <number>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log output")
    .action(async (nameArg: string, opts: { lines: string; follow?: boolean }) => {
        try {
            const [rawName, versionArg] = nameArg.split(":");
            const name = sanitizeName(rawName);
            const registry = await loadRegistry();
            if (!registry[name]) throw new Error(`Agent '${sanitizeLog(name)}' not found`);
            const version = versionArg ?? await getLatestLocalVersion(name);
            const agentDir = agentPath(name, version);
            const logFile = path.join(agentDir, "agent.log");

            if (!await fs.pathExists(logFile)) {
                console.log(`No log file found for '${sanitizeLog(name)}:${sanitizeLog(version)}'`);
                return;
            }

            const lines = Math.max(1, parseInt(opts.lines) || 50);

            if (opts.follow) {
                // read last N lines from end without loading entire file
                const CHUNK = 65536;
                let lastSize = (await fs.stat(logFile)).size;
                let pos = lastSize;
                let collected = "";
                let lineCount = 0;
                const fd = await fs.open(logFile, "r");
                try {
                    while (pos > 0 && lineCount <= lines) {
                        const readSize = Math.min(CHUNK, pos);
                        pos -= readSize;
                        const buf = Buffer.alloc(readSize);
                        await fs.read(fd, buf, 0, readSize, pos);
                        collected = buf.toString("utf-8") + collected;
                        lineCount = collected.split("\n").length - 1;
                    }
                } finally {
                    await fs.close(fd);
                }
                const tailLines = collected.split("\n").slice(-lines - 1).join("\n").trimStart();
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
                return;
            }

            const content = (await fs.readFile(logFile, "utf-8")).split("\n");
            const output = content.slice(-lines - 1).join("\n").trimEnd();
            console.log(output || "(empty log)");
        } catch (err: any) {
            console.error("❌ Log failed:", err.message);
            process.exit(1);
        }
    });

aiCommand.addCommand(agentCommand);
