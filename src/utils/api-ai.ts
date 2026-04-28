import axios from "axios";
import {getConfig, saveConfig} from "./config.js";
import {APP_URL} from "./api.js";

const BASE_URL = "https://app.lifetimesoft.com/cli/ai-account-management";

export const apiAi = axios.create({
    baseURL: BASE_URL,
    timeout: 10000
});

// 🔁 interceptor token
apiAi.interceptors.request.use(async (config) => {
    const cfg = await getConfig();

    if (cfg?.access_token) {
        config.headers.Authorization = `${cfg.access_token}`;
    }

    return config;
});

// 🔁 refresh token
apiAi.interceptors.response.use(
    async (res) => {
        let data = res.data;

        if (res.config.responseType === "arraybuffer" && Buffer.isBuffer(data)) {
            try {
                data = JSON.parse(data.toString("utf-8"));
            } catch {
                return res;
            }
        }

        // app-main AuthCli always returns HTTP 200 with body:
        //   { code: 401, success: false } → invalid token (bad signature)
        //   { code: 406, success: false } → expired token
        // Both cases require a token refresh + retry
        const needsRefresh = data?.code === 401 || data?.code === 406;

        if (needsRefresh && !(res.config as any).__retried) {
            const cfg = await getConfig();

            if (!cfg?.refresh_token) {
                return Promise.reject(new Error("Unauthorized — no refresh token available"));
            }

            try {
                const refreshRes = await axios.post(`${APP_URL}/cli-login/refresh`, {
                    access_token: cfg.access_token,
                    refresh_token: cfg.refresh_token
                }, {
                    headers: { "X-Requested-With": "lifectl-cli" }
                });

                if (!refreshRes.data.success) {
                    return Promise.reject(new Error("Session expired — please run 'lifectl auth login'"));
                }

                const accessToken = refreshRes.data.access_token;
                await saveConfig({
                    ...cfg,
                    access_token: accessToken,
                    refresh_token: refreshRes.data.refresh_token ?? cfg.refresh_token,
                });

                // retry original request with new token
                (res.config as any).__retried = true;
                res.config.headers.Authorization = `${accessToken}`;
                return apiAi(res.config);
            } catch (e: any) {
                return Promise.reject(new Error(`Token refresh failed: ${e.message}`));
            }
        }

        if (data?.success === false && !needsRefresh) {
            return Promise.reject(new Error(data.message || "Request failed"));
        }

        return res;
    },
    (error) => {
        // HTTP-level errors (network, timeout, etc.)
        return Promise.reject(error);
    }
);
