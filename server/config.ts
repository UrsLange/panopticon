import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export const config = {
  port: Number(process.env.PA_PORT || 4317),
  dataDir: resolve(process.env.PA_DATA_DIR || `${homedir()}/.local/share/personal-assistant`),
  profileDir: resolve(
    process.env.PA_PROFILE_DIR || `${homedir()}/.local/share/personal-assistant-profile`,
  ),
  timezone: process.env.PA_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  apiKey: process.env.OPENAI_API_KEY || "",
  model: process.env.PA_MODEL || "",
  baseURL: process.env.PA_MODEL_BASE_URL || "https://api.openai.com/v1",
  keyFile: process.env.PA_KEY_FILE ?? "",
};
