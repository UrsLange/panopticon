import { assert, expect, it, vi } from "vitest";
import type {
  Assistant,
  AssistantContext,
  RefinementContext,
} from "../server/application/assistant.js";
import { createCaptures } from "../server/application/captures.js";
import { createConversation } from "../server/application/conversation.js";
import { resolveImplementationRepository } from "../server/application/implementation-repository.js";
import { capturedItem, dailyCommitments, revisedItem } from "../server/application/items.js";
import { createModelConnection } from "../server/application/model-connection.js";
import type { CaptureStorage, Message, ProfileNotes } from "../server/application/ports.js";
import { createProfileUpdates } from "../server/application/profile-updates.js";
import type { Item, ProfileDocument } from "../shared/schema.js";
import { type Draft, refinementAgent } from "./refinement-agent.js";

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
    refinementSession: () => null,
    saveRefinementSession: vi.fn(),
    recordProfileActivity: vi.fn(),
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
  const incorporate = vi.fn<ProfileNotes["incorporate"]>(async (_item, _date, agent, guard) => {
    const summary = await agent({ profileRoot: "/profile", artifactPaths: {} }, []);
    guard();
    return {
      decision: summary === "Which team?" ? "review" : "apply",
      summary,
      paths: [document.path],
    };
  });
  let profile: ProfileNotes = {
    root: "/profile",
    isGit: () => true,
    documents: () => [document],
    incorporate,
  };
  let discovery = false;
  const draft = vi.fn<
    (text: string, context: AssistantContext | RefinementContext) => Promise<Draft>
  >(async () => ({
    title: "A note",
    kind: "note",
    project: "",
    dueDate: null,
    priority: "normal",
    relatedId: null,

    clarificationQuestions: [],

    referenceIds: [],
    prompt: "A useful note",
    sources: [],
  }));
  const assistant: Assistant = {
    consolidateProfile: vi.fn(),
    interpret: refinementAgent(draft),
    updateProfile: vi.fn<Assistant["updateProfile"]>(async () => "Saved"),

    ask: vi.fn(async () => ({ answer: "An answer", sources: [] })),
  };
  const notes = createProfileUpdates({
    store,
    getProfile: () => profile,
    getAssistant: () => assistant,
    timezone: () => "Europe/Berlin",
    discoveryRunning: () => discovery,
  });
  const contextQuery = vi.fn(() => context);
  const captures = createCaptures({
    preferences: () => [],
    store,
    getProfileRoot: () => profile.root,
    getAssistant: () => assistant,
    context: contextQuery,
    autoStart: vi.fn(async () => {}),
    notes,
    today: () => context.today,
    resolveRepository: (item) =>
      resolveImplementationRepository(
        item,
        [
          { id: "activation", name: "Activation", path: "/repos/activation", document: null },
          { id: "portal", name: "Portal", path: "/repos/portal", document: null },
        ],
        [],
      ),
  });
  const note = (text = "note: keep changes focused") => {
    const item = store.capture(text);
    return store.update(item.id, { kind: "note" }, item.revision);
  };
  return {
    store,
    assistant,
    draft,
    notes,
    captures,
    contextQuery,
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

it("records original user evidence and clarification answers without treating model refinements as observations", async () => {
  const f = fixture();
  const capture = f.captures.capture("Prepare the partner briefing.");
  await f.captures.close();
  expect(f.store.recordProfileActivity).toHaveBeenCalledTimes(1);
  expect(f.store.recordProfileActivity).toHaveBeenCalledWith("/profile", "capture", {
    itemId: capture.id,
    text: "Prepare the partner briefing.",
  });
  const item = f.store.get(capture.id);
  assert(item);
  const question = f.store.update(
    item.id,
    {
      clarifications: [
        { id: "owner", question: "Who owns partner enablement?", answer: "", resolved: false },
      ],
    },
    item.revision,
  );
  f.captures.answer(item.id, {
    revision: question.revision,
    answers: [{ id: "owner", answer: "My team." }],
  });
  expect(f.store.recordProfileActivity).toHaveBeenLastCalledWith("/profile", "clarification", {
    itemId: item.id,
    originalCapture: item.original,
    answers: [{ question: "Who owns partner enablement?", answer: "My team." }],
  });
  const answered = f.store.get(item.id);
  assert(answered);
  f.captures.edit(item.id, { body: "Prepare next quarter's partner briefing." }, answered.revision);
  await f.captures.close();
  expect(f.store.recordProfileActivity).toHaveBeenCalledTimes(3);
  expect(f.store.recordProfileActivity).toHaveBeenLastCalledWith("/profile", "edit", {
    itemId: item.id,
    originalCapture: item.original,
    changes: { body: "Prepare next quarter's partner briefing." },
  });
});

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
  expect(f.incorporate).toHaveBeenCalledTimes(1);
  gate.resolve("Saved");
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
    gate.resolve("Saved");
    await task;
    expect(f.incorporate).toHaveBeenCalledTimes(1);
    expect(f.store.get(item.id)?.status).toBe("open");
    if (change === "revision") expect(f.store.get(item.id)?.body).toBe("Edited");
    else expect(f.store.get(item.id)?.processingError).toContain("Profile update failed.");
  },
);

it("keeps review decisions and failed profile writes pending", async () => {
  const f = fixture();
  vi.mocked(f.assistant.updateProfile).mockResolvedValueOnce("Which team?");
  const first = f.note();
  await f.notes.add(first.id, first.revision);
  expect(f.store.get(first.id)).toMatchObject({
    status: "open",
    processing: "review",
  });
  expect(f.incorporate).toHaveBeenCalledTimes(1);
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

it.each([false, true])(
  "incorporates knowledge directly unless clarification is needed: %s",
  async (clarification) => {
    const f = fixture();
    f.draft.mockResolvedValue({
      kind: "note",
      prompt: "A scoped preference",
      clarificationQuestions: clarification ? ["Which team?"] : [],
    });
    const item = f.captures.capture("A scoped preference");
    await f.captures.close();
    expect(f.incorporate).toHaveBeenCalledTimes(clarification ? 0 : 1);
    expect(f.store.get(item.id)?.original).toBe("A scoped preference");
    expect(f.store.get(item.id)?.status).toBe(clarification ? "open" : "done");
  },
);

it("does not overwrite a concurrent manual edit with an obsolete interpretation", async () => {
  const f = fixture();
  const result = await f.draft("", context);
  const gate = deferred<typeof result>();
  vi.mocked(f.draft).mockReturnValue(gate.promise);
  const item = f.captures.capture("Original");
  f.store.update(item.id, { title: "Manual title", prompt: "My manual details" }, item.revision);
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

it("saves researched prompts and actual sources while retaining the original capture", async () => {
  const f = fixture();
  const base = await f.draft("", context);
  vi.mocked(f.draft).mockResolvedValue({
    ...base,
    kind: "commitment",
    project: "Activation",
    prompt: "Verify the invitation flow in a browser.",
    sources: ["rules.md", "project:activation/README.md", "ctx:abcdef12"],

    clarificationQuestions: ["Which release should this target?"],
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

it("persists the refined repository and clears or replaces it when the project changes", async () => {
  const f = fixture();
  const base = await f.draft("", context);
  vi.mocked(f.draft).mockResolvedValue({
    ...base,
    kind: "commitment",
    project: "Activation",
    prompt: "Implement activation",
  });
  const item = f.captures.capture("Implement activation");
  await f.captures.close();
  const saved = f.store.get(item.id);
  assert(saved);
  expect(saved.repositoryId).toBe("activation");
  const edited = f.captures.edit(item.id, { project: "Portal" }, saved.revision);
  expect(edited.repositoryId).toBe("portal");
  const unresolved = f.captures.edit(item.id, { project: "Unknown" }, edited.revision);
  expect(unresolved.repositoryId).toBeNull();
  const pending = f.captures.edit(item.id, { body: "A different task" }, unresolved.revision);
  expect(pending.repositoryId).toBeNull();
  await f.captures.close();
  expect(f.store.get(item.id)?.repositoryId).toBe("activation");
});

it("regenerates the full interpretation after input edits but preserves prompt-only edits", async () => {
  const f = fixture();
  const base = await f.draft("", context);
  vi.mocked(f.draft).mockResolvedValue({
    ...base,
    kind: "commitment",
    title: "Original task",
    prompt: "Original prompt",
  });
  const item = f.captures.capture("Original input");
  await f.captures.close();
  const before = f.store.get(item.id);
  assert(before);
  f.contextQuery.mockReturnValue({
    ...context,
    related: [before],
    commitments: { ...context.commitments, due: [before], suggested: [before], waiting: [before] },
  });
  const gate = deferred<typeof base>();
  vi.mocked(f.draft).mockReturnValueOnce(gate.promise);
  f.captures.edit(item.id, { body: "Updated input" }, before.revision);
  expect(f.store.get(item.id)).toMatchObject({ processing: "pending", prompt: "Original prompt" });
  gate.resolve({
    ...base,
    kind: "commitment",
    title: "Updated task",
    prompt: "Implement updated input",
    sources: ["ctx:new"],
  });
  await f.captures.close();
  const updated = f.store.get(item.id);
  assert(updated);
  expect(updated).toMatchObject({
    original: "Original input",
    body: "Updated input",
    title: "Updated task",
    prompt: "Implement updated input",
    sourcePaths: ["ctx:new"],
    processing: "ready",
  });
  expect(f.draft).toHaveBeenLastCalledWith("Updated input", expect.anything());
  expect(vi.mocked(f.draft).mock.lastCall?.[1]).not.toHaveProperty("related");
  expect(vi.mocked(f.draft).mock.lastCall?.[1]).not.toHaveProperty("commitments");
  vi.mocked(f.draft).mockClear();
  f.captures.edit(item.id, { prompt: "My reviewed prompt" }, updated.revision);
  await f.captures.close();
  expect(f.store.get(item.id)?.prompt).toBe("My reviewed prompt");
  expect(f.draft).not.toHaveBeenCalled();
});

it("preserves a deliberate no-project choice through refinement and allows reassignment", async () => {
  const f = fixture();
  const base = await f.draft("", context);
  vi.mocked(f.draft).mockResolvedValue({
    ...base,
    kind: "commitment",
    project: "Activation",
    prompt: "Ask Anna about activation",
  });
  const item = f.captures.capture("Ask Anna about activation");
  await f.captures.close();
  const saved = f.store.get(item.id);
  assert(saved);
  const outside = f.captures.edit(item.id, { noProject: true }, saved.revision);
  expect(outside).toMatchObject({ noProject: true, project: "", repositoryId: null });
  for (const resetReferences of [false, true]) {
    const current = f.store.get(item.id);
    assert(current);
    await f.captures.retry(item.id, { resetReferences, revision: current.revision });
    expect(f.store.get(item.id)).toMatchObject({
      noProject: true,
      project: "",
      repositoryId: null,
    });
  }
  const current = f.store.get(item.id);
  assert(current);
  f.captures.edit(item.id, { body: "Ask Anna tomorrow" }, current.revision);
  await f.captures.close();
  const refined = f.store.get(item.id);
  assert(refined);
  expect(refined).toMatchObject({ noProject: true, project: "", repositoryId: null });
  expect(
    f.captures.edit(item.id, { noProject: false, project: "Portal" }, refined.revision),
  ).toMatchObject({ noProject: false, project: "Portal", repositoryId: "portal" });
});

it("regenerates only the latest input when it changes during refinement", async () => {
  const f = fixture();
  const base = await f.draft("", context);
  const gate = deferred<typeof base>();
  vi.mocked(f.draft)
    .mockClear()
    .mockReturnValueOnce(gate.promise)
    .mockResolvedValue({
      ...base,
      kind: "commitment",
      prompt: "Latest prompt",
    });
  const item = f.captures.capture("Original input");
  const first = f.captures.edit(item.id, { body: "Intermediate input" }, item.revision);
  f.captures.edit(item.id, { body: "Latest input" }, first.revision);
  gate.resolve({ ...base, prompt: "Obsolete prompt" });
  await f.captures.close();
  expect(f.store.get(item.id)).toMatchObject({
    body: "Latest input",
    prompt: "Latest prompt",
    processing: "ready",
    original: "Original input",
  });
  expect(vi.mocked(f.draft).mock.calls.map(([input]) => input)).toEqual([
    "Original input",
    "Latest input",
  ]);
});

it("marks explicit regeneration pending and preserves the previous prompt on failure", async () => {
  const f = fixture();
  const base = await f.draft("", context);
  const item = f.store.capture("Input");
  const saved = f.store.update(
    item.id,
    { kind: "commitment", prompt: "Previous prompt", processing: "ready" },
    item.revision,
  );
  const gate = deferred<typeof base>();
  vi.mocked(f.draft).mockReturnValueOnce(gate.promise);
  const retry = f.captures.retry(item.id, { resetReferences: false, revision: saved.revision });
  expect(f.store.get(item.id)?.processing).toBe("pending");
  gate.resolve({ ...base, kind: "commitment", prompt: "Regenerated prompt" });
  await retry;
  const latest = f.store.get(item.id);
  assert(latest);
  expect(latest.prompt).toBe("Regenerated prompt");
  const error = new Error("Unavailable");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(f.draft).mockRejectedValueOnce(error);
  await f.captures.retry(item.id, { resetReferences: false, revision: latest.revision });
  expect(f.store.get(item.id)).toMatchObject({
    prompt: "Regenerated prompt",
    processing: "pending",
    processingError: "Interpretation failed. Unavailable",
  });
  expect(log).toHaveBeenCalledWith("Capture refinement failed", { itemId: item.id, error });
  log.mockRestore();
});

it("exposes live refinement state and rejects duplicate refinement requests", async () => {
  const f = fixture();
  const base = await f.draft("", context);
  const gate = deferred<typeof base>();
  vi.mocked(f.draft).mockClear().mockReturnValueOnce(gate.promise);
  const item = f.captures.capture("Implement access");
  expect(item.refinement).toBe("running");
  expect(f.captures.list()[0].refinement).toBe("running");
  expect(() => f.captures.markRefined(item.id, item.revision)).toThrow("Wait for refinement");
  for (const resetReferences of [false, true]) {
    await expect(
      f.captures.retry(item.id, { resetReferences, revision: item.revision }),
    ).rejects.toThrow("Refinement is already running");
  }
  expect(() => f.captures.edit(item.id, { title: "Edited" }, item.revision)).toThrow(
    "Refinement is running",
  );
  gate.resolve({ ...base, kind: "commitment", prompt: "Implement access" });
  await f.captures.close();
  expect(f.captures.list()[0].refinement).toBe("ready");
  expect(f.draft).toHaveBeenCalledTimes(1);
});

it("retains interview answers across partial rounds and failed refinements", async () => {
  const f = fixture();
  const base = await f.draft("", context);
  vi.mocked(f.draft).mockResolvedValue({
    ...base,
    kind: "idea",
    prompt: "Plan the demo.",

    clarificationQuestions: ["Which project?", "Which Benjamin?"],
  });
  const item = f.captures.capture("Plan a demo with Benjamin");
  await f.captures.close();
  let current = f.captures.list()[0];
  expect(current.clarifications.map((entry) => entry.question)).toEqual([
    "Which project?",
    "Which Benjamin?",
  ]);
  const first = current.clarifications[0];
  expect(() =>
    f.captures.answer(item.id, { revision: 0, answers: [{ id: first.id, answer: "Portal" }] }),
  ).toThrow("changed");
  expect(() =>
    f.captures.answer(item.id, {
      revision: current.revision,
      answers: [{ id: "unknown", answer: "Portal" }],
    }),
  ).toThrow("questions have changed");
  current = f.captures.answer(item.id, {
    revision: current.revision,
    answers: [{ id: first.id, answer: "Portal" }],
  });
  vi.mocked(f.draft).mockRejectedValueOnce(new Error("Offline"));
  await f.captures.retry(item.id, { revision: current.revision, resetReferences: false });
  current = f.captures.list()[0];
  expect(current.clarifications[0].answer).toBe("Portal");
  expect(current.refinement).toBe("failed");
  vi.mocked(f.draft).mockResolvedValueOnce({
    ...base,
    kind: "idea",
    prompt: "Plan the Portal demo.",

    clarificationQuestions: ["Which Benjamin?"],
  });
  await f.captures.retry(item.id, { revision: current.revision, resetReferences: false });
  expect(f.draft).toHaveBeenLastCalledWith(
    item.body,
    expect.objectContaining({
      capture: expect.objectContaining({
        prompt: "Plan the demo.",
        clarifications: expect.arrayContaining([expect.objectContaining({ answer: "Portal" })]),
      }),
    }),
  );
  current = f.captures.list()[0];
  expect(current.clarifications[0]).toMatchObject({
    question: "Which project?",
    answer: "Portal",
    resolved: true,
  });
  const next = current.clarifications.find((entry) => !entry.resolved);
  assert(next);
  current = f.captures.answer(item.id, {
    revision: current.revision,
    answers: [{ id: next.id, answer: "Benjamin from Design" }],
  });
  vi.mocked(f.draft).mockResolvedValueOnce({
    ...base,
    kind: "idea",
    prompt: "Plan the Portal demo with Benjamin from Design.",
  });
  await f.captures.retry(item.id, { revision: current.revision, resetReferences: false });
  current = f.captures.list()[0];
  expect(current.refinement).toBe("ready");
  expect(current.body).toBe(item.body);
  expect(current.clarifications.map((entry) => entry.answer)).toEqual([
    "Portal",
    "Benjamin from Design",
  ]);
  expect(current.clarifications.every((entry) => entry.resolved)).toBe(true);
});

it("distinguishes paused and failed refinement and retains blockers after metadata edits", () => {
  const f = fixture();
  const item = f.store.capture("Add access");
  expect(f.captures.list()[0].refinement).toBe("paused");
  const failed = f.store.update(
    item.id,
    { kind: "commitment", processingError: "Model unavailable", prompt: "Previous prompt" },
    item.revision,
  );
  const edited = f.captures.edit(item.id, { priority: "high" }, failed.revision);
  expect(edited).toMatchObject({
    refinement: "failed",
    processing: "pending",
    processingError: "Model unavailable",
  });
  const review = f.store.update(
    item.id,
    { processing: "review", processingError: null, rationale: "Which access category?" },
    edited.revision,
  );
  expect(f.captures.edit(item.id, { title: "Renamed task" }, review.revision)).toMatchObject({
    refinement: "review",
  });
});

it("does not authorize a profile write during reference-only processing or manual completion", async () => {
  const f = fixture();
  const result = await f.draft("", context);
  vi.mocked(f.draft).mockResolvedValue({ ...result });
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
    store: {
      messages: () => messages,
      addMessage: append,
      recordProfileActivity: f.store.recordProfileActivity,
      profileConversation: () => [],
    },
    getProfileRoot: () => "/profile",
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
  expect(f.draft).not.toHaveBeenCalled();
  expect(f.assistant.ask).toHaveBeenCalled();
});
