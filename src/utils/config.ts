import fs from "fs-extra";
import os from "os";
import path from "path";

const CONFIG_DIR = path.join(os.homedir(), ".lifectl");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export async function saveConfig(data: any) {
    await fs.ensureDir(CONFIG_DIR);
    await fs.writeJson(CONFIG_PATH, data, {spaces: 2});
}

export async function getConfig() {
    try {
        return await fs.readJson(CONFIG_PATH);
    } catch {
        return null;
    }
}

export async function clearConfig() {
    await fs.remove(CONFIG_PATH);
}