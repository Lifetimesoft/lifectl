import {Command} from "commander";
import open from "open";
import {api} from "../utils/api.js";
import {clearConfig, saveConfig} from "../utils/config.js";

const POLL_INTERVAL = 3000;
const POLL_TIMEOUT = 5 * 60 * 1000;

export const authCommand = new Command("auth")
    .description("Authentication commands");

// ✅ LOGIN
authCommand
    .command("login")
    .description("Login via browser")
    .action(async () => {
        try {
            const {data: init} = await api.post("/cli-login/init");
            if (!init.success) throw new Error(init.message);

            const {device_code, login_url} = init;

            console.log(`\n🔗 Opening browser to login...`);
            console.log(`   ${login_url}\n`);
            console.log("⏳ Waiting for authentication...");

            await open(login_url);

            const token = await pollForToken(device_code);

            await saveConfig({
                access_token: token.access_token,
                refresh_token: token.refresh_token
            });

            console.log("\n✅ Login successful!");
        } catch (err: any) {
            console.error("❌ Login failed:", err.message);
            process.exit(1);
        }
    });

async function pollForToken(device_code: string): Promise<{access_token: string; refresh_token: string}> {
    const deadline = Date.now() + POLL_TIMEOUT;

    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL);

        const {data} = await api.get("/cli-login/poll", {params: {device_code}});

        if (data.status === "completed") return data;
        if (data.status === "expired") throw new Error("Login session expired");
    }

    throw new Error("Login timed out");
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ✅ LOGOUT
authCommand
    .command("logout")
    .description("Logout")
    .action(async () => {
        await clearConfig();
        console.log("👋 Logged out");
    });
