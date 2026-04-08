import {Command} from "commander";
import {execSync, spawn} from "child_process";
import fs from "fs-extra";
import path from "path";
import os from "os";
import * as tar from "tar";
import semver from "semver";
import {apiAi} from "../utils/api-ai.js";

const AGENTS_DIR = path.join(os.homedir(), ".lifectl", "agents");

export const aiCommand = new Command("ai").description("AI agent commands");

const agentCommand = new Command("agent").description("Manage AI agents");

async function tarDirectory(sourceDir: string, outPath: string): Promise<void> {
    const ignoreFile = path.join(sourceDir, ".agentignore");
    const ignore = ["*.tar.gz", ".agentignore"];
    if (await fs.pathExists(ignoreFile)) {
        const lines = (await fs.readFile(ignoreFile, "utf-8")).split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
        ignore.push(...lines);
    }
    const entries = (await fs.readdir(sourceDir)).filter(f => !ignore.includes(f));
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
                console.error("❌ Push failed:", data);
                throw new Error(data.message);
            }

            console.log(`✅ Pushed ${agent.name}@${agent.version}`);
        } catch (err: any) {
            console.error("❌ Push failed:", err.message);
            process.exit(1);
        } finally {
            await fs.remove(zipPath);
        }
    });

function agentPath(name: string, ...parts: string[]): string {
    return path.join(AGENTS_DIR, ...name.split("/"), ...parts);
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
    for (const agentName of await fs.readdir(AGENTS_DIR)) {
        const agentNameDir = path.join(AGENTS_DIR, agentName);
        if (!(await fs.stat(agentNameDir)).isDirectory()) continue;
        const versions = await fs.readdir(agentNameDir);
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
    .action(async (name: string) => {
        const tmpFile = path.join(os.tmpdir(), `agent-${Date.now()}.tar.gz`);
        try {
            const response = await apiAi.post(`/agents/pull`, {name}, {responseType: "arraybuffer"});
            await fs.writeFile(tmpFile, Buffer.from(response.data));

            const agentVersion = response.headers["x-agent-version"] ?? "unknown";
            const agentDir = agentPath(name, agentVersion);
            await fs.ensureDir(agentDir);
            await tar.extract({file: tmpFile, cwd: agentDir});

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

            console.log(`✅ Pulled ${name}@${agentVersion}`);
        } catch (err: any) {
            console.error("❌ Pull failed:", err.message);
            process.exit(1);
        } finally {
            await fs.remove(tmpFile);
        }
    });

// start
agentCommand
    .command("start <name>")
    .description("Start an agent")
    .action(async (nameArg: string) => {
        try {
            const [name, versionArg] = nameArg.split(":");
            const registry = await loadRegistry();
            const entry = registry[name];
            if (!entry) {
                throw new Error(`Agent '${name}' not found. Run: lifectl ai agent pull ${name}`);
            }
            const version = versionArg ?? await getLatestLocalVersion(name);
            const agentDir = agentPath(name, version);
            if (!await fs.pathExists(agentDir)) {
                throw new Error(`Agent '${name}:${version}' not found. Run: lifectl ai agent pull ${name}`);
            }

            const agentJson = path.join(agentDir, "agent.json");
            const agent = await fs.readJson(agentJson);

            const installCmd = agent.scripts?.install;
            if (!installCmd) {
                const registryFile = path.join(AGENTS_DIR, "registry.json");
                registry[name].versions[version].installed = true;
                await fs.writeJson(registryFile, registry, {spaces: 2});
            } else {
                const versionEntry = entry.versions?.[version];
                if (installCmd && !versionEntry?.installed) {
                    console.log("📦 Installing dependencies...");
                    execSync(installCmd, {cwd: agentDir, stdio: "inherit"});
                    const registryFile = path.join(AGENTS_DIR, "registry.json");
                    registry[name].versions[version].installed = true;
                    await fs.writeJson(registryFile, registry, {spaces: 2});
                }
            }

            const startCmd = agent.scripts?.start;
            if (!startCmd) {
                throw new Error("No start script defined in agent.json");
            }

            const [cmd, ...args] = startCmd.split(" ");
            const child = spawn(cmd, args, {cwd: agentDir, detached: true, stdio: "ignore"});
            child.unref();

            const pidFile = path.join(agentDir, "agent.pid");
            await fs.writeFile(pidFile, String(child.pid));

            console.log(`✅ Agent '${name}:${version}' started (pid: ${child.pid})`);
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
            const [name, versionArg] = nameArg.split(":");
            const registry = await loadRegistry();
            if (!registry[name]) throw new Error(`Agent '${name}' not found`);
            const version = versionArg ?? await getLatestLocalVersion(name);
            const agentDir = agentPath(name, version);
            const pidFile = path.join(agentDir, "agent.pid");

            if (await fs.pathExists(pidFile)) {
                const pid = parseInt(await fs.readFile(pidFile, "utf-8"));
                try {
                    process.kill(pid);
                } catch {
                }
                await fs.remove(pidFile);
                console.log(`✅ Agent '${name}@${version}' stopped`);
                return;
            }

            const agentJson = path.join(agentDir, "agent.json");
            if (!await fs.pathExists(agentJson)) throw new Error(`Agent '${name}@${version}' not found`);

            const agent = await fs.readJson(agentJson);
            const stopCmd = agent.scripts?.stop;
            if (!stopCmd) throw new Error("No stop script defined in agent.json");

            execSync(stopCmd, {cwd: agentDir, stdio: "inherit"});
            console.log(`✅ Agent '${name}@${version}' stopped`);
        } catch (err: any) {
            console.error("❌ Stop failed:", err.message);
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
                const pidFile = agentPath(v.name, v.version, "agent.pid");
                const status = await fs.pathExists(pidFile) ? "running" : "stopped";
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

aiCommand.addCommand(agentCommand);
