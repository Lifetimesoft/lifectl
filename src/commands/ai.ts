import {Command} from "commander";
import {execSync, spawn} from "child_process";
import fs from "fs-extra";
import path from "path";
import os from "os";
import * as tar from "tar";
import semver from "semver";
import {apiAi} from "../utils/api-ai.js";
import {minimatch} from "minimatch";
import crypto from "crypto";
import {getConfig} from "../utils/config.js";

const AGENTS_DIR = path.join(os.homedir(), ".lifectl", "agents");
const CONTAINERS_DIR = path.join(os.homedir(), ".lifectl", "containers");

const CONTAINER_ID_BYTES = 6;
const CONTAINER_ID_REGEX = /^[a-f0-9]{12}$/; // CONTAINER_ID_BYTES * 2

/**
 * Detect the package manager to use for installing dependencies.
 * Priority: bun > pnpm > yarn > npm (fallback)
 * Handles repos that have multiple lock files (e.g. yarn.lock + package-lock.json).
 */
async function detectPackageManager(agentDir: string): Promise<{ bin: string; args: string[] }> {
    if (await fs.pathExists(path.join(agentDir, "bun.lockb"))) return { bin: "bun", args: ["install"] };
    if (await fs.pathExists(path.join(agentDir, "pnpm-lock.yaml"))) return { bin: "pnpm", args: ["install"] };
    if (await fs.pathExists(path.join(agentDir, "yarn.lock"))) return { bin: "yarn", args: ["install"] };
    if (await fs.pathExists(path.join(agentDir, "package-lock.json"))) return { bin: "npm", args: ["install"] };
    return { bin: "npm", args: ["install"] }; // fallback
}

function generateId(): string {
    return crypto.randomBytes(CONTAINER_ID_BYTES).toString("hex");
}

function sanitizeName(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9\-_.\/]/g, "");
    if (safe.includes("..") || safe.startsWith("/") || safe.endsWith("/") || safe.includes("//")) throw new Error(`Invalid agent name: '${name}'`);
    return safe;
}

function sanitizeContainerId(id: string): string {
    if (!CONTAINER_ID_REGEX.test(id)) throw new Error(`Invalid container id: '${id}'`);
    return id;
}

function sanitizeLog(s: string): string {
    return String(s).replace(/[\r\n]/g, " ");
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
    await tar.create(
        {
            gzip: true,
            file: outPath,
            cwd: sourceDir,
            filter: (filePath) => {
                const rel = filePath.replace(/\\/g, "/");
                return !ignorePatterns.some(p => minimatch(rel, p, {matchBase: true, dot: true}));
            },
        },
        ["."],
    );
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
            const stableId = crypto.createHash("sha256").update(`${agentName}@${ver}`).digest("hex").slice(0, 12);
            const agentJsonStat = await fs.stat(agentJson).catch(() => null);
            registry[agentName].versions[ver] = {
                agentId: stableId,
                name: agent.name ?? agentName,
                version: agent.version ?? ver,
                description: agent.description ?? "",
                runtime: agent.runtime ?? "",
                pulledAt: agentJsonStat ? agentJsonStat.mtimeMs : Date.now(),
            };
        }
    }
    await fs.writeJson(registryFile, registry, {spaces: 2});
    return registry;
}

async function pullAgent(name: string, version?: string): Promise<void> {
    const tmpFile = path.join(os.tmpdir(), `agent-${Date.now()}.tar.gz`);
    try {
        // ── Check agent exists and is compatible with node host ──
        const infoQuery = version
            ? `/agents/info?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}&host=node`
            : `/agents/info?name=${encodeURIComponent(name)}&host=node`;
        const infoRes = await apiAi.get(infoQuery);
        const info = infoRes.data;

        if (!info.success) {
            throw new Error(info.message ?? `Agent "${sanitizeLog(name)}" not found`);
        }
        if (info.compatible === false) {
            throw new Error(
                `Agent "${sanitizeLog(name)}" is not compatible with this host. ` +
                `Missing capabilities: ${(info.missing as string[]).join(", ")}.`
            );
        }

        const payload: any = {name};
        if (version) {
            payload.version = version;
        }
        const response = await apiAi.post("/agents/pull", payload, {responseType: "arraybuffer"});
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
        const agentId = crypto.createHash("sha256").update(`${name}@${agentVersion}`).digest("hex").slice(0, 12);
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

// Serialise all containers.json writes to prevent race conditions
let _containersWriteQueue: Promise<void> = Promise.resolve();

async function loadContainers(): Promise<Record<string, any>> {
    await _containersWriteQueue; // wait for any pending write before reading
    const containersFile = path.join(CONTAINERS_DIR, "containers.json");
    if (await fs.pathExists(containersFile)) return await fs.readJson(containersFile);
    return {};
}

async function saveContainers(containers: Record<string, any>): Promise<void> {
    // catch() prevents a failed write from poisoning the entire queue chain
    _containersWriteQueue = _containersWriteQueue.catch(() => {}).then(async () => {
        await fs.ensureDir(CONTAINERS_DIR);
        const containersFile = path.join(CONTAINERS_DIR, "containers.json");
        const tmp = containersFile + ".tmp";
        await fs.writeJson(tmp, containers, {spaces: 2});
        await fs.move(tmp, containersFile, {overwrite: true});
    });
    await _containersWriteQueue;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
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
    .description("Pull agent from registry (supports name or name:version)")
    .action(async (rawName: string) => {
        try {
            const [name, version] = rawName.split(":");
            await pullAgent(sanitizeName(name), version ? sanitizeName(version) : undefined);
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
    await fs.remove(`${logFile}.${LOG_MAX_FILES}`).catch(() => {});
    for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
        const src = `${logFile}.${i}`;
        const dst = `${logFile}.${i + 1}`;
        if (await fs.pathExists(src)) await fs.move(src, dst, {overwrite: true});
    }
    await fs.move(logFile, `${logFile}.1`, {overwrite: true});
}

/**
 * On Windows, npm bin wrappers are .cmd files that cannot be spawned with detached:true.
 * This resolves the actual JS file the .cmd points to so we can invoke it with node directly.
 * Reads the target package's package.json "bin" field to find the JS entrypoint.
 */
function resolveNodeBinScript(cmdPath: string, agentDir: string): string | null {
    try {
        // e.g. cmdPath = ".../.bin/agent-runtime.cmd"  →  binName = "agent-runtime"
        const binName = path.basename(cmdPath).replace(/\.cmd$/i, "");
        const nmDir = path.join(agentDir, "node_modules");

        // collect all package dirs to check (flat + scoped)
        const pkgDirs: string[] = [];
        for (const entry of fs.readdirSync(nmDir)) {
            if (entry.startsWith(".")) continue;
            const full = path.join(nmDir, entry);
            if (entry.startsWith("@")) {
                // scoped scope dir — add each package inside it
                try {
                    for (const scoped of fs.readdirSync(full)) {
                        pkgDirs.push(path.join(full, scoped));
                    }
                } catch { /* skip */ }
            } else {
                pkgDirs.push(full);
            }
        }

        for (const pkgDir of pkgDirs) {
            const pkgJson = path.join(pkgDir, "package.json");
            if (!fs.existsSync(pkgJson)) continue;
            let pkg: any;
            try { pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8")); } catch { continue; }
            const binField = pkg.bin;
            if (!binField) continue;
            const binValue: string | undefined =
                typeof binField === "string" ? binField : binField[binName];
            if (!binValue) continue;
            const jsPath = path.resolve(pkgDir, binValue);
            if (fs.existsSync(jsPath)) return jsPath;
        }
        return null;
    } catch {
        return null;
    }
}

async function spawnProcess(containerId: string, agentDir: string, startCmd: string, env?: Record<string, string>): Promise<number> {
    const containerDir = resolveContainerPath(containerId);
    const logFile = path.join(containerDir, "agent.log");
    const pidFile = path.join(containerDir, "agent.pid");
    await rotateLog(logFile);
    const logFd = fs.openSync(logFile, "a");
    let child;
    try {
        let bin: string;
        let args: string[];
        if (process.platform === "win32" && (startCmd.endsWith(".cmd") || startCmd.endsWith(".CMD"))) {
            // On Windows, .cmd files cannot be spawned with detached:true directly.
            // Resolve the actual JS entrypoint from the bin field in the package's package.json
            // and invoke it with node instead.
            const resolvedJs = resolveNodeBinScript(startCmd, agentDir);
            if (resolvedJs) {
                bin = process.execPath; // node
                args = [resolvedJs];
            } else {
                // fallback: use cmd.exe /c (won't be truly detached but won't EINVAL)
                bin = process.env.ComSpec ?? "cmd.exe";
                args = ["/c", startCmd];
            }
        } else {
            const parsed = parseCmd(startCmd);
            bin = parsed.bin;
            args = parsed.args;
        }
        child = spawn(bin, args, {
            cwd: agentDir,
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: {...process.env, ...env},
        });
    } finally {
        fs.closeSync(logFd);
    }
    if (child.pid == null) throw new Error("Failed to spawn agent process");

    // wait a tick to catch immediate spawn errors (e.g. binary not found)
    // before unref-ing the process
    await new Promise<void>((resolve, reject) => {
        child.once("error", (err) => reject(new Error(`Failed to start process: ${err.message}`)));
        // setImmediate gives the event loop one turn to fire the error event if it's coming
        setImmediate(resolve);
    });

    child.unref();
    await fs.writeJson(pidFile, {pid: child.pid, startedAt: Date.now(), cmd: startCmd});
    return child.pid;
}

// run — pull if needed + create new container + start (like docker run)
agentCommand
    .command("run <name>")
    .description("Run an agent (pull if needed, create new container)")
    .option("--name <alias>", "Assign a name to the container")
    .action(async (nameArg: string, opts: { name?: string }) => {
        try {
            // resolve agent ID → name[:version] if argument looks like an ID (12-char hex)
            let resolvedArg = nameArg
            if (/^[a-f0-9]{12}$/.test(nameArg)) {
                const registry = await loadRegistry()
                let found: { name: string; version: string } | null = null
                for (const [agentName, entry] of Object.entries(registry as Record<string, any>)) {
                    for (const [ver, info] of Object.entries(entry.versions ?? {} as Record<string, any>)) {
                        if ((info as any).agentId === nameArg) { found = { name: agentName, version: ver }; break }
                    }
                    if (found) break
                }
                if (!found) throw new Error(`Agent '${sanitizeLog(nameArg)}' not found`)
                resolvedArg = `${found.name}:${found.version}`
            }

            const [rawName, versionArg] = resolvedArg.split(":");
            const name = sanitizeName(rawName);
            const alias = opts.name ? sanitizeName(opts.name) : undefined;

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

            // require package.json — agent must use @lifetimesoft/agent-sdk
            const pkgJsonPath = path.join(agentDir, "package.json");
            if (!await fs.pathExists(pkgJsonPath)) {
                throw new Error("Agent must have a package.json with @lifetimesoft/agent-sdk as a dependency.");
            }

            // install dependencies if not yet installed
            if (!versionEntry.installedAt) {
                const lockFile = path.join(agentDir, ".install.lock");
                let lockFd: number | null = null;
                try {
                    lockFd = await fs.open(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
                } catch {
                    console.log("⏳ Another instance is installing dependencies, waiting...");
                    while (await fs.pathExists(lockFile)) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                    const freshRegistry = await loadRegistry();
                    if (!freshRegistry[name]?.versions[version]?.installedAt) {
                        throw new Error("Install lock released but installedAt not set — install may have failed");
                    }
                    lockFd = null;
                }
                if (lockFd !== null) {
                    try {
                        const pm = await detectPackageManager(agentDir);
                        console.log(`📦 Installing dependencies with ${pm.bin}...`);
                        execSync(`${pm.bin} ${pm.args.join(" ")}`, {cwd: agentDir, stdio: "inherit", timeout: 5 * 60 * 1000});
                        const registryFile = path.join(AGENTS_DIR, "registry.json");
                        const reg = await loadRegistry();
                        reg[name].versions[version].installedAt = Date.now();
                        await fs.writeJson(registryFile, reg, {spaces: 2});
                    } finally {
                        await fs.close(lockFd);
                        await fs.remove(lockFile).catch(() => {});
                    }
                }
            }

            // build if not yet built (only when package.json has a "build" script)
            if (!versionEntry.builtAt) {
                const pkg = await fs.readJson(pkgJsonPath);
                if (pkg?.scripts?.build) {
                    const pm = await detectPackageManager(agentDir);
                    const buildCmd = pm.bin === "npm" ? "npm run build"
                        : pm.bin === "bun"  ? "bun run build"
                        : pm.bin === "pnpm" ? "pnpm run build"
                        : "yarn build";
                    console.log(`🔨 Building agent with: ${buildCmd}`);
                    execSync(buildCmd, {cwd: agentDir, stdio: "inherit", timeout: 5 * 60 * 1000});
                    const registryFile = path.join(AGENTS_DIR, "registry.json");
                    const reg = await loadRegistry();
                    reg[name].versions[version].builtAt = Date.now();
                    await fs.writeJson(registryFile, reg, {spaces: 2});
                }
            }

            // resolve agent-runtime from the agent's local node_modules/.bin so it works
            // without the binary being globally installed on the host PATH
            const localBin = path.join(agentDir, "node_modules", ".bin", process.platform === "win32" ? "agent-runtime.cmd" : "agent-runtime");
            const localBinExists = await fs.pathExists(localBin);
            const startCmd = localBinExists ? localBin : "agent-runtime";

            const containerId = generateId();
            const containerDir = resolveContainerPath(containerId);
            await fs.ensureDir(containerDir);
            try {
                // call SaaS to register run and get ctx + config
                console.log("🔗 Registering agent run with SaaS...");
                const runRes = await apiAi.post("/agents/run", {
                    agent_name: name,
                    agent_version: version,
                    container_id: containerId,
                    hostname: os.hostname(),
                    alias: alias ?? null,
                });
                const runData = runRes.data;
                if (!runData.success) throw new Error(runData.message ?? "Failed to register agent run");

                const { ctx } = runData;
                const run_id: string = ctx.meta.run_id;

                // spawn agent using its own startCmd — each agent language/runtime uses its own command
                // AGENT_CTX contains meta.runtime with heartbeat URLs from SaaS
                // heartbeat is managed inside the agent process (via agent-sdk/runtime or equivalent)
                const cfg = await getConfig();
                const agentEnv: Record<string, string> = {
                    AGENT_RUN_ID: run_id,
                    AGENT_NAME: name,
                    AGENT_VERSION: version,
                    AGENT_CTX: JSON.stringify(ctx),
                    AGENT_ACCESS_TOKEN: cfg?.access_token ?? "",
                    AGENT_REFRESH_TOKEN: cfg?.refresh_token ?? "",
                };

                const pid = await spawnProcess(containerId, agentDir, startCmd, agentEnv);

                // parse instance_id from run_id (format: run_{userId}_{instanceId}_{container_id})
                const instance_id = parseInt(run_id.split("_")[2], 10);

                const containers = await loadContainers();
                if (alias && Object.values(containers as Record<string, any>).some(c => c.alias === alias)) {
                    throw new Error(`Container name '${sanitizeLog(alias)}' is already in use`);
                }
                containers[containerId] = {
                    containerId,
                    agentId: versionEntry.agentId,
                    name,
                    ...(alias ? {alias} : {}),
                    version,
                    pid,
                    startedAt: Date.now(),
                    status: "running",
                    run_id,
                    instance_id,
                };
                await saveContainers(containers);

                console.log(containerId);
            } catch (err) {
                await fs.remove(containerDir).catch(() => {});
                throw err;
            }
        } catch (err: any) {
            console.error("❌ Run failed:", err.message);
            process.exit(1);
        }
    });

// start — start a stopped container
agentCommand
    .command("start <containerId>")
    .description("Start a stopped container (accepts container ID, alias, or agent name)")
    .action(async (rawId: string) => {
        try {
            const containerId = await resolveStoppedContainerId(rawId.trim(), true);
            const containers = await loadContainers();
            const container = containers[containerId];

            const agentDir = agentPath(container.name, container.version);

            // reuse existing instance row — call /restart instead of /run
            // instance_id may not exist in older containers.json — parse from run_id as fallback
            const instance_id_start = container.instance_id ?? parseInt((container.run_id ?? "").split("_")[2], 10);
            if (!instance_id_start || !Number.isFinite(instance_id_start)) throw new Error("Cannot determine instance_id — try running a new container with 'lifectl ai agent run'");

            console.log("🔗 Registering agent restart with SaaS...");
            const runRes = await apiAi.post("/agents/restart", {
                instance_id: instance_id_start,
                container_id: containerId,
                hostname: os.hostname(),
            });
            const runData = runRes.data;
            if (!runData.success) {
                if (runData.expired) {
                    throw new Error(`Instance has expired after inactivity.\nRun 'lifectl ai agent run ${sanitizeLog(container.name)}' to create a new instance.`);
                }
                throw new Error(runData.message ?? "Failed to register agent restart");
            }

            const { ctx } = runData;
            const run_id: string = ctx.meta.run_id;
            const cfg = await getConfig();
            const agentEnv: Record<string, string> = {
                AGENT_RUN_ID: run_id,
                AGENT_NAME: container.name,
                AGENT_VERSION: container.version,
                AGENT_CTX: JSON.stringify(ctx),
                AGENT_ACCESS_TOKEN: cfg?.access_token ?? "",
                AGENT_REFRESH_TOKEN: cfg?.refresh_token ?? "",
            };

            await fs.remove(resolveContainerPath(containerId, "agent.pid")).catch(() => {});
            const localBinStart = path.join(agentDir, "node_modules", ".bin", process.platform === "win32" ? "agent-runtime.cmd" : "agent-runtime");
            const startCmdStart = await fs.pathExists(localBinStart) ? localBinStart : "agent-runtime";
            const pid = await spawnProcess(containerId, agentDir, startCmdStart, agentEnv);
            containers[containerId].pid = pid;
            containers[containerId].startedAt = Date.now();
            containers[containerId].status = "running";
            containers[containerId].run_id = run_id;
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

    if (await fs.pathExists(pidFile)) {
        const pidData = await fs.readJson(pidFile);
        const pidRaw = pidData.pid;
        if (!Number.isFinite(pidRaw) || pidRaw <= 0) throw new Error("Invalid PID in agent.pid");
        try {
            process.kill(pidRaw, 0);
            if (process.platform === "linux") {
                const procStat = path.join("/proc", String(pidRaw), "stat");
                if (await fs.pathExists(procStat)) {
                    const stat = await fs.readFile(procStat, "utf-8");
                    const startTicks = parseInt(stat.split(" ")[21]);
                    const bootStat = await fs.readFile("/proc/stat", "utf-8");
                    const btime = parseInt(bootStat.split("\n").find(l => l.startsWith("btime"))!.split(" ")[1]);
                    const procStartMs = (btime + startTicks / 100) * 1000;
                    if (procStartMs > pidData.startedAt + 5000) throw new Error("PID reuse detected, refusing to kill");
                }
            }
            process.kill(pidRaw);
        } catch (e: any) {
            if (e.code !== "ESRCH") throw e;
        }
    } else {
        // process already dead, just clean up
        await fs.remove(pidFile).catch(() => {
        });
    }

    await fs.remove(pidFile).catch(() => {
    });
    containers[containerId].status = "stopped";
    await saveContainers(containers);

    // notify server — lifectl is responsible for this on platforms where SIGTERM
    // handlers may not run (e.g. Windows), and as a reliable fallback on all platforms
    const run_id = container.run_id;
    if (run_id) {
        try {
            await apiAi.post("/agents/stopped", { run_id, last_error: null });
        } catch {
            // best-effort — server will eventually mark offline via heartbeat timeout
        }
    }

    console.log(`✅ Container '${sanitizeLog(containerId)}' stopped`);
}

async function resolveContainerId(nameOrId: string, requireSingle = false): Promise<string> {
    const containers = await loadContainers();
    // try exact container id match first (validate format), then fall back to name lookup
    let isId = false;
    try { sanitizeContainerId(nameOrId); isId = true; } catch { /* not an id format */ }
    if (isId && containers[nameOrId]) return nameOrId;
    const matches = Object.values(containers as Record<string, any>)
        .filter(c => (c.alias === nameOrId || c.name === nameOrId) && isProcessAlive(c.pid));
    if (matches.length === 0) throw new Error(`No running container found for '${sanitizeLog(nameOrId)}'\nUse 'lifectl ai agent ps' to list containers.`);
    if (requireSingle && matches.length > 1) {
        const ids = matches.map(c => (c.containerId as string).slice(0, 12)).join(", ");
        throw new Error(`Multiple running containers found for '${sanitizeLog(nameOrId)}': ${ids}\nUse container id to specify which one.`);
    }
    return matches.sort((a, b) => b.startedAt - a.startedAt)[0].containerId;
}

async function resolveStoppedContainerId(nameOrId: string, requireSingle = false): Promise<string> {
    const containers = await loadContainers();
    // try exact container id match first (validate format), then fall back to name lookup
    let isId = false;
    try { sanitizeContainerId(nameOrId); isId = true; } catch { /* not an id format */ }
    if (isId && containers[nameOrId]) return nameOrId;
    const matches = Object.values(containers as Record<string, any>)
        .filter(c => (c.alias === nameOrId || c.name === nameOrId) && !isProcessAlive(c.pid));
    if (matches.length === 0) throw new Error(`No stopped container found for '${sanitizeLog(nameOrId)}'\nUse 'lifectl ai agent ps' to list containers.`);
    if (requireSingle && matches.length > 1) {
        const ids = matches.map(c => (c.containerId as string).slice(0, 12)).join(", ");
        throw new Error(`Multiple stopped containers found for '${sanitizeLog(nameOrId)}': ${ids}\nUse container id to specify which one.`);
    }
    return matches.sort((a, b) => b.startedAt - a.startedAt)[0].containerId;
}

// stop
agentCommand
    .command("stop <name>")
    .description("Stop a running container by name or container id")
    .action(async (nameArg: string) => {
        try {
            const containerId = await resolveContainerId(nameArg.trim(), true);
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
            const containerId = await resolveContainerId(nameArg.trim(), true);
            await stopContainer(containerId);

            const containers = await loadContainers();
            const container = containers[containerId];
            const agentDir = agentPath(container.name, container.version);

            // reuse existing instance row — call /restart instead of /run
            // instance_id may not exist in older containers.json — parse from run_id as fallback
            const instance_id_restart = container.instance_id ?? parseInt((container.run_id ?? "").split("_")[2], 10);
            if (!instance_id_restart || !Number.isFinite(instance_id_restart)) throw new Error("Cannot determine instance_id — try running a new container with 'lifectl ai agent run'");

            console.log("🔗 Registering agent restart with SaaS...");
            const runRes = await apiAi.post("/agents/restart", {
                instance_id: instance_id_restart,
                container_id: containerId,
                hostname: os.hostname(),
            });
            const runData = runRes.data;
            if (!runData.success) {
                if (runData.expired) {
                    throw new Error(`Instance has expired after inactivity.\nRun 'lifectl ai agent run ${sanitizeLog(container.name)}' to create a new instance.`);
                }
                throw new Error(runData.message ?? "Failed to register agent restart");
            }

            const { ctx } = runData;
            const run_id: string = ctx.meta.run_id;
            const cfg = await getConfig();
            const agentEnv: Record<string, string> = {
                AGENT_RUN_ID: run_id,
                AGENT_NAME: container.name,
                AGENT_VERSION: container.version,
                AGENT_CTX: JSON.stringify(ctx),
                AGENT_ACCESS_TOKEN: cfg?.access_token ?? "",
                AGENT_REFRESH_TOKEN: cfg?.refresh_token ?? "",
            };

            const localBinRestart = path.join(agentDir, "node_modules", ".bin", process.platform === "win32" ? "agent-runtime.cmd" : "agent-runtime");
            const startCmdRestart = await fs.pathExists(localBinRestart) ? localBinRestart : "agent-runtime";
            const pid = await spawnProcess(containerId, agentDir, startCmdRestart, agentEnv);
            containers[containerId].pid = pid;
            containers[containerId].startedAt = Date.now();
            containers[containerId].status = "running";
            containers[containerId].run_id = run_id;
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
    .description("Remove a pulled agent (accepts name, name:version, or agent ID)")
    .action(async (nameArg: string) => {
        try {
            const registry = await loadRegistry();
            const registryFile = path.join(AGENTS_DIR, "registry.json");

            // resolve agent ID → name[:version] if the argument looks like an ID (12-char hex)
            let resolvedArg = nameArg;
            if (/^[a-f0-9]{12}$/.test(nameArg)) {
                let found: { name: string; version: string } | null = null;
                for (const [agentName, entry] of Object.entries(registry as Record<string, any>)) {
                    for (const [ver, info] of Object.entries(entry.versions ?? {} as Record<string, any>)) {
                        if ((info as any).agentId === nameArg) {
                            found = { name: agentName, version: ver };
                            break;
                        }
                    }
                    if (found) break;
                }
                if (!found) throw new Error(`Agent '${sanitizeLog(nameArg)}' not found`);
                resolvedArg = `${found.name}:${found.version}`;
            }

            const [rawName, versionArg] = resolvedArg.split(":");
            const name = sanitizeName(rawName);

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
    .description("Remove a stopped container (accepts container ID, alias, or agent name)")
    .action(async (rawId: string) => {
        try {
            const containerId = await resolveStoppedContainerId(rawId.trim(), true);
            const containers = await loadContainers();
            const container = containers[containerId];
            if (isProcessAlive(container.pid)) throw new Error(`Container '${sanitizeLog(containerId)}' is running. Stop it first.`);

            // notify SaaS to delete instance from D1 and clear DO storage
            const run_id = container.run_id;
            if (run_id) {
                try {
                    const res = await apiAi.delete("/agents/instance", { data: { run_id } });
                    if (!res.data.success) {
                        console.warn(`⚠️  SaaS remove failed: ${res.data.message ?? 'unknown error'}`);
                    }
                } catch (e: any) {
                    // 404 = instance already deleted from SaaS (TTL expired or removed manually) — ok to proceed
                    if (e?.response?.status === 404) {
                        // instance not found on SaaS — already gone, proceed with local cleanup
                    } else {
                        // best-effort — local cleanup proceeds regardless
                        console.warn("⚠️  Could not notify SaaS (offline?), removing locally only");
                    }
                }
            }

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
        if (entries.length === 0) {
            console.log("No agents pulled.");
            return;
        }

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
    .description("List agent containers (like docker ps)")
    .option("-a, --all", "Show all containers (default: running only)")
    .option("--name <name>", "Filter by agent name or container alias")
    .option("--status <status>", "Filter by status: running | stopped")
    .action(async (opts: { all?: boolean; name?: string; status?: string }) => {
        const containers = await loadContainers();
        let all = Object.values(containers as Record<string, any>);

        // default: show running only (like docker ps), unless -a or --status is specified
        if (!opts.all && !opts.status) {
            all = all.filter(c => Number.isFinite(c.pid) && c.pid > 0 && isProcessAlive(c.pid));
        }

        if (opts.name) {
            const filter = opts.name.trim();
            all = all.filter(c => c.name === filter || c.alias === filter);
        }
        if (opts.status) {
            const filterStatus = opts.status.trim().toLowerCase();
            if (filterStatus !== "running" && filterStatus !== "stopped") {
                console.error("❌ --status must be 'running' or 'stopped'");
                process.exit(1);
            }
            all = all.filter(c => {
                const alive = Number.isFinite(c.pid) && c.pid > 0 && isProcessAlive(c.pid);
                return filterStatus === "running" ? alive : !alive;
            });
        }
        if (all.length === 0) {
            console.log("No containers.");
            return;
        }

        const formatDate = (ts: number) => {
            const d = new Date(ts);
            return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        };

        const rows = all.map((c) => {
            const alive = Number.isFinite(c.pid) && c.pid > 0 && isProcessAlive(c.pid);
            return {
                containerId: (c.containerId ?? "-").slice(0, 12),
                agentId: (c.agentId ?? "-").slice(0, 12),
                name: c.alias ? `${c.name} (${c.alias})` : (c.name ?? "-"),
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
            const containerId = await resolveContainerId(nameArg.trim(), true);
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

            const containerDir = resolveContainerPath(containerId);
            // poll log file for new content every 500ms — reliable across all platforms
            // (chokidar fs events are unreliable for files written by other processes on Windows)
            let currentLogFile = logFile;

            const poll = setInterval(async () => {
                try {
                    // detect log rotation — new file created, old one renamed
                    if (!await fs.pathExists(currentLogFile)) {
                        if (await fs.pathExists(logFile)) {
                            currentLogFile = logFile;
                            lastSize = 0;
                        }
                        return;
                    }
                    const size = (await fs.stat(currentLogFile)).size;
                    if (size < lastSize) lastSize = 0; // truncated/rotated
                    if (size > lastSize) {
                        const rfd = await fs.open(currentLogFile, "r");
                        const buf = Buffer.alloc(size - lastSize);
                        await fs.read(rfd, buf, 0, buf.length, lastSize);
                        await fs.close(rfd);
                        process.stdout.write(buf.toString("utf-8"));
                        lastSize = size;
                    }
                } catch {
                    // file temporarily unavailable during rotation — retry next tick
                }
            }, 500);

            // keep polling even when agent dies — same behavior as docker logs -f
            // user exits manually with Ctrl+C
            const containers = await loadContainers();
            const containerMeta = containers[containerId];
            if (containerMeta?.pid) {
                const aliveInterval = setInterval(() => {
                    if (!isProcessAlive(containerMeta.pid)) {
                        clearInterval(aliveInterval);
                        // don't exit — keep tailing in case agent restarts or user wants to read remaining logs
                    }
                }, 2000);
            }

            process.on("SIGINT", () => {
                clearInterval(poll);
                process.exit(0);
            });
        } catch (err: any) {
            console.error("❌ Log failed:", err.message);
            process.exit(1);
        }
    });

aiCommand.addCommand(agentCommand);
