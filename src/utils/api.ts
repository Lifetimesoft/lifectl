import axios from "axios";
import {getConfig, saveConfig} from "./config.js";

const BASE_URL = "https://app.lifetimesoft.com/ex-api";

export const api = axios.create({
    baseURL: BASE_URL,
    timeout: 10000
});

// 🔁 interceptor ใส่ token
api.interceptors.request.use(async (config) => {
    const cfg = await getConfig();

    if (cfg?.access_token) {
        config.headers.Authorization = `Bearer ${cfg.access_token}`;
    }

    return config;
});

// 🔁 refresh token
api.interceptors.response.use(
    (res) => res,
    async (error) => {
        const original = error.config;

        if (error.response?.status === 401 && !original._retry) {
            original._retry = true;

            const cfg = await getConfig();

            if (!cfg?.refresh_token) throw error;

            const res = await axios.post(`${BASE_URL}/auth/refresh`, {
                refresh_token: cfg.refresh_token
            }, {
                headers: {"X-Requested-With": "lifectl-cli"}
            });

            const newCfg = {
                ...cfg,
                access_token: res.data.access_token,
                expires_at: Date.now() + res.data.expires_in * 1000
            };

            await saveConfig(newCfg);

            original.headers.Authorization = `Bearer ${newCfg.access_token}`;

            return api(original);
        }

        throw error;
    }
);
