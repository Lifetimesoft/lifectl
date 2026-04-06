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
                console.log('parse arraybuffer: ', data)
            } catch {
                return res;
            }
        }

        if (data?.code === 401) {
            const cfg = await getConfig();

            if (!cfg?.refresh_token) {
                return Promise.reject(new Error("Unauthorized"));
            }

            console.log('start call refresh token...')
            const refreshRes = await axios.post(`${APP_URL}/cli-login/refresh`, {
                access_token: cfg.access_token,
                refresh_token: cfg.refresh_token
            }, {
                headers: {
                    "X-Requested-With": "lifectl-cli"
                }
            });

            console.log('end call refresh token...')
            let accessToken = refreshRes.data.access_token

            await saveConfig({
                access_token: accessToken,
                refresh_token: refreshRes.data.refresh_token
            });

            res.config.headers.Authorization = `${accessToken}`;

            console.log('call apiAi...')
            return apiAi(res.config);
        } else {
        }

        if (data?.success === false) {
            return Promise.reject(new Error(data.message || "Request failed"));
        }

        return res;
    },
    (error) => {
        console.error(error)
        return Promise.reject(error)
    }
);
