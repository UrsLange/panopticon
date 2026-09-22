import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Assistant } from "../server/application/assistant.js";
import { createApp } from "../server/bootstrap.js";
import { config } from "../server/config.js";
import { Profile } from "../server/profile.js";
import { SettingsStore } from "../server/settings.js";
import { Store } from "../server/store.js";

const headers = { host: "127.0.0.1:4317" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function setup() {
  const profile = new Profile(mkdtempSync(join(tmpdir(), "pa-notes-")));
  profile.initialize();
  const document = profile.change("add working preferences", () =>
    profile.create("Working preferences", "Working rules", "Keep changes focused."),
  );
  const store = new Store(":memory:");
  const assistant = {
    interpret: vi.fn<Assistant["interpret"]>(async (text) => ({
      title: text,
      kind: "note",
      project: "",
      dueDate: null,
      priority: "normal",
      relatedId: null,
      rationale: "Profile context",
      needsClarification: false,
      referenceIds: [],
      prompt: "",
      sources: [],
      updateProfile: text.startsWith("note:"),
    })),
    ask: vi.fn<Assistant["ask"]>(),
    updateProfile: vi.fn<Assistant["updateProfile"]>(async (item, documents) => {
      const current = documents.find((doc) => doc.path === document.path);
      if (!current) throw new Error("Missing preferences");
      return {
        decision: "apply",
        summary: "Added the preference.",
        paths: [document.path],
        changes: [{ path: document.path, content: `${current.content}\n${item.body}\n` }],
      };
    }),
  };
  const app = createApp({
    profile,
    store,
    assistant,
    settings: new SettingsStore({
      ...config,
      dataDir: mkdtempSync(join(tmpdir(), "pa-note-settings-")),
      apiKey: "",
      keyFile: "",
    }),
  });
  cleanup.push(async () => {
    await app.close();
    store.db.close();
  });
  const process = (id: string) =>
    app.inject({ method: "POST", url: `/api/items/${id}/process`, headers });
  const merge = (id: string) =>
    app.inject({
      method: "POST",
      url: `/api/items/${id}/profile`,
      headers,
      payload: { revision: store.get(id)?.revision },
    });
  return { app, profile, document, store, assistant, process, merge };
}

it("automatically incorporates explicit notes and records completion without repeating retries", async () => {
  const { profile, document, store, assistant, process, merge } = setup();
  const note = store.capture("note: agents should make atomic conventional commits");
  await process(note.id);
  expect(store.get(note.id)).toMatchObject({
    status: "done",
    processing: "ready",
    original: note.original,
    profilePath: profile.root,
    sourcePaths: [document.path],
  });
  expect(readFileSync(join(profile.root, document.path), "utf8")).toContain(note.original);
  await process(note.id);
  await merge(note.id);
  expect(assistant.updateProfile).toHaveBeenCalledTimes(1);
  expect(store.history(note.id).length).toBe(2);
});

it("holds implicit notes for user approval and rejects manually marking them done", async () => {
  const { app, store, assistant, process, merge } = setup();
  const note = store.capture("Agents should make atomic conventional commits");
  await process(note.id);
  expect(store.get(note.id)).toMatchObject({ kind: "note", status: "open", processing: "review" });
  expect(assistant.updateProfile).not.toHaveBeenCalled();
  const manual = await app.inject({
    method: "PATCH",
    url: `/api/items/${note.id}`,
    headers,
    payload: { status: "done", revision: store.get(note.id)?.revision },
  });
  expect(manual.statusCode).toBe(400);
  await merge(note.id);
  expect(store.get(note.id)?.status).toBe("done");
});

it("reopens edited incorporated notes without automatically applying the edit", async () => {
  const { app, store, assistant, process } = setup();
  const note = store.capture("note: keep commits atomic");
  await process(note.id);
  const reset = await app.inject({
    method: "POST",
    url: `/api/items/${note.id}/process`,
    headers,
    payload: { resetReferences: true, revision: store.get(note.id)?.revision },
  });
  expect(reset.json()).toMatchObject({ status: "done", processing: "ready" });
  const edited = await app.inject({
    method: "PATCH",
    url: `/api/items/${note.id}`,
    headers,
    payload: {
      body: "note: keep commits atomic and conventional",
      revision: store.get(note.id)?.revision,
    },
  });
  expect(edited.json()).toMatchObject({ status: "open", profilePath: null });
  await app.close();
  expect(assistant.updateProfile).toHaveBeenCalledTimes(1);
  expect(store.get(note.id)).toMatchObject({ status: "open", processing: "review" });
});

it.each(["idea", "commitment", "unclear"])(
  "does not automatically merge %s captures even with an inconsistent authorization flag",
  async (kind) => {
    const { store, assistant, process } = setup();
    assistant.interpret.mockResolvedValue({
      title: "Uncertain",
      kind: kind === "unclear" ? "note" : (kind as "idea" | "commitment"),
      project: "",
      dueDate: null,
      priority: "normal",
      relatedId: null,
      rationale: "Needs consideration",
      needsClarification: kind === "unclear",
      referenceIds: [],
      updateProfile: true,
      prompt: "",
      sources: [],
    });
    const note = store.capture("note: ask Benni tomorrow");
    await process(note.id);
    expect(assistant.updateProfile).not.toHaveBeenCalled();
    expect(store.get(note.id)?.status).toBe("open");
  },
);

it("keeps failed merges pending and allows a successful retry", async () => {
  const { store, assistant, process, merge } = setup();
  assistant.updateProfile.mockRejectedValueOnce(new Error("Provider unavailable"));
  const note = store.capture("note: keep commits atomic");
  await process(note.id);
  expect(store.get(note.id)).toMatchObject({
    status: "open",
    processing: "review",
    profilePath: null,
  });
  expect(store.get(note.id)?.processingError).toContain("Provider unavailable");
  await merge(note.id);
  expect(store.get(note.id)).toMatchObject({ status: "done", processingError: null });
});

it("holds conflicts without applying even changes included in a review response", async () => {
  const { store, profile, document, assistant, process } = setup();
  assistant.updateProfile.mockResolvedValue({
    decision: "review",
    summary: "Which Benni do you mean?",
    paths: [],
    changes: [{ path: document.path, content: "invalid" }],
  });
  const note = store.capture("note: Benni means another person");
  await process(note.id);
  expect(store.get(note.id)).toMatchObject({
    status: "open",
    rationale: "Which Benni do you mean?",
  });
  expect(readFileSync(join(profile.root, document.path), "utf8")).toBe(document.content);
});

it("rejects invalid output before changing any profile document", async () => {
  const { store, profile, document, assistant, process } = setup();
  assistant.updateProfile.mockResolvedValue({
    decision: "apply",
    summary: "Saved",
    paths: [document.path],
    changes: [
      { path: document.path, content: `${document.content}\nNew fact` },
      { path: "broken.md", content: "No frontmatter" },
    ],
  });
  const note = store.capture("note: new fact");
  await process(note.id);
  expect(store.get(note.id)?.status).toBe("open");
  expect(readFileSync(join(profile.root, document.path), "utf8")).toBe(document.content);
});

it("accepts already incorporated knowledge only with an existing concept reference", async () => {
  const { store, document, assistant, process } = setup();
  assistant.updateProfile.mockResolvedValue({
    decision: "apply",
    summary: "Already present.",
    paths: [document.path],
    changes: [],
  });
  const note = store.capture("note: keep changes focused");
  await process(note.id);
  expect(store.get(note.id)?.status).toBe("done");
  assistant.updateProfile.mockResolvedValue({
    decision: "apply",
    summary: "Already present.",
    paths: ["invented.md"],
    changes: [],
  });
  const other = store.capture("note: new fact");
  await process(other.id);
  expect(store.get(other.id)?.status).toBe("open");
});

it.each(["capture", "profile"])("does not overwrite concurrent %s edits", async (target) => {
  const { store, profile, document, assistant, process } = setup();
  let finish = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  assistant.updateProfile.mockImplementationOnce(async () => {
    await gate;
    return {
      decision: "apply",
      summary: "Updated",
      paths: [document.path],
      changes: [{ path: document.path, content: `${document.content}\nStale result` }],
    };
  });
  const note = store.capture("note: keep commits atomic");
  const request = process(note.id);
  await vi.waitFor(() => expect(assistant.updateProfile).toHaveBeenCalled());
  if (target === "capture") store.update(note.id, { body: "Corrected note" }, 1);
  else writeFileSync(join(profile.root, document.path), `${document.content}\nExternal edit`);
  finish();
  await request;
  expect(readFileSync(join(profile.root, document.path), "utf8")).not.toContain("Stale result");
  expect(store.get(note.id)?.status).toBe("open");
});

it("serializes notes so each merge reads the preceding update", async () => {
  const { store, profile, document, assistant, process } = setup();
  let finish = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const implementation = assistant.updateProfile.getMockImplementation();
  if (!implementation) throw new Error("Missing mock implementation");
  assistant.updateProfile.mockImplementationOnce(async (...args) => {
    await gate;
    return implementation(...args);
  });
  const first = store.capture("note: first fact");
  const second = store.capture("note: second fact");
  const requests = [process(first.id), process(second.id)];
  await vi.waitFor(() => expect(assistant.updateProfile).toHaveBeenCalledTimes(1));
  finish();
  await Promise.all(requests);
  expect(assistant.updateProfile).toHaveBeenCalledTimes(2);
  const content = readFileSync(join(profile.root, document.path), "utf8");
  expect(content).toContain(first.original);
  expect(content).toContain(second.original);
});
