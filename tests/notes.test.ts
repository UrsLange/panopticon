import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { Assistant } from "../server/application/assistant.js";
import { createApp } from "../server/bootstrap.js";
import { config } from "../server/config.js";
import { Profile } from "../server/profile.js";
import { SettingsStore } from "../server/settings.js";
import { Store } from "../server/store.js";
import { type Draft, refinementAgent } from "./refinement-agent.js";

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
  const draft = vi.fn<(text: string) => Promise<Draft>>(async (text) => ({
    title: text,
    kind: "note",
    project: "",
    dueDate: null,
    priority: "normal",
    relatedId: null,

    clarificationQuestions: [],
    referenceIds: [],
    prompt: text,
    sources: [],
  }));
  const assistant = {
    interpret: refinementAgent(draft),
    ask: vi.fn<Assistant["ask"]>(),
    consolidateProfile: vi.fn<Assistant["consolidateProfile"]>(),

    updateProfile: vi.fn<Assistant["updateProfile"]>(async (workspace, tools) => {
      const call = (name: string, input: unknown) => {
        const tool = tools.find((tool) => tool.name === name);
        assert(tool);
        return tool.execute(input);
      };
      const note = JSON.parse(
        (
          (await call("read_file", {
            path: workspace.artifactPaths["note.json"],
            startLine: null,
            endLine: null,
          })) as { content: string }
        ).content,
      );
      const current = (await call("read_file", {
        path: document.path,
        startLine: null,
        endLine: null,
      })) as { content: string };
      await call("write_file", {
        path: document.path,
        content: `${current.content}\n${note.capture.body}\n`,
      });
      await call("commit_profile", {
        summary: "incorporate note",
        body: "Update the relevant profile knowledge using verified evidence.",
      });
      await call("complete_note", { paths: [document.path] });
      return "Added the preference.";
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
  return { app, profile, document, store, assistant, draft, process, merge };
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

it("incorporates clear knowledge without requiring a special prefix", async () => {
  const { store, assistant, process } = setup();
  const note = store.capture("Agents should make atomic conventional commits");
  await process(note.id);
  expect(store.get(note.id)).toMatchObject({ kind: "note", status: "done", processing: "ready" });
  expect(assistant.updateProfile).toHaveBeenCalledTimes(1);
});

it("refines edited incorporated notes and applies the corrected knowledge", async () => {
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
  expect(assistant.updateProfile).toHaveBeenCalledTimes(2);
  expect(store.get(note.id)).toMatchObject({ status: "done", processing: "ready" });
});

it.each(["idea", "commitment", "unclear"])(
  "does not automatically merge %s captures when they are ideas, tasks or ambiguous notes",
  async (kind) => {
    const { store, assistant, draft, process } = setup();
    draft.mockResolvedValue({
      title: "Uncertain",
      kind: kind === "unclear" ? "note" : (kind as "idea" | "commitment"),
      project: "",
      dueDate: null,
      priority: "normal",
      relatedId: null,

      clarificationQuestions: kind === "unclear" ? ["What should be remembered?"] : [],
      referenceIds: [],

      prompt: "Useful refined content",
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

it("keeps clarification requests pending without changing the profile", async () => {
  const { store, profile, document, assistant, process } = setup();
  assistant.updateProfile.mockResolvedValue("Which Benni do you mean?");
  const note = store.capture("note: Benni means another person");
  await process(note.id);
  expect(store.get(note.id)).toMatchObject({
    status: "open",
  });
  expect(readFileSync(join(profile.root, document.path), "utf8")).toBe(document.content);
});

it("keeps uncommitted edits visible and the note pending", async () => {
  const { store, profile, document, assistant, process } = setup();
  assistant.updateProfile.mockImplementation(async (_workspace, tools) => {
    const tool = tools.find((tool) => tool.name === "write_file");
    assert(tool);
    await tool.execute({ path: document.path, content: `${document.content}\nNew fact` });
    return "Saved";
  });
  const note = store.capture("note: new fact");
  await process(note.id);
  expect(store.get(note.id)?.status).toBe("open");
  expect(store.get(note.id)?.processingError).toContain("uncommitted");
  expect(readFileSync(join(profile.root, document.path), "utf8")).toContain("New fact");
});

it("accepts already incorporated knowledge only with an existing concept reference", async () => {
  const { store, document, assistant, process } = setup();
  assistant.updateProfile.mockImplementation(async (_workspace, tools) => {
    const tool = tools.find((tool) => tool.name === "complete_note");
    assert(tool);
    await tool.execute({ paths: [document.path] });
    return "Already present.";
  });
  const note = store.capture("note: keep changes focused");
  await process(note.id);
  expect(store.get(note.id)?.status).toBe("done");
  assistant.updateProfile.mockImplementation(async (_workspace, tools) => {
    const tool = tools.find((tool) => tool.name === "complete_note");
    assert(tool);
    await tool.execute({ paths: ["invented.md"] });
    return "Already present.";
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
  const implementation = assistant.updateProfile.getMockImplementation();
  assert(implementation);
  assistant.updateProfile.mockImplementationOnce(async (...args) => {
    await gate;
    return implementation(...args);
  });
  const note = store.capture("note: keep commits atomic");
  const request = process(note.id);
  await vi.waitFor(() => expect(assistant.updateProfile).toHaveBeenCalled());
  if (target === "capture") store.update(note.id, { body: "Corrected note" }, 1);
  else writeFileSync(join(profile.root, document.path), `${document.content}\nExternal edit`);
  finish();
  await request;
  expect(readFileSync(join(profile.root, document.path), "utf8")).not.toContain(
    "note: keep commits atomic",
  );
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
