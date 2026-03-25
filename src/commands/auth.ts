import {Command} from "commander";
import open from "open";
import {api} from "../utils/api.js";
import {clearConfig, saveConfig} from "../utils/config.js";

export const authCommand = new Command("auth")
    .description("Authentication commands");

// ✅ LOGIN
authCommand
    .command("login")
    .description("Login via browser")
    .action(async () => {
        try {
            console.log("🔐 Starting login...");

            const {data} = await api.post("/auth/device");

            const {device_code, verification_url, user_code, interval} = data;

            const safeUrl = encodeURI(verification_url);
            const safeCode = String(user_code).replace(/[^\w-]/g, "");

            console.log("\n👉 Please log in via your browser:");
            console.log(safeUrl);
            console.log(`Code: ${safeCode}\n`);

            await open(safeUrl);

            console.log("⏳ Waiting for authentication...");

            let tokenData = null;
            let attempts = 0;
            const MAX_ATTEMPTS = 60;

            while (!tokenData && attempts < MAX_ATTEMPTS) {
                attempts++;
                await new Promise((r) => setTimeout(r, interval * 1000));

                try {
                    const res = await api.post("/auth/device/token", {device_code});
                    tokenData = res.data;
                } catch (err: any) {
                    if (err.response?.data?.error === "authorization_pending") {
                        process.stdout.write(".");
                        continue;
                    } else {
                        throw err;
                    }
                }
            }

            if (!tokenData) throw new Error("Login timeout. Please try again.");

            await saveConfig({
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                expires_at: Date.now() + tokenData.expires_in * 1000
            });

            console.log("\n✅ Login successful!");
        } catch (err: any) {
            console.error("❌ Login failed:", err.message);
        }
    });

// ✅ LOGOUT
authCommand
    .command("logout")
    .description("Logout")
    .action(async () => {
        await clearConfig();
        console.log("👋 Logged out");
    });
