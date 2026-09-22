import { expect, it, vi } from "vitest";
import type { Assistant, AssistantContext } from "../server/application/assistant.js";
import { createCaptures } from "../server/application/captures.js";
import { createConversation } from "../server/application/conversation.js";
import { capturedItem, dailyCommitments, revisedItem } from "../server/application/items.js";
import { createModelConnection } from "../server/application/model-connection.js";
import type { CaptureStorage, Message, ProfileNotes } from "../server/application/ports.js";
import { createProfileUpdates } from "../server/application/profile-updates.js";
import type { Item, ProfileDocument } from "../shared/schema.js";

const date = "2026-09-19T12:00:00.000Z";
const context: AssistantContext = {
  today: "2026-09-19",
  candidates: [],
  references: [],
  people: null,
  profile: { directory: [], documents: [] },
  related: [],
  commitments: { date: "2026-09-19", due: [], suggested: [], waiting: [] },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const items = new Map<string, Item>();
  const store: CaptureStorage = {
    get: (id) => items.get(id),
    update(id, changes, revision) {
      const previous = items.get(id);
      if (!previous || previous.revision !== revision) throw new Error("Item changed");
      const next = revisedItem(previous, changes, revision, date);
      items.set(id, next);
      return next;
    },
    capture(text) {
      const item = capturedItem(text, String(items.size), date);
      items.set(item.id, item);
      return item;
    },
    list: () => [...items.values()],
    today: (day) => dailyCommitments([...items.values()], day),
    history: () => [],
  };
  const document: ProfileDocument = {
    path: "preferences.md",
    title: "Preferences",
    type: "Profile",
    description: "",
    content: "Existing knowledge",
    hash: "one",
  };
  const incorporate = vi.fn();
  let profile: ProfileNotes = {
    root: "/profile",
    isGit: () => true,
    documents: () => [document],
    incorporate,
  };
  let discovery = false;
  const assistant: Assistant = {
    interpret: vi.fn<Assistant["interpret"]>(async () => ({
      title: "A note",
      kind: "note",
      project: "",
      dueDate: null,
      priority: "normal",
      relatedId: null,
      rationale: "A preference",
      needsClarification: false,
      updateProfile: false,
      referenceIds: [],
      prompt: "",
      sources: [],
    })),
    updateProfile: vi.fn<Assistant["updateProfile"]>(async () => ({
      decision: "apply",
      summary: "Saved",
      paths: [document.path],
      changes: [],
    })),
    ask: vi.fn(async () => ({ answer: "An answer", sources: [] })),
  };
  const notes = createProfileUpdates({
    store,
    getProfile: () => profile,
    getAssistant: () => assistant,
    timezone: () => "Europe/Berlin",
    discoveryRunning: () => discovery,
  });
  const captures = createCaptures({
    store,
    getAssistant: () => assistant,
    context: () => context,
    notes,
    today: () => context.today,
  });
  const note = (text = "note: keep changes focused") => {
    const item = store.capture(text);
    return store.update(item.id, { kind: "note" }, item.revision);
  };
  return {
    store,
    assistant,
    notes,
    captures,
    note,
    incorporate,
    switchProfile: () => {
      profile = { ...profile, root: "/other" };
    },
    startDiscovery: () => {
      discovery = true;
    },
  };
}

it("serializes profile notes, shares duplicate requests, and only completes after applying", async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<Assistant["updateProfile"]>>>();
  vi.mocked(f.assistant.updateProfile).mockReturnValueOnce(gate.promise);
  const first = f.note(),
    second = f.note("note: another preference");
  const active = f.notes.merge(first.id, first.revision);
  expect(f.notes.merge(first.id, first.revision)).toBe(active);
  const queued = f.notes.merge(second.id, second.revision);
  await Promise.resolve();
  expect(f.assistant.updateProfile).toHaveBeenCalledTimes(1);
  expect(f.store.get(first.id)?.status).toBe("open");
  expect(f.incorporate).not.toHaveBeenCalled();
  gate.resolve({ decision: "apply", summary: "Saved", paths: ["preferences.md"], changes: [] });
  await Promise.all([active, queued]);
  expect(f.incorporate).toHaveBeenCalledTimes(2);
  expect(f.store.list().every((item) => item.status === "done")).toBe(true);
  expect(f.notes.busy()).toBe(false);
});

it.each(["revision", "profile", "discovery"] as const)(
  "rejects an in-flight profile result after %s changes",
  async (change) => {
    const f = fixture();
    const gate = deferred<Awaited<ReturnType<Assistant["updateProfile"]>>>();
    vi.mocked(f.assistant.updateProfile).mockReturnValue(gate.promise);
    const item = f.note();
    const task = f.notes.merge(item.id, item.revision);
    await Promise.resolve();
    if (change === "revision") f.store.update(item.id, { body: "Edited" }, item.revision);
    if (change === "profile") f.switchProfile();
    if (change === "discovery") f.startDiscovery();
    gate.resolve({ decision: "apply", summary: "Saved", paths: ["preferences.md"], changes: [] });
    await task;
    expect(f.incorporate).not.toHaveBeenCalled();
    expect(f.store.get(item.id)?.status).toBe("open");
    if (change === "revision") expect(f.store.get(item.id)?.body).toBe("Edited");
    else expect(f.store.get(item.id)?.processingError).toContain("Profile update failed.");
  },
);

it("keeps review decisions and failed profile writes pending", async () => {
  const f = fixture();
  vi.mocked(f.assistant.updateProfile).mockResolvedValueOnce({
    decision: "review",
    summary: "Which team?",
    paths: [],
    changes: [],
  });
  const first = f.note();
  await f.notes.add(first.id, first.revision);
  expect(f.store.get(first.id)).toMatchObject({
    status: "open",
    processing: "review",
    rationale: "Which team?",
  });
  expect(f.incorporate).not.toHaveBeenCalled();
  f.incorporate.mockImplementation(() => {
    throw new Error("Commit hook rejected the update");
  });
  const second = f.note();
  await f.notes.add(second.id, second.revision);
  expect(f.store.get(second.id)).toMatchObject({
    status: "open",
    processing: "review",
    processingError: "Profile update failed. Commit hook rejected the update",
  });
});

it.each([
  { authorized: false, clarification: false, applied: false },
  { authorized: true, clarification: true, applied: false },
  { authorized: true, clarification: false, applied: true },
])(
  "requires clear note authorization before incorporation: %j",
  async ({ authorized, clarification, applied }) => {
    const f = fixture();
    const base = await f.assistant.interpret("", context);
    vi.mocked(f.assistant.interpret).mockResolvedValue({
      ...base,
      updateProfile: authorized,
      needsClarification: clarification,
    });
    const item = f.captures.capture("An original capture");
    await f.captures.close();
    expect(f.incorporate).toHaveBeenCalledTimes(Number(applied));
    expect(f.store.get(item.id)?.original).toBe("An original capture");
    expect(f.store.get(item.id)?.status).toBe(applied ? "done" : "open");
  },
);

it("does not overwrite a concurrent manual edit with an obsolete interpretation", async () => {
  const f = fixture();
  const result = await f.assistant.interpret("", context);
  const gate = deferred<typeof result>();
  vi.mocked(f.assistant.interpret).mockReturnValue(gate.promise);
  const item = f.captures.capture("Original");
  f.captures.edit(item.id, { title: "Manual title", prompt: "My manual details" }, item.revision);
  gate.resolve(result);
  await f.captures.close();
  expect(f.store.get(item.id)).toMatchObject({
    title: "Manual title",
    prompt: "My manual details",
    original: "Original",
    revision: 1,
    processingError: null,
  });
  expect(f.incorporate).not.toHaveBeenCalled();
});

it("saves researched descriptions and actual sources while retaining the original capture", async () => {
  const f = fixture();
  const base = await f.assistant.interpret("", context);
  vi.mocked(f.assistant.interpret).mockResolvedValue({
    ...base,
    kind: "commitment",
    project: "Activation",
    prompt: "Verify the invitation flow in a browser.",
    sources: ["rules.md", "project:activation/README.md", "ctx:abcdef12"],
    needsClarification: true,
    rationale: "Which release should this target?",
  });
  const item = f.captures.capture("Review onboarding");
  await f.captures.close();
  expect(f.store.get(item.id)).toMatchObject({
    original: "Review onboarding",
    body: "Review onboarding",
    dueDate: null,
    prompt: "Verify the invitation flow in a browser.",
    sourcePaths: ["rules.md", "project:activation/README.md", "ctx:abcdef12"],
    processing: "review",
    rationale: "Which release should this target?",
  });
  const saved = f.store.get(item.id);
  if (!saved) throw new Error("Missing test capture");
  f.captures.edit(saved.id, { prompt: "My reviewed description" }, saved.revision);
  const latest = f.store.get(item.id);
  if (!latest) throw new Error("Missing edited capture");
  await f.captures.retry(latest.id, { resetReferences: true, revision: latest.revision });
  expect(f.store.get(item.id)?.prompt).toBe("My reviewed description");
  expect(f.store.get(item.id)?.sourcePaths).toEqual(saved.sourcePaths);
});

it("does not authorize a profile write during reference-only processing or manual completion", async () => {
  const f = fixture();
  const result = await f.assistant.interpret("", context);
  vi.mocked(f.assistant.interpret).mockResolvedValue({ ...result, updateProfile: true });
  const item = f.note();
  await f.captures.retry(item.id, { resetReferences: true, revision: item.revision });
  expect(f.incorporate).not.toHaveBeenCalled();
  expect(() =>
    f.captures.edit(item.id, { status: "done" }, f.store.get(item.id)?.revision ?? 0),
  ).toThrow("Use Add to profile");
});

it("conversation reads context and writes history only after a successful answer", async () => {
  const f = fixture();
  const messages: Message[] = Array.from({ length: 15 }, (_, id) => ({
    id,
    role: id % 2 ? "assistant" : "user",
    content: String(id),
    sources: [],
  }));
  const contextQuery = vi.fn(() => context);
  const append = vi.fn((role: "user" | "assistant", content: string, sources: string[] = []) => {
    messages.push({ id: messages.length, role, content, sources });
  });
  const conversation = createConversation({
    store: { messages: () => messages, addMessage: append },
    getAssistant: () => f.assistant,
    context: contextQuery,
    searchSessions: async () => "Selected evidence",
  });
  await conversation.ask("Question", "Explicitly shared evidence");
  expect(f.assistant.ask).toHaveBeenCalledWith(
    "Question",
    context,
    expect.any(Array),
    "Explicitly shared evidence",
  );
  expect(vi.mocked(f.assistant.ask).mock.calls[0][2]).toHaveLength(12);
  expect(contextQuery.mock.calls[0]).toEqual(["Question", ["4", "6", "8", "10", "12", "14"]]);
  expect(append).toHaveBeenCalledTimes(2);
  expect(f.incorporate).not.toHaveBeenCalled();
  vi.mocked(f.assistant.ask).mockRejectedValueOnce(new Error("Provider failed"));
  await expect(conversation.ask("Retry", "")).rejects.toThrow("Provider failed");
  expect(append).toHaveBeenCalledTimes(2);
});

it("validates both model operations before saving a connection", async () => {
  const f = fixture();
  const input = { baseURL: "https://model.example/v1", model: "model" };
  const save = vi.fn();
  const models = createModelConnection(
    { credentials: () => ({ ...input, apiKey: "secret" }), saveValidated: save },
    {
      models: async () => ["model"],
      assistant: () => f.assistant,
      validateTools: async () => {},
      errorMessage: () => "Validation failed",
    },
  );
  vi.mocked(f.assistant.ask).mockRejectedValueOnce(new Error("Unsupported"));
  await expect(models.connect(input)).rejects.toThrow("Validation failed");
  expect(save).not.toHaveBeenCalled();
  await models.connect(input);
  expect(save).toHaveBeenCalledWith(input, input.baseURL);
  expect(f.assistant.interpret).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ profile: { documents: [], directory: [] }, people: null }),
  );
});
