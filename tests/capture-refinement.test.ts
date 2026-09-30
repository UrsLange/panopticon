import { afterEach, assert, expect, it, vi } from "vitest";
import type {
  Assistant,
  AssistantContext,
  RefinementTool,
} from "../server/application/assistant.js";
import { createCaptures } from "../server/application/captures.js";
import type { ProfileNotes } from "../server/application/ports.js";
import { createProfileUpdates } from "../server/application/profile-updates.js";
import { Store } from "../server/store.js";
import type { Refinement } from "../shared/schema.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
});
function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  const incorporate = vi.fn<ProfileNotes["incorporate"]>(async () => ({
    decision: "apply" as const,
    summary: "Saved knowledge",
    paths: ["team.md"],
  }));
  const profile = { root: "/profile", isGit: () => true, documents: () => [], incorporate };
  const assistant: Assistant = {
    interpret: vi.fn(),
    updateProfile: vi.fn(),
    consolidateProfile: vi.fn(),
    ask: vi.fn(),
  };
  const context = vi.fn(
    (): AssistantContext => ({
      today: "2026-09-28",
      candidates: [],
      references: [],
      people: null,
      profile: { directory: [], documents: [] },
      related: [],
      commitments: { date: "2026-09-28", due: [], suggested: [], waiting: [] },
    }),
  );
  const notes = createProfileUpdates({
    store,
    getProfile: () => profile,
    getAssistant: () => assistant,
    timezone: () => "UTC",
    discoveryRunning: () => false,
  });
  const captures = createCaptures({
    preferences: () => [],
    store,
    getAssistant: () => assistant,
    getProfileRoot: () => profile.root,
    autoStart: vi.fn(),
    context,
    notes,
    today: () => "2026-09-28",
    resolveRepository: (item) => (item.project === "Portal" ? "portal" : null),
  });
  return { store, assistant, captures, incorporate, context };
}
async function call(tools: RefinementTool[], name: string, input: unknown) {
  const tool = tools.find((tool) => tool.name === name);
  assert(tool);
  return (await tool.execute(input, new AbortController().signal)).data;
}
function outcome(id: string, changes: Partial<Refinement> = {}): Refinement {
  return {
    id,
    title: "Discuss rollout",
    kind: "commitment",
    execution: "manual",
    project: "Portal",
    noProject: false,
    dueDate: null,
    priority: "normal",
    relatedId: null,
    prompt: "Ask Anna about the rollout.",
    sources: [],
    referenceIds: [],
    clarificationQuestions: [],
    ...changes,
  };
}

it("keeps questions in the same session through partial answers and failures, then discards it", async () => {
  const f = setup();
  const states: (string | null | undefined)[] = [];
  vi.mocked(f.assistant.interpret).mockImplementation(
    async (_text, context, tools, continuation) => {
      states.push(continuation?.state);
      const answer = context.capture.clarifications.find((question) => question.answer)?.answer;
      if (answer === "retry") throw new Error("Provider unavailable");
      await call(
        tools,
        "save_refinement",
        outcome(context.capture.id, {
          clarificationQuestions: answer === "Anna Smith" ? [] : ["Which Anna?"],
        }),
      );
      continuation?.save(`session-${states.length}`);
    },
  );
  const item = f.captures.capture("Ask Anna about the rollout");
  await f.captures.close();
  expect(f.store.refinementSession("/profile", item.id)).toBe("session-1");
  await f.captures.retry(item.id, { resetReferences: false });
  expect(f.store.refinementSession("/profile", item.id)).toBe("session-2");
  for (const answer of ["retry", "Anna Smith"]) {
    const current = f.store.get(item.id);
    assert(current);
    f.captures.answer(item.id, {
      revision: current.revision,
      answers: [{ id: current.clarifications[0].id, answer }],
    });
    expect(f.store.refinementSession("/profile", item.id)).toBe("session-2");
    await f.captures.retry(item.id, { resetReferences: false });
  }
  expect(states).toEqual([null, "session-1", "session-2", "session-2"]);
  expect(f.store.get(item.id)?.processing).toBe("ready");
  expect(f.store.refinementSession("/profile", item.id)).toBeNull();
});

it("discards clarification sessions when the user edits the capture", async () => {
  const f = setup();
  const item = f.store.capture("Ask Anna");
  f.store.saveRefinementSession("/profile", item.id, "old session");
  f.captures.edit(item.id, { title: "Ask the team" }, item.revision);
  expect(f.store.refinementSession("/profile", item.id)).toBeNull();
});

it.each(["manual", "implementation"] as const)(
  "saves %s intent independently of project membership",
  async (execution) => {
    const f = setup();
    vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
      await call(tools, "save_refinement", outcome(context.capture?.id ?? "", { execution }));
    });
    const item = f.captures.capture("Ask Anna about the rollout");
    await f.captures.close();
    expect(f.store.get(item.id)).toMatchObject({
      execution,
      project: "Portal",
      noProject: false,
      repositoryId: "portal",
      prompt: "Ask Anna about the rollout.",
      rationale: "",
      processing: "ready",
      original: item.original,
    });
  },
);

it("keeps idea development as useful tentative content", async () => {
  const f = setup();
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    await call(
      tools,
      "save_refinement",
      outcome(context.capture?.id ?? "", {
        kind: "idea",
        project: "",
        prompt: "Try a paired onboarding session as a small experiment.",
      }),
    );
  });
  const item = f.captures.capture("Maybe onboarding could happen in pairs");
  await f.captures.close();
  expect(f.store.get(item.id)).toMatchObject({
    kind: "idea",
    execution: "manual",
    dueDate: null,
    status: "open",
    original: item.original,
    body: item.original,
  });
  expect(f.incorporate).not.toHaveBeenCalled();
});

it("splits tasks and knowledge into linked outcomes and reuses them on retry", async () => {
  const f = setup();
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    const id = context.capture?.id ?? "";
    const child = (await call(tools, "create_linked_capture", {
      text: "Anna owns onboarding",
    })) as { id: string; status: string };
    await call(tools, "save_refinement", outcome(id, { prompt: "Discuss the rollout with Anna." }));
    if (child.status !== "done") {
      await call(
        tools,
        "save_refinement",
        outcome(child.id, { kind: "note", prompt: "Anna owns onboarding." }),
      );
      await call(tools, "incorporate_note", { id: child.id });
    }
  });
  const item = f.captures.capture("Anna owns onboarding; discuss the rollout with her");
  await f.captures.close();
  const child = f.store.list().find((entry) => entry.parentId === item.id);
  assert(child);
  expect(child).toMatchObject({
    original: "Anna owns onboarding",
    kind: "note",
    status: "done",
    profilePath: "/profile",
  });
  expect(f.incorporate.mock.calls[0][0]).toMatchObject({ prompt: "Anna owns onboarding." });
  await f.captures.retry(item.id, {
    resetReferences: false,
    revision: f.store.get(item.id)?.revision,
  });
  expect(f.store.list()).toHaveLength(2);
  expect(f.incorporate).toHaveBeenCalledTimes(1);
  expect(f.store.get(item.id)?.processing).toBe("ready");
});

it("retains saved answers and useful partial work until material questions are resolved", async () => {
  const f = setup();
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    const answer = context.capture.clarifications.find((entry) => entry.answer)?.answer;
    await call(
      tools,
      "save_refinement",
      outcome(context.capture?.id ?? "", {
        prompt: answer
          ? `Discuss the rollout with ${answer}.`
          : "Discuss the rollout; the contact remains unclear.",
        clarificationQuestions: answer ? [] : ["Which Anna?"],
      }),
    );
  });
  const item = f.captures.capture("Discuss rollout with Anna");
  await f.captures.close();
  const waiting = f.store.get(item.id);
  assert(waiting);
  expect(waiting.processing).toBe("review");
  const answered = f.captures.answer(item.id, {
    revision: waiting.revision,
    answers: [{ id: waiting.clarifications[0].id, answer: "Anna Smith" }],
  });
  await f.captures.retry(item.id, { revision: answered.revision, resetReferences: false });
  expect(f.store.get(item.id)).toMatchObject({
    processing: "ready",
    prompt: "Discuss the rollout with Anna Smith.",
    clarifications: [{ answer: "Anna Smith", resolved: true }],
  });
});

it("rejects a success message without saved outcomes", async () => {
  const f = setup();
  vi.mocked(f.assistant.interpret).mockResolvedValue();
  const item = f.captures.capture("A task");
  await f.captures.close();
  expect(f.store.get(item.id)).toMatchObject({ processing: "pending", original: "A task" });
  expect(f.store.get(item.id)?.processingError).toBeTruthy();
});

it("does not overwrite user changes between tool calls", async () => {
  const f = setup();
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    const id = context.capture?.id ?? "";
    await call(tools, "save_refinement", outcome(id));
    const saved = f.store.get(id);
    assert(saved);
    f.store.update(id, { prompt: "User correction" }, saved.revision);
    await call(tools, "save_refinement", outcome(id, { prompt: "Stale replacement" }));
  });
  const item = f.captures.capture("A task");
  await f.captures.close();
  expect(f.store.get(item.id)?.prompt).toBe("User correction");
});

it("searches captures and retrieves original input, answers and history", async () => {
  const f = setup();
  const previous = f.store.capture("Earlier rollout decision");
  f.store.update(previous.id, { prompt: "Keep the pilot small" }, previous.revision);
  let found: unknown, read: unknown;
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    found = await call(tools, "search_captures", { query: "pilot", offset: 0 });
    read = await call(tools, "get_capture", { id: previous.id });
    expect(read).not.toHaveProperty("history");
    expect(await call(tools, "read_capture_history", { id: previous.id, offset: 0 })).toMatchObject(
      { history: [{ item: { prompt: "" } }] },
    );
    await call(
      tools,
      "save_refinement",
      outcome(context.capture?.id ?? "", { sources: [previous.id] }),
    );
  });
  const item = f.captures.capture("Discuss rollout");
  await f.captures.close();
  expect(found).toMatchObject({ items: [{ id: previous.id, excerpt: "Keep the pilot small" }] });
  expect(read).toMatchObject({
    capture: { original: "Earlier rollout decision" },
  });
  expect(f.store.get(item.id)?.sourcePaths).toEqual([previous.id]);
});

it("refines a self-contained capture without loading profile or people context", async () => {
  const f = setup();
  f.context.mockImplementation(() => {
    throw new Error("Profile unavailable");
  });
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    expect(Object.keys(context).sort()).toEqual([
      "capture",
      "linkedCaptures",
      "preferences",
      "referencesOnly",
      "today",
    ]);
    await call(
      tools,
      "save_refinement",
      outcome(context.capture.id, { project: "", prompt: "Buy milk." }),
    );
  });
  const item = f.captures.capture("Buy milk");
  await f.captures.close();
  expect(f.store.get(item.id)).toMatchObject({
    original: item.original,
    processing: "ready",
    processingError: null,
  });
  expect(f.context).not.toHaveBeenCalled();
});

it("saves material questions returned by profile incorporation for the next refinement", async () => {
  const f = setup();
  f.incorporate.mockResolvedValue({
    decision: "review",
    summary: "Which team owns the rollout?",
    paths: [],
  });
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    const id = context.capture?.id ?? "";
    const draft = outcome(id, { kind: "note", prompt: "The team owns the rollout." });
    await call(tools, "save_refinement", draft);
    const result = (await call(tools, "incorporate_note", { id })) as { rationale: string };
    await call(tools, "save_refinement", { ...draft, clarificationQuestions: [result.rationale] });
  });
  const item = f.captures.capture("The team owns the rollout.");
  await f.captures.close();
  expect(f.store.get(item.id)).toMatchObject({
    processing: "review",
    status: "open",
    processingError: null,
    clarifications: [{ question: "Which team owns the rollout?", answer: "", resolved: false }],
  });
});

it("retrieves focused people context without repeating profile contents or commitments", async () => {
  const f = setup();
  const base = f.context();
  f.context.mockClear();
  f.context.mockReturnValue({
    ...base,
    profile: {
      directory: [],
      documents: [{ path: "team.md", content: "Large private profile content" }],
    },
  });
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    expect(f.context).not.toHaveBeenCalled();
    expect(await call(tools, "lookup_people", { query: "Anna" })).toEqual({
      people: null,
      profileDocuments: ["team.md"],
    });
    const references = await call(tools, "get_reference_candidates", { id: context.capture.id });
    expect(references).toEqual({
      candidates: [],
      references: [],
      people: null,
      profileDocuments: ["team.md"],
    });
    const saved = await call(tools, "save_refinement", outcome(context.capture.id));
    expect(saved).not.toHaveProperty("prompt");
    expect(saved).not.toHaveProperty("body");
  });
  f.captures.capture("Ask Anna about the rollout");
  await f.captures.close();
  expect(f.context).toHaveBeenCalledTimes(2);
});

it("does not absorb a concurrent manual edit into the agent's writable snapshot during incorporation", async () => {
  const f = setup();
  let id = "";
  f.incorporate.mockImplementation(async () => {
    const current = f.store.get(id);
    assert(current);
    f.store.update(id, { prompt: "The user's corrected knowledge" }, current.revision);
    return { decision: "apply", summary: "Saved", paths: ["team.md"] };
  });
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    id = context.capture?.id ?? "";
    const draft = outcome(id, { kind: "note" });
    await call(tools, "save_refinement", draft);
    await expect(call(tools, "incorporate_note", { id })).rejects.toThrow("Capture changed");
    await expect(call(tools, "save_refinement", draft)).rejects.toThrow();
  });
  const item = f.captures.capture("My team owns the rollout.");
  await f.captures.close();
  expect(f.store.get(item.id)?.prompt).toBe("The user's corrected knowledge");
});

it("rejects completion until every new outcome is saved and profile notes are handled", async () => {
  const f = setup();
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    await expect(call(tools, "complete_refinement", {})).rejects.toThrow("saving every outcome");
    const child = (await call(tools, "create_linked_capture", {
      text: "Anna owns onboarding",
    })) as { id: string };
    await call(tools, "save_refinement", outcome(context.capture.id));
    await expect(call(tools, "complete_refinement", {})).rejects.toThrow("saving every outcome");
    await call(tools, "save_refinement", outcome(child.id, { kind: "note" }));
    await expect(call(tools, "complete_refinement", {})).rejects.toThrow("not incorporated");
    await call(tools, "incorporate_note", { id: child.id });
    expect(await call(tools, "complete_refinement", {})).toEqual({ completed: true });
  });
  const item = f.captures.capture("Anna owns onboarding; discuss the rollout with her");
  await f.captures.close();
  expect(f.store.get(item.id)?.processing).toBe("ready");
});

it("requires unfinished linked outcomes from an earlier attempt to be saved on retry", async () => {
  const f = setup();
  const item = f.store.capture("Discuss rollout; ask Anna about onboarding");
  const child = f.store.capture("ask Anna about onboarding", item.id);
  vi.mocked(f.assistant.interpret).mockImplementation(async (_text, context, tools) => {
    expect(context.linkedCaptures).toContainEqual(
      expect.objectContaining({ id: child.id, processing: "pending" }),
    );
    await call(tools, "save_refinement", outcome(item.id));
    await expect(call(tools, "complete_refinement", {})).rejects.toThrow("saving every outcome");
    await call(tools, "save_refinement", outcome(child.id));
    await call(tools, "complete_refinement", {});
  });
  await f.captures.retry(item.id, { resetReferences: false, revision: item.revision });
  expect(f.store.list().every((entry) => entry.processing === "ready")).toBe(true);
});
