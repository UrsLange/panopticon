import { z } from "zod";
import { type Item, refinementSchema } from "../../shared/schema.js";
import { resolveReferences } from "./aliases.js";
import { ctxAssessmentSchema, type RefinementContext, type RefinementTool } from "./assistant.js";
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
  today: string,
  preferences: RefinementContext["preferences"],
) {
  const owned = new Map(
    [item, ...store.list().filter((entry) => entry.parentId === item.id)].map((entry) => [
      entry.id,
      entry,
    ]),
  );
  const saved = new Set<string>();
  const linked = (entry: Item) =>
    store
      .list()
      .filter((child) => child.parentId === entry.id || child.id === entry.parentId)
      .map(({ id, original, title, kind, status, processing, parentId }) => ({
        id,
        original,
        title,
        kind,
        status,
        processing,
        parentId,
      }));
  const referenceEvidence = (entry: Item) => {
    const { candidates, people, profile } = context(
      entry.body,
      entry.clarifications.map((answer) => answer.answer).filter(Boolean),
      entry.references,
    );
    return {
      candidates,
      references: entry.references,
      people,
      profileDocuments: profile.documents.map(({ path }) => path),
    };
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
    readOnly: boolean,
    schema: z.ZodType<T>,
    execute: (input: T) => unknown | Promise<unknown>,
    sources: (data: unknown) => string[] = () => [],
  ): RefinementTool => ({
    name,
    description,
    readOnly,
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
      true,
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
          items: matches
            .slice(offset, offset + 30)
            .map(({ id, title, kind, status, project, parentId, prompt, body }) => ({
              id,
              title,
              kind,
              status,
              project,
              parentId,
              excerpt: (prompt || body).slice(0, 500),
            })),
          nextOffset: offset + 30 < matches.length ? offset + 30 : null,
        };
      },
      (data) => (data as { items: Item[] }).items.map((entry) => entry.id),
    ),
    tool(
      "get_capture",
      "Read a capture's original input, refined content, saved answers and explicit selections. Includes summaries of linked outcomes. Does not reload other context or revision history.",
      true,
      z.object({ id: z.string() }),
      ({ id }) => {
        const entry = store.get(id);
        if (!entry) throw new Error("Capture not found.");
        return { capture: entry, linkedCaptures: linked(entry) };
      },
      (data) => [(data as { capture: Item }).capture.id],
    ),
    tool(
      "read_capture_history",
      "Read earlier capture revisions when the current capture and saved answers are insufficient. Newest revisions first; follow nextOffset as needed.",
      true,
      z.object({ id: z.string(), offset: z.number().int().nonnegative() }),
      ({ id, offset }) => {
        if (!store.get(id)) throw new Error("Capture not found.");
        const history = store.history(id);
        return {
          id,
          history: history.slice(offset, offset + 5),
          nextOffset: offset + 5 < history.length ? offset + 5 : null,
        };
      },
      (data) => [(data as { id: string }).id],
    ),
    tool(
      "get_reference_candidates",
      "Inspect alias and identity candidates for mentions in a capture, including Entra relationships and existing resolved references. Use candidate IDs from this tool when attaching new references to that capture. Suggested profile document paths are pointers, not their contents.",
      true,
      z.object({ id: z.string() }),
      ({ id }) => {
        const entry = store.get(id);
        if (!entry) throw new Error("Capture not found.");
        return referenceEvidence(entry);
      },
      (data) => {
        const result = data as ReturnType<typeof referenceEvidence>;
        return [
          ...result.candidates.map((candidate) => candidate.source),
          ...result.references.map((reference) => reference.source),
          ...(result.people ? [result.people.source] : []),
        ];
      },
    ),
    tool(
      "lookup_people",
      "Find people and their organizational relationships in the synced Entra directory using a name, email or focused query. Suggested profile document paths can provide additional personal context through read_file. To attach references, use get_reference_candidates for the capture.",
      true,
      z.object({ query: z.string().min(1) }),
      ({ query }) => {
        const { people, profile } = context(query);
        return { people, profileDocuments: profile.documents.map(({ path }) => path) };
      },
      (data) => {
        const { people } = data as { people: ReturnType<typeof context>["people"] };
        return people ? [people.source] : [];
      },
    ),
    tool(
      "create_linked_capture",
      "Split a distinct outcome from the current input. Supply an exact excerpt of the user's current input. Existing outcomes with that excerpt are returned unchanged; inspect linkedCaptures before creating more. Then save its refinement. Do not create speculative tasks or duplicate existing outcomes.",
      false,
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
        return child;
      },
    ),
    tool(
      "save_refinement",
      "Save what the user means and any material clarification questions. prompt is a clear task or idea description, or a concise statement of the intended result for an implementation agent in the identified project. Do not investigate or prescribe implementation details. This does not start implementation or incorporate profile notes.",
      false,
      refinementSchema,
      (input) => {
        const previous = current(input.id);
        if (previous.kind === "note" && previous.status === "done")
          throw new Error("This note is already incorporated.");
        const candidates = input.referenceIds.length ? referenceEvidence(previous).candidates : [];
        if (
          input.referenceIds.some(
            (id) => !candidates.some((candidate) => candidate.id === id && candidate.available),
          )
        )
          throw new Error(
            "Choose available reference IDs from get_reference_candidates for this capture; preserve ambiguous mentions and ask only material questions.",
          );
        if (input.relatedId && (input.relatedId === previous.id || !store.get(input.relatedId)))
          throw new Error("Choose an existing different capture to link.");
        if (input.kind !== "commitment" && (input.execution !== "manual" || input.dueDate))
          throw new Error("Only tasks have implementation mode or deadlines.");
        if (previous.noProject && !input.noProject)
          throw new Error("Respect the user's explicit No project selection.");
        const references = resolveReferences(input.referenceIds, candidates, previous.references);
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
            autoStartError: null,
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
        return {
          id: updated.id,
          revision: updated.revision,
          kind: updated.kind,
          processing: updated.processing,
          clarifications: updated.clarifications,
        };
      },
    ),
    tool(
      "incorporate_note",
      "Incorporate a saved, unambiguous knowledge note into the profile using the profile editing agent. Do not call for ideas, tasks or unresolved questions. Returns actual incorporation status; failures leave the note pending.",
      false,
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
        return {
          id: updated.id,
          revision: updated.revision,
          status: updated.status,
          processing: updated.processing,
          processingError: updated.processingError,
          rationale: updated.rationale,
          clarifications: updated.clarifications,
        };
      },
    ),
    tool(
      "complete_refinement",
      "Finish the session after saving every outcome and handling any profile notes. May follow successful saves in the same response as the last tool call. No further model response is needed. Completion validates saved outcomes and concurrent edits.",
      false,
      z.object({ ctxAssessment: ctxAssessmentSchema }),
      () => {
        finish();
        return { completed: true };
      },
    ),
  ];
  function finish() {
    for (const id of owned.keys()) {
      const entry = current(id);
      if (!saved.has(id) && (id === item.id || entry.processing === "pending"))
        throw new Error("Refinement ended without saving every outcome.");
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
  }
  return {
    context: {
      today,
      preferences,
      capture: item,
      linkedCaptures: linked(item),
      referencesOnly,
    } satisfies RefinementContext,
    tools,
    latest: () => owned.get(item.id) ?? item,
    outcomes: () => [...owned.values()],
    finish,
  };
}
