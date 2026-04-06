import axios from "axios";

const BASE_URL = "https://app.lifetimesoft.com/ex-api";

export const api = axios.create({
    baseURL: BASE_URL,
    timeout: 10000
});