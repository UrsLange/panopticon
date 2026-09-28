import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { defaultEntra, type EntraConfig, type PublicEntraConfig } from "../shared/people.js";
import type { Settings } from "../shared/schema.js";
import type { T3Connection, T3ImplementationSettings } from "../shared/t3.js";
import type { Connection } from "./application/connection.js";
import { ApplicationError } from "./application/errors.js";
import { createModelConnection } from "./application/model-connection.js";
import { createAssistant, validateToolCalling } from "./assistant.js";
import { config } from "./config.js";

type Saved = {
  t3?: T3Connection;
  t3Defaults?: T3ImplementationSettings;
  connection?: Connection;
  profilePath?: string;
  timezone?: string;
  profileReady?: boolean;
  projectRoots?: string[];
  entra?: EntraConfig;
};

export class SettingsStore {
  private saved: Saved;
  private file: string;
  constructor(private defaults = config) {
    this.file = join(defaults.dataDir, "settings.json");
    this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
  }
  get profilePath() {
    return this.saved.profilePath ?? this.defaults.profileDir;
  }
  get timezone() {
    return this.saved.timezone ?? this.defaults.timezone;
  }
  get profileReady() {
    return this.saved.profileReady ?? false;
  }
  get modelReady() {
    return !!this.saved.connection?.model;
  }
  get projectRoots() {
    return this.saved.projectRoots ?? [];
  }
  get dataDir() {
    return this.defaults.dataDir;
  }
  t3Connection() {
    return this.saved.t3;
  }
  saveT3(t3: T3Connection | undefined) {
    this.save({ t3 });
  }
  t3Defaults(): T3ImplementationSettings {
    return {
      autoStart: false,
      ...(this.saved.t3Defaults ?? {
        model: this.saved.t3?.defaultModel ?? { instanceId: "codex", model: "" },
        workspaceMode: "worktree",
        runtimeMode: "approval-required",
      }),
    };
  }
  saveT3Defaults(t3Defaults: T3ImplementationSettings) {
    this.save({ t3Defaults });
  }
  entraCredentials() {
    return this.saved.entra;
  }
  publicEntra(): PublicEntraConfig {
    if (!this.saved.entra) return structuredClone(defaultEntra);
    const { clientSecret, ...publicConfig } = this.saved.entra;
    return { ...publicConfig, hasClientSecret: !!clientSecret };
  }
  saveEntra(input: EntraConfig) {
    const previous = this.saved.entra;
    const clientSecret =
      input.authMode === "client-secret"
        ? input.clientSecret ||
          (previous?.tenantId === input.tenantId && previous?.clientId === input.clientId
            ? previous.clientSecret
            : undefined)
        : undefined;
    if (input.authMode === "client-secret" && !clientSecret)
      throw new Error("Enter a client secret for this tenant and application.");
    this.save({ entra: { ...input, clientSecret } });
  }
  saveProjectRoots(projectRoots: string[]) {
    this.save({ projectRoots });
  }
  connection(): Connection {
    return this.saved.connection ?? { baseURL: this.defaults.baseURL, model: this.defaults.model };
  }
  credentialSources(): Settings["credentialSources"] {
    const sources: Settings["credentialSources"] = [];
    if (this.saved.connection?.apiKey)
      sources.push({ source: "saved", endpoint: this.saved.connection.baseURL });
    if (this.defaults.apiKey)
      sources.push({ source: "environment", endpoint: this.defaults.baseURL });
    if (this.defaults.keyFile) {
      try {
        if (readFileSync(this.defaults.keyFile, "utf8").trim())
          sources.push({
            source: "file",
            endpoint: this.defaults.baseURL,
            path: this.defaults.keyFile,
          });
      } catch {
        /* Unreadable files are not available credential sources. */
      }
    }
    return sources;
  }
  credentials(input = this.connection()): Connection {
    const baseURL = input.baseURL.replace(/\/+$/, "");
    let apiKey = input.apiKey;
    if (!apiKey && baseURL === this.connection().baseURL.replace(/\/+$/, ""))
      apiKey = this.saved.connection?.apiKey;
    if (!apiKey && baseURL === this.defaults.baseURL.replace(/\/+$/, ""))
      apiKey = this.defaults.apiKey;
    if (!apiKey && baseURL === this.defaults.baseURL.replace(/\/+$/, "") && this.defaults.keyFile) {
      try {
        apiKey = readFileSync(this.defaults.keyFile, "utf8").trim();
      } catch {
        /* Missing or unreadable defaults require configuration in the UI. */
      }
    }
    if (!apiKey)
      throw new ApplicationError(
        "unavailable",
        "No API key is available for this endpoint. Open Settings → Model and enter an API key or restore the configured credential source.",
      );
    return { ...input, baseURL, apiKey };
  }
  saveValidated(input: Connection, baseURL: string) {
    // Keep file-backed credentials in their source file rather than copying them into settings.
    const apiKey =
      input.apiKey ||
      (input.baseURL.replace(/\/+$/, "") === this.connection().baseURL.replace(/\/+$/, "")
        ? this.saved.connection?.apiKey
        : undefined);
    this.save({
      connection: {
        baseURL,
        model: input.model,
        ...(apiKey ? { apiKey } : {}),
      },
    });
  }
  saveProfile(profilePath: string, timezone: string) {
    this.save({ profilePath, timezone, profileReady: true });
  }
  private save(update: Saved) {
    const next = { ...this.saved, ...update };
    mkdirSync(this.defaults.dataDir, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.file);
    chmodSync(this.file, 0o600);
    this.saved = next;
  }
}

function connectionError(error: unknown, model = false) {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403)
      return "The provider rejected access. Check your API key and model permissions.";
    if (error.status === 429)
      return "The provider is rate-limited or out of quota. Try again later.";
  }
  return model
    ? "Model validation failed. Choose a model supporting the Responses API, tool calling, hosted web search and structured JSON outputs, or check your connection. Your previous settings are unchanged."
    : "Could not load models. Check the endpoint, network or VPN, and API key.";
}

export function settingsModels(settings: SettingsStore) {
  return createModelConnection(settings, {
    async models(credentials) {
      const client = new OpenAI({
        ...credentials,
        timeout: 15000,
        maxRetries: 0,
        fetchOptions: { redirect: "error" },
      });
      const models = await client.models.list();
      return models.data.map((model) => model.id).sort();
    },
    assistant: (credentials) =>
      createAssistant(credentials.apiKey ?? "", credentials.model, credentials.baseURL),
    validateTools: (credentials) =>
      validateToolCalling(credentials.apiKey ?? "", credentials.model, credentials.baseURL),
    errorMessage: connectionError,
  });
}
