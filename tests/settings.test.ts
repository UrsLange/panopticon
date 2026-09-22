import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../server/bootstrap.js";
import { config } from "../server/config.js";
import { Profile } from "../server/profile.js";
import { SettingsStore, settingsModels } from "../server/settings.js";
import { Store } from "../server/store.js";
import { mockProvider } from "./mock-provider.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const provider = mockProvider();
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const root = mkdtempSync(join(tmpdir(), "pa-settings-"));
  const defaults = {
    ...config,
    dataDir: root,
    profileDir: join(root, "profile"),
    baseURL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
    apiKey: "test-key",
    model: "",
    keyFile: "",
  };
  return { root, defaults, settings: new SettingsStore(defaults) };
}

it("discovers models, validates both operations, persists settings and preserves a working connection on failure", async () => {
  const { root, defaults, settings } = await fixture();
  expect(await settingsModels(settings).discover()).toEqual(["test-model", "unsupported-model"]);
  await settingsModels(settings).connect({
    baseURL: defaults.baseURL,
    model: "test-model",
    apiKey: "test-key",
  });
  expect(new SettingsStore(defaults).modelReady).toBe(true);
  expect(statSync(join(root, "settings.json")).mode & 0o777).toBe(0o600);
  await expect(
    settingsModels(settings).connect({ baseURL: defaults.baseURL, model: "unsupported-model" }),
  ).rejects.toThrow("Model validation failed");
  expect(settings.connection().model).toBe("test-model");
  await expect(
    settingsModels(settings).discover({ baseURL: defaults.baseURL, model: "", apiKey: "wrong" }),
  ).rejects.toThrow("rejected access");
  expect(() => settings.credentials({ baseURL: "https://other.example/v1", model: "" })).toThrow(
    "No API key",
  );
});

it("reads a file-backed default only for its intended endpoint", async () => {
  const { root, defaults } = await fixture();
  const keyFile = join(root, "fixture.key");
  writeFileSync(keyFile, "fixture-secret\n");
  const settings = new SettingsStore({
    ...defaults,
    baseURL: "https://model.example/v1/",
    apiKey: "",
    keyFile,
  });
  expect(settings.credentials().apiKey).toBe("fixture-secret");
  expect(settings.credentials({ baseURL: "https://model.example/v1", model: "" }).apiKey).toBe(
    "fixture-secret",
  );
  expect(settings.credentialSources()).toEqual([
    { source: "file", endpoint: "https://litellm.jobrad.tech/v1", path: keyFile },
  ]);
  expect(() => settings.credentials({ baseURL: "https://other.example/v1", model: "" })).toThrow(
    "No API key",
  );
  expect(JSON.stringify(settings.connection())).not.toContain("fixture-secret");
  expect(JSON.stringify(settings.credentialSources())).not.toContain("fixture-secret");
  writeFileSync(keyFile, "");
  expect(settings.credentialSources()).toEqual([]);
});

it("reports credential precedence without exposing keys", async () => {
  const { settings, defaults } = await fixture();
  expect(settings.credentialSources()).toEqual([
    { source: "environment", endpoint: defaults.baseURL },
  ]);
  settings.saveValidated(
    { baseURL: defaults.baseURL, model: "test-model", apiKey: "private-key" },
    defaults.baseURL,
  );
  expect(settings.credentialSources()).toEqual([
    { source: "saved", endpoint: defaults.baseURL },
    { source: "environment", endpoint: defaults.baseURL },
  ]);
  settings.saveValidated(
    { baseURL: `${defaults.baseURL}/`, model: "test-model" },
    defaults.baseURL,
  );
  expect(settings.credentials().apiKey).toBe("private-key");
});

it("returns folder selections and cancellation without saving, and rejects cross-origin requests", async () => {
  const { settings, defaults } = await fixture();
  let selected: string | null = defaults.profileDir;
  let calls = 0;
  const app = createApp({
    settings,
    chooseDirectory: async () => {
      calls++;
      return selected;
    },
  });
  cleanup.push(() => app.close());
  const request = {
    method: "POST" as const,
    url: "/api/settings/directory",
    headers: { host: "127.0.0.1:4317" },
    payload: {},
  };
  expect((await app.inject(request)).json()).toEqual({ path: selected });
  selected = null;
  expect((await app.inject(request)).json()).toEqual({ path: null });
  expect(settings.projectRoots).toEqual([]);
  expect(
    (
      await app.inject({
        ...request,
        headers: { ...request.headers, origin: "https://example.com" },
      })
    ).statusCode,
  ).toBe(403);
  expect((await app.inject({ ...request, payload: undefined })).statusCode).toBe(415);
  expect(calls).toBe(2);
});

it("onboards an independent profile and never returns the saved API key", async () => {
  const { root, defaults, settings } = await fixture();
  const store = new Store(":memory:");
  const app = createApp({ settings, store });
  cleanup.push(async () => {
    await app.close();
    store.db.close();
  });
  const headers = { host: "127.0.0.1:4317" };
  const connected = await app.inject({
    method: "PUT",
    url: "/api/settings/connection",
    headers,
    payload: { baseURL: defaults.baseURL, apiKey: "test-key", model: "test-model" },
  });
  expect(connected.statusCode).toBe(200);
  expect(connected.body).not.toContain("test-key");
  const onboarded = await app.inject({
    method: "POST",
    url: "/api/settings/profile",
    headers,
    payload: {
      mode: "create",
      path: defaults.profileDir,
      timezone: "Europe/Berlin",
      name: "Alex",
      role: "Product lead",
    },
  });
  expect(onboarded.statusCode).toBe(200);
  expect(onboarded.json().profileReady).toBe(true);
  const docs = (await app.inject({ url: "/api/profile", headers })).json();
  expect(docs.some((doc: { content: string }) => doc.content.includes("Product lead"))).toBe(true);
  expect(readFileSync(join(root, "settings.json"), "utf8")).toContain(defaults.profileDir);
  const prompt = (await app.inject({ url: "/api/profile/enrichment", headers })).json().prompt;
  expect(prompt).toContain(defaults.profileDir);
  expect(prompt).not.toContain("test-key");
  expect(prompt).not.toContain("Codex");
  const retry = await app.inject({
    method: "POST",
    url: "/api/settings/profile",
    headers,
    payload: { mode: "create", path: defaults.profileDir, timezone: "Europe/Berlin" },
  });
  expect(retry.statusCode).toBe(400);
  expect((await app.inject({ url: "/api/profile", headers })).json()).toEqual(docs);
  const another = new Profile(join(root, "another-profile"));
  another.initialize();
  another.create("Research", "Custom context", "A different profile");
  const switched = await app.inject({
    method: "POST",
    url: "/api/settings/profile",
    headers,
    payload: { mode: "connect", path: another.root, timezone: "America/New_York" },
  });
  expect(switched.statusCode).toBe(200);
  expect(switched.json().timezone).toBe("America/New_York");
  expect(
    (await app.inject({ url: "/api/profile", headers }))
      .json()
      .some((doc: { title: string }) => doc.title === "Research"),
  ).toBe(true);
  expect(new Profile(defaults.profileDir).documents()).toEqual(docs);
});
