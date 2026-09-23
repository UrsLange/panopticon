import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ existsSync: () => false }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("defaults to the LiteLLM endpoint and its local key file", async () => {
  vi.stubEnv("PA_MODEL_BASE_URL", undefined);
  vi.stubEnv("PA_KEY_FILE", undefined);
  const { config } = await import("../server/config.js");
  expect(config.baseURL).toBe("https://litellm.jobrad.tech/v1");
  expect(config.keyFile).toBe(resolve(homedir(), ".config/jobrad-ai/litellm.key"));
});

it("allows disabling the default file lookup", async () => {
  vi.stubEnv("PA_MODEL_BASE_URL", undefined);
  vi.stubEnv("PA_KEY_FILE", "");
  const { config } = await import("../server/config.js");
  expect(config.keyFile).toBe("");
});

it("does not send the default LiteLLM key to a different configured endpoint", async () => {
  vi.stubEnv("PA_MODEL_BASE_URL", "https://api.openai.com/v1");
  vi.stubEnv("PA_KEY_FILE", undefined);
  const { config } = await import("../server/config.js");
  expect(config.baseURL).toBe("https://api.openai.com/v1");
  expect(config.keyFile).toBe("");
});

it("allows a custom key file for a custom endpoint", async () => {
  vi.stubEnv("PA_MODEL_BASE_URL", "https://model.example/v1");
  vi.stubEnv("PA_KEY_FILE", "/fixture/provider.key");
  const { config } = await import("../server/config.js");
  expect(config.keyFile).toBe("/fixture/provider.key");
});
