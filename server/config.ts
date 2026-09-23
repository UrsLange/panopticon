import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const baseURL = process.env.PA_MODEL_BASE_URL || "https://litellm.jobrad.tech/v1";

export const config = {
  port: Number(process.env.PA_PORT || 4317),
  dataDir: resolve(process.env.PA_DATA_DIR || `${homedir()}/.local/share/personal-assistant`),
  profileDir: resolve(
    process.env.PA_PROFILE_DIR || `${homedir()}/.local/share/personal-assistant-profile`,
  ),
  timezone: process.env.PA_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  apiKey: process.env.OPENAI_API_KEY || "",
  model: process.env.PA_MODEL || "",
  baseURL,
  keyFile:
    process.env.PA_KEY_FILE ??
    (baseURL.replace(/\/+$/, "") === "https://litellm.jobrad.tech/v1"
      ? resolve(homedir(), ".config/jobrad-ai/litellm.key")
      : ""),
};
