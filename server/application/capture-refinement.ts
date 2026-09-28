import { z } from "zod";
import { type Item, refinementSchema } from "../../shared/schema.js";
import { resolveReferences } from "./aliases.js";
import { type AssistantContext, contextSources, type RefinementTool } from "./assistant.js";
import type { createContext } from "./context.js";
import { assertRevision } from "./items.js";
import type { CaptureStorage } from "./ports.js";
import type { createProfileUpdates } from "./profile-updates.js";

export function captureRefinement(
  item: Item,
  store: CaptureStorage,
  context: ReturnType<typeof createContext>,
  notes: ReturnType<typeof createProfileUpdates>,
  resolveRepository: (item: Pick<Item, "project" | "references" | "noProject">) => string | null,
  referencesOnly: boolean,
  guardProfile: () => void,
) {
  const owned = new Map(
    [item, ...store.list().filter((entry) => entry.parentId === item.id)].map((entry) => [
      entry.id,
      entry,
    ]),
  );
  const saved = new Set<string>();
  const created = new Set<string>();
  const evidence = (entry: Item): AssistantContext => {
    const result: AssistantContext = {
      ...context(
        entry.body,
        entry.clarifications.map((answer) => answer.answer).filter(Boolean),
        entry.references,
      ),
      capture: entry,
      linkedCaptures: store
        .list()
        .filter((child) => child.parentId === entry.id || child.id === entry.parentId),
      referencesOnly,
      previousRefinement: {
        prompt: entry.prompt,
        sourcePaths: entry.sourcePaths,
        clarifications: entry.clarifications,
      },
    };
    result.related = result.related.filter((other) => other.id !== entry.id);
    result.commitments = {
      ...result.commitments,
      due: result.commitments.due.filter((other) => other.id !== entry.id),
      suggested: result.commitments.suggested.filter((other) => other.id !== entry.id),
      waiting: result.commitments.waiting.filter((other) => other.id !== entry.id),
    };
    return result;
  };
  const current = (id: string) => {
    guardProfile();
    const expected = owned.get(id);
    if (!expected) throw new Error("Only refine this capture and its linked outcomes.");
    const latest = store.get(id);
    assertRevision(latest, expected.revision);
    assertRevision(store.get(item.id), owned.get(item.id)?.revision ?? item.revision);
    return latest;
  };
  const tool = <T>(
    name: string,
    description: string,
    schema: z.ZodType<T>,
    execute: (input: T) => unknown | Promise<unknown>,
    sources: (data: unknown) => string[] = () => [],
  ): RefinementTool => ({
    name,
    description,
    parameters: z.toJSONSchema(schema),
    async execute(input) {
      const data = await execute(schema.parse(input));
      return { data, sources: sources(data) };
    },
  });
  const tools: RefinementTool[] = [
    tool(
      "search_captures",
      "Search existing captures, tasks, ideas and their refined content. Use an empty query to list captures. Follow offset for more results.",
      z.object({ query: z.string(), offset: z.number().int().nonnegative() }),
      ({ query, offset }) => {
        const matches = store
          .list()
          .filter((entry) =>
            `${entry.title} ${entry.body} ${entry.prompt} ${entry.project}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          );
        return {
          items: matches.slice(offset, offset + 30),
          nextOffset: offset + 30 < matches.length ? offset + 30 : null,
        };
      },
      (data) => (data as { items: Item[] }).items.map((entry) => entry.id),
    ),
    tool(
      "get_capture",
      "Read a capture with its original input, saved answers, revision history and current profile/people/project context. Also use this to inspect linked outcomes before splitting again.",
      z.object({ id: z.string() }),
      ({ id }) => {
        const entry = store.get(id);
        if (!entry) throw new Error("Capture not found.");
        return { ...evidence(entry), history: store.history(id) };
      },
      (data) => contextSources(data as AssistantContext),
    ),
    tool(
      "lookup_context",
      "Look up relevant profile knowledge, people, references and related captures using a focused query.",
      z.object({ query: z.string().min(1) }),
      ({ query }) => context(query),
      (data) => contextSources(data as AssistantContext),
    ),
    tool(
      "create_linked_capture",
      "Split a distinct outcome from the current input. Supply an exact excerpt of the user's current input. Existing outcomes with that excerpt are returned unchanged; inspect linkedCaptures before creating more. Then save its refinement. Do not create speculative tasks or duplicate existing outcomes.",
      z.object({ text: z.string().trim().min(1) }),
      ({ text }) => {
        const parent = current(item.id);
        if (referencesOnly) throw new Error("This run only updates references.");
        if (!parent.body.includes(text))
          throw new Error("Use an exact excerpt of the user's input for the linked outcome.");
        const existing = store
          .list()
          .find((entry) => entry.parentId === item.id && entry.original === text);
        if (existing) return existing;
        const child = store.capture(text, item.id);
        owned.set(child.id, child);
        created.add(child.id);
        return child;
      },
    ),
    tool(
      "save_refinement",
      "Save the useful outcome and any material clarification questions. prompt is the refined task/idea text, or a self-contained implementation prompt only when execution is implementation. Keep project association independent of execution. This does not start implementation or incorporate profile notes.",
      refinementSchema,
      (input) => {
        const previous = current(input.id);
        if (previous.kind === "note" && previous.status === "done")
          throw new Error("This note is already incorporated.");
        const available = evidence(previous);
        if (
          input.referenceIds.some(
            (id) =>
              !available.candidates.some((candidate) => candidate.id === id && candidate.available),
          )
        )
          throw new Error(
            "Choose available reference IDs from get_capture; preserve ambiguous mentions and ask only material questions.",
          );
        if (input.relatedId && (input.relatedId === previous.id || !store.get(input.relatedId)))
          throw new Error("Choose an existing different capture to link.");
        if (input.kind !== "commitment" && (input.execution !== "manual" || input.dueDate))
          throw new Error("Only tasks have implementation mode or deadlines.");
        if (previous.noProject && !input.noProject)
          throw new Error("Respect the user's explicit No project selection.");
        const references = resolveReferences(
          input.referenceIds,
          available.candidates,
          previous.references,
        );
        const {
          id,
          sources,
          referenceIds: _referenceIds,
          clarificationQuestions,
          ...fields
        } = input;
        const updated = store.update(
          id,
          {
            ...(referencesOnly ? {} : fields),
            references,
            repositoryId: resolveRepository({
              ...(referencesOnly ? previous : fields),
              references,
            }),
            rationale: "",
            processing:
              clarificationQuestions.length ||
              (referencesOnly ? previous.kind : input.kind) === "note"
                ? "review"
                : "ready",
            processingError: null,
            sourcePaths: [
              ...new Set([...sources, ...references.map((reference) => reference.source)]),
            ],
            clarifications: [
              ...previous.clarifications
                .filter((entry) => entry.answer)
                .map((entry) => ({
                  ...entry,
                  resolved: !clarificationQuestions.includes(entry.question),
                })),
              ...clarificationQuestions
                .filter(
                  (question) =>
                    !previous.clarifications.some(
                      (entry) => entry.answer && entry.question === question,
                    ),
                )
                .map((question, index) => ({
                  id: `${previous.revision}:${index}`,
                  question,
                  answer: "",
                  resolved: false,
                })),
            ],
          },
          previous.revision,
        );
        owned.set(id, updated);
        saved.add(id);
        return updated;
      },
    ),
    tool(
      "incorporate_note",
      "Incorporate a saved, unambiguous knowledge note into the profile using the profile editing agent. Do not call for ideas, tasks or unresolved questions. Returns actual incorporation status; failures leave the note pending.",
      z.object({ id: z.string() }),
      async ({ id }) => {
        const entry = current(id);
        if (referencesOnly) throw new Error("This run only updates references.");
        if (entry.kind !== "note" || entry.clarifications.some((question) => !question.resolved))
          throw new Error("Save an unambiguous note before incorporating it.");
        await notes.merge(id, entry.revision);
        const updated = store.get(id);
        if (!updated) throw new Error("Capture not found.");
        if (
          updated.status === "archived" ||
          (
            [
              "body",
              "title",
              "prompt",
              "execution",
              "kind",
              "project",
              "noProject",
              "relatedId",
              "dueDate",
              "priority",
            ] as const
          ).some((field) => updated[field] !== entry[field]) ||
          JSON.stringify(updated.clarifications) !== JSON.stringify(entry.clarifications)
        )
          throw new Error("Capture changed during profile incorporation.");
        owned.set(id, updated);
        saved.add(id);
        return updated;
      },
    ),
  ];
  return {
    context: evidence(item),
    tools,
    latest: () => owned.get(item.id) ?? item,
    finish() {
      for (const id of [item.id, ...created]) {
        const entry = current(id);
        if (!saved.has(id)) throw new Error("Refinement ended without saving every outcome.");
        if (
          !referencesOnly &&
          entry.kind === "note" &&
          entry.status !== "done" &&
          !entry.processingError &&
          !entry.rationale &&
          !entry.clarifications.some((question) => !question.resolved)
        )
          throw new Error("The profile note was not incorporated.");
      }
    },
  };
}
