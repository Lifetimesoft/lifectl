import {Command} from "commander";
import {execSync, spawn} from "child_process";
import fs from "fs-extra";
import path from "path";
import os from "os";
import {api} from "../utils/api.js";

const AGENTS_DIR = path.join(os.homedir(), ".lifectl", "agents");

export const aiCommand = new Command("ai").description("AI agent commands");

const agentCommand = new Command("agent").description("Manage AI agents");

// push
agentCommand
    .command("push")
    .description("Push agent to registry")
    .action(async () => {
        try {
            const agentJson = path.join(process.cwd(), "agent.json");
            if (!await fs.pathExists(agentJson)) throw new Error("agent.json not found");

            const agent = await fs.readJson(agentJson);
            const files: Record<string, string> = {};

            const entries = await fs.readdir(process.cwd());
            for (const entry of entries) {
                const stat = await fs.stat(path.join(process.cwd(), entry));
                if (stat.isFile()) {
                    files[entry] = await fs.readFile(path.join(process.cwd(), entry), "utf-8");
                }
            }

            const {data} = await api.post("/agents/push", {agent, files});
            if (!data.success) throw new Error(data.message);

            console.log(`✅ Pushed ${agent.name}@${agent.version}`);
        } catch (err: any) {
            console.error("❌ Push failed:", err.message);
            process.exit(1);
        }
    });

// pull
agentCommand
    .command("pull <name>")
    .description("Pull agent from registry")
    .action(async (name: string) => {
        try {
            const {data} = await api.get(`/agents/pull/${name}`);
            if (!data.success) throw new Error(data.message);

            const agentDir = path.join(AGENTS_DIR, name);
            await fs.ensureDir(agentDir);

            for (const [filename, content] of Object.entries(data.files as Record<string, string>)) {
                await fs.writeFile(path.join(agentDir, filename), content);
            }

            console.log(`✅ Pulled ${name} to ${agentDir}`);
        } catch (err: any) {
            console.error("❌ Pull failed:", err.message);
            process.exit(1);
        }
    });

// start
agentCommand
    .command("start <name>")
    .description("Start an agent")
    .action(async (name: string) => {
        try {
            const agentDir = path.join(AGENTS_DIR, name);
            if (!await fs.pathExists(agentDir)) throw new Error(`Agent '${name}' not found. Run: lifectl ai agent pull ${name}`);

            const agentJson = path.join(agentDir, "agent.json");
            const agent = await fs.readJson(agentJson);

            const installCmd = agent.scripts?.install;
            if (installCmd) {
                console.log("📦 Installing dependencies...");
                execSync(installCmd, {cwd: agentDir, stdio: "inherit"});
            }

            const startCmd = agent.scripts?.start;
            if (!startCmd) throw new Error("No start script defined in agent.json");

            const [cmd, ...args] = startCmd.split(" ");
            const child = spawn(cmd, args, {cwd: agentDir, detached: true, stdio: "ignore"});
            child.unref();

            const pidFile = path.join(agentDir, "agent.pid");
            await fs.writeFile(pidFile, String(child.pid));

            console.log(`✅ Agent '${name}' started (pid: ${child.pid})`);
        } catch (err: any) {
            console.error("❌ Start failed:", err.message);
            process.exit(1);
        }
    });

// stop
agentCommand
    .command("stop <name>")
    .description("Stop an agent")
    .action(async (name: string) => {
        try {
            const agentDir = path.join(AGENTS_DIR, name);
            const pidFile = path.join(agentDir, "agent.pid");

            if (await fs.pathExists(pidFile)) {
                const pid = parseInt(await fs.readFile(pidFile, "utf-8"));
                try {
                    process.kill(pid);
                } catch {}
                await fs.remove(pidFile);
                console.log(`✅ Agent '${name}' stopped`);
                return;
            }

            const agentJson = path.join(agentDir, "agent.json");
            if (!await fs.pathExists(agentJson)) throw new Error(`Agent '${name}' not found`);

            const agent = await fs.readJson(agentJson);
            const stopCmd = agent.scripts?.stop;
            if (!stopCmd) throw new Error("No stop script defined in agent.json");

            execSync(stopCmd, {cwd: agentDir, stdio: "inherit"});
            console.log(`✅ Agent '${name}' stopped`);
        } catch (err: any) {
            console.error("❌ Stop failed:", err.message);
            process.exit(1);
        }
    });

aiCommand.addCommand(agentCommand);
