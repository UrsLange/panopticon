import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Assistant } from "../server/application/assistant.js";
import type { T3Client } from "../server/application/t3.js";
import { createApplication } from "../server/bootstrap.js";
import { config } from "../server/config.js";
import { SettingsStore } from "../server/settings.js";
import { Store } from "../server/store.js";
import type { Item, Refinement } from "../shared/schema.js";
import { t3OverridesSchema } from "../shared/t3.js";
import { refinementAgent } from "./refinement-agent.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function fixture(global?: boolean, override?: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pa-auto-start-")));
  const path = join(root, "portal");
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", [
    "-C",
    path,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "test: initialize",
  ]);
  const defaults = { ...config, dataDir: root, profileDir: join(root, "profile") };
  const settings = new SettingsStore(defaults);
  settings.saveProjectRoots([root]);
  settings.saveT3({
    endpoint: "http://127.0.0.1:3773",
    accessToken: "private",
    environmentId: "local",
    serverVersion: "test",
    defaultModel: { instanceId: "codex", model: "test-model" },
  });
  if (global !== undefined)
    settings.saveT3Defaults({ ...settings.t3Defaults(), autoStart: global });
  writeFileSync(
    join(root, "project-scan.json"),
    JSON.stringify({
      projects: [
        {
          id: "repo",
          root,
          path,
          name: "portal",
          document: null,
          availability: "available",
          error: null,
        },
      ],
    }),
  );
  const store = new Store(join(root, "assistant.sqlite"));
  store.saveProject({
    id: "repo",
    profileRoot: defaults.profileDir,
    root,
    path,
    name: "portal",
    document: null,
    documentSource: "discovery",
    hidden: false,
    returnToDefault: false,
    git: null,
    insights: null,
    checkedAt: null,
    remoteCheckedAt: null,
    error: null,
    remoteError: null,
    t3: override === undefined ? undefined : { autoStart: override },
  });
  const result: Partial<Refinement> = {
    title: "Portal search",
    kind: "commitment",
    project: "portal",
    prompt: "Implement portal search and test it.",
    execution: "implementation",
    sources: [],
    referenceIds: [],
    dueDate: null,
    priority: "normal",
    relatedId: null,
    clarificationQuestions: [],
  };
  const assistant: Assistant = {
    interpret: vi.fn(refinementAgent(async () => structuredClone(result))),
    consolidateProfile: vi.fn(),
    updateProfile: vi.fn(),
    ask: vi.fn(),
  };
  const client: T3Client = {
    connect: vi.fn(),
    projects: vi.fn(async () => []),
    launch: vi.fn(async () => {}),
    progress: vi.fn(),
  };
  const app = createApplication({ store, settings, assistant, t3Client: client });
  cleanup.push(async () => {
    await app.close();
    store.db.close();
  });
  const refine = async (changes: Partial<Item> = {}) => {
    const captured = store.capture("Build portal search");
    store.update(captured.id, changes, captured.revision);
    await app.captures.process(captured.id);
    return store.get(captured.id) as Item;
  };
  return { app, store, settings, defaults, assistant, client, result, refine };
}

it.each([
  [undefined, undefined, false],
  [false, undefined, false],
  [true, undefined, true],
  [true, false, false],
  [false, true, true],
  [true, true, true],
  [false, false, false],
] as const)(
  "resolves global %s and project %s to %s after saving refinement",
  async (global, override, effective) => {
    const f = fixture(global, override);
    vi.mocked(f.client.launch).mockImplementation(async (_connection, entry) => {
      expect(f.store.get(entry.itemId)).toMatchObject({
        processing: "ready",
        prompt: entry.prompt,
        revision: entry.revision,
      });
      expect(f.store.latestImplementation(entry.itemId, f.defaults.profileDir)?.id).toBe(entry.id);
    });
    const item = await f.refine();
    expect(f.app.t3.options(item.id).autoStart).toBe(effective);
    expect(f.client.launch).toHaveBeenCalledTimes(Number(effective));
    expect(item).toMatchObject({
      processing: "ready",
      processingError: null,
      status: effective ? "in_progress" : "open",
    });
    if (!effective) {
      await f.app.t3.implement(item.id, { revision: item.revision });
      expect(f.client.launch).toHaveBeenCalledTimes(1);
    }
  },
);

it("defaults new and legacy settings to off and preserves explicit overrides on reload", async () => {
  const f = fixture();
  expect(new SettingsStore(f.defaults).t3Defaults().autoStart).toBe(false);
  const legacy = {
    model: { instanceId: "codex", model: "legacy" },
    workspaceMode: "checkout",
    runtimeMode: "full-access",
  };
  writeFileSync(join(f.defaults.dataDir, "settings.json"), JSON.stringify({ t3Defaults: legacy }));
  expect(new SettingsStore(f.defaults).t3Defaults()).toEqual({ ...legacy, autoStart: false });
  expect(t3OverridesSchema.parse({})).toEqual({});
  expect(t3OverridesSchema.parse({ autoStart: false })).toEqual({ autoStart: false });
  expect(t3OverridesSchema.safeParse({ autoStart: "false" }).success).toBe(false);
  f.app.t3.saveAutoStart(true);
  expect(new SettingsStore(f.defaults).t3Defaults().autoStart).toBe(true);
  f.app.t3.saveAutoStart(false);
  expect(new SettingsStore(f.defaults).t3Defaults().autoStart).toBe(false);
});

it.each([
  { kind: "idea" },
  { kind: "note" },
  { execution: "manual" },
  { clarificationQuestions: ["Which behavior?"] },
  { prompt: "  \n" },
  { project: "" },
  { project: "unknown" },
] satisfies Partial<Refinement>[])(
  "does not auto-start an ineligible refinement %j",
  async (changes) => {
    const f = fixture(true);
    Object.assign(f.result, changes);
    await f.refine();
    expect(f.client.launch).not.toHaveBeenCalled();
  },
);

it.each([
  { noProject: true },
  { status: "done" },
  { status: "archived" },
] satisfies Partial<Item>[])("does not auto-start an ineligible saved task %j", async (changes) => {
  const f = fixture(true);
  await f.refine(changes);
  expect(f.client.launch).not.toHaveBeenCalled();
});

it.each(["missing", "ambiguous", "outside roots"])(
  "does not auto-start with a repository that is %s",
  async (mode) => {
    const f = fixture(true);
    const inventory = f.app.scanner.status().projects;
    if (mode === "missing") inventory[0].availability = "missing";
    if (mode === "ambiguous") inventory.push({ ...inventory[0], id: "duplicate" });
    if (mode === "outside roots") f.settings.saveProjectRoots([]);
    await f.refine();
    expect(f.client.projects).not.toHaveBeenCalled();
    expect(f.client.launch).not.toHaveBeenCalled();
  },
);

it("does not launch failed refinement, stale results, or manually accepted briefs", async () => {
  const f = fixture(true);
  vi.mocked(f.assistant.interpret).mockRejectedValueOnce(new Error("provider failed"));
  const failed = await f.refine();
  expect(failed.processingError).toBeTruthy();
  vi.mocked(f.assistant.interpret).mockImplementationOnce(
    refinementAgent(async () => {
      const item = f.store.list().find((entry) => entry.id !== failed.id) as Item;
      f.store.update(item.id, { title: "Concurrent edit" }, item.revision);
      return f.result;
    }),
  );
  const stale = await f.refine();
  expect(stale.title).toBe("Concurrent edit");
  expect(stale.processing).toBe("pending");
  const accepted = f.store.update(
    failed.id,
    { kind: "commitment", project: "portal", prompt: "Manual prompt" },
    failed.revision,
  );
  f.app.captures.markRefined(accepted.id, accepted.revision);
  expect(f.client.launch).not.toHaveBeenCalled();
});

it.each(["connection", "workspace", "T3 ambiguity", "launch"])(
  "keeps refinement successful and persists an auto-start %s failure",
  async (stage) => {
    const f = fixture(true);
    if (stage === "connection") f.settings.saveT3(undefined);
    if (stage === "workspace")
      f.app.scanner.status().projects[0].path = join(f.defaults.dataDir, "absent");
    if (stage === "workspace") f.app.scanner.status().projects[0].name = "absent";
    if (stage === "workspace") f.result.project = "absent";
    if (stage === "T3 ambiguity")
      vi.mocked(f.client.projects).mockResolvedValue([
        {
          id: "one",
          workspaceRoot: join(f.defaults.dataDir, "portal"),
          defaultModelSelection: null,
        },
        {
          id: "two",
          workspaceRoot: join(f.defaults.dataDir, "portal"),
          defaultModelSelection: null,
        },
      ]);
    if (stage === "launch")
      vi.mocked(f.client.launch).mockRejectedValueOnce(new Error("private-token"));
    const item = await f.refine();
    expect(item).toMatchObject({
      processing: "ready",
      processingError: null,
      status: "open",
      autoStartError: expect.any(String),
    });
    expect(item.autoStartError).not.toContain("private-token");
    expect(f.app.captures.list().find((entry) => entry.id === item.id)?.refinement).toBe("ready");
    const reopened = new Store(join(f.defaults.dataDir, "assistant.sqlite"));
    expect(reopened.get(item.id)?.autoStartError).toBe(item.autoStartError);
    reopened.db.close();
  },
);

it("shares concurrent refinement, deduplicates automatic/manual triggers, and never starts another thread on re-refinement", async () => {
  const f = fixture(true);
  const item = f.store.capture("Build portal search");
  const first = f.app.captures.process(item.id);
  expect(f.app.captures.process(item.id)).toBe(first);
  await first;
  const current = f.store.get(item.id) as Item;
  await Promise.all([
    f.app.t3.autoStart(item.id, current.revision),
    f.app.t3.implement(item.id, { revision: current.revision }),
    f.app.captures.retry(item.id, { resetReferences: false }),
  ]);
  expect(f.client.launch).toHaveBeenCalledTimes(1);
  expect(f.store.latestImplementation(item.id, f.defaults.profileDir)?.autoStarted).toBe(true);
});

it("retries an unconfirmed auto-start with the same persisted identity and clears the failure", async () => {
  const f = fixture(true);
  vi.mocked(f.client.launch).mockRejectedValueOnce(new Error("lost response"));
  const item = await f.refine();
  const pending = f.store.latestImplementation(item.id, f.defaults.profileDir);
  expect(pending?.state).toBe("pending");
  await f.app.captures.retry(item.id, { resetReferences: false });
  const submitted = f.store.latestImplementation(item.id, f.defaults.profileDir);
  expect(submitted).toMatchObject({ id: pending?.id, state: "submitted", prompt: pending?.prompt });
  expect(f.store.get(item.id)).toMatchObject({
    autoStartError: null,
    status: "in_progress",
    processing: "ready",
  });
  expect(f.client.launch).toHaveBeenCalledTimes(2);
});

it("serializes simultaneous automatic and manual launches before any handoff exists", async () => {
  const f = fixture(false);
  const item = await f.refine();
  f.app.t3.saveAutoStart(true);
  expect(f.client.launch).not.toHaveBeenCalled();
  await Promise.all([
    f.app.t3.autoStart(item.id, item.revision),
    f.app.t3.autoStart(item.id, item.revision),
    f.app.t3.implement(item.id, { revision: item.revision }),
  ]);
  expect(f.client.launch).toHaveBeenCalledTimes(1);
});

it.each([
  { execution: "manual" },
  { processing: "pending" },
  { processingError: "Previous refinement failed" },
  { clarifications: [{ id: "question", question: "Which version?", answer: "", resolved: false }] },
] satisfies Partial<Item>[])("rejects an automatic trigger for saved state %j", async (changes) => {
  const f = fixture(false);
  const item = await f.refine();
  const updated = f.store.update(item.id, changes, item.revision);
  f.app.t3.saveAutoStart(true);
  await f.app.t3.autoStart(item.id, updated.revision);
  expect(f.client.launch).not.toHaveBeenCalled();
});

it("does not automatically retry an old prompt and preserves manual retry after restart", async () => {
  const f = fixture(true);
  vi.mocked(f.client.launch).mockRejectedValueOnce(new Error("lost response"));
  const item = await f.refine();
  const pending = f.store.latestImplementation(item.id, f.defaults.profileDir);
  f.result.prompt = "A materially different task";
  await f.app.captures.retry(item.id, { resetReferences: false });
  expect(f.client.launch).toHaveBeenCalledTimes(1);
  await f.app.close();
  const restarted = createApplication({
    store: f.store,
    settings: new SettingsStore(f.defaults),
    assistant: f.assistant,
    t3Client: f.client,
  });
  cleanup.push(() => restarted.close());
  await restarted.t3.implement(item.id, { revision: (f.store.get(item.id) as Item).revision });
  expect(f.store.latestImplementation(item.id, f.defaults.profileDir)).toMatchObject({
    id: pending?.id,
    state: "submitted",
    prompt: pending?.prompt,
  });
});

it.each(["setting", "repository", "revision"])(
  "rechecks %s after asynchronous preparation",
  async (change) => {
    const f = fixture(true);
    vi.mocked(f.client.projects).mockImplementationOnce(async () => {
      if (change === "setting") f.app.t3.saveAutoStart(false);
      if (change === "repository") f.app.scanner.status().projects[0].availability = "missing";
      if (change === "revision") {
        const item = f.store.list()[0];
        f.store.update(item.id, { prompt: "Changed while preparing" }, item.revision);
      }
      return [];
    });
    const item = await f.refine();
    expect(f.client.launch).not.toHaveBeenCalled();
    expect(f.store.latestImplementation(item.id, f.defaults.profileDir)).toBeNull();
  },
);
