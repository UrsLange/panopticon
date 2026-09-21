import { ZodError } from "zod";
import { type ItemFields, itemFieldsSchema } from "../../shared/schema.js";
import { resolveReferences, retainReferences } from "./aliases.js";
import type { Assistant } from "./assistant.js";
import type { createContext } from "./context.js";
import { ApplicationError } from "./errors.js";
import type { CaptureStorage } from "./ports.js";
import type { createProfileUpdates } from "./profile-updates.js";

export function createCaptures({
  store,
  getAssistant,
  context,
  notes,
  today,
}: {
  store: CaptureStorage;
  getAssistant: () => Assistant | null;
  context: ReturnType<typeof createContext>;
  notes: ReturnType<typeof createProfileUpdates>;
  today: () => string;
}) {
  const processing = new Map<string, Promise<void>>();
  const mergeNote = notes.merge;
  const processItem = (id: string, referencesOnly = false) => {
    if (processing.has(id)) return processing.get(id);
    const task = (async () => {
      const item = store.get(id);
      if (!item || notes.has(id) || (item.kind === "note" && item.status === "done")) return;
      try {
        const assistant = getAssistant();
        if (!assistant) return;
        const evidence = context(item.body, [], item.references);
        const interpreted = await assistant.interpret(item.body, evidence);
        const unresolved = evidence.candidates.filter(
          (candidate) => interpreted.referenceIds.includes(candidate.id) && !candidate.available,
        );
        if (unresolved.length) {
          interpreted.referenceIds = interpreted.referenceIds.filter(
            (id) => !unresolved.some((candidate) => candidate.id === id),
          );
          interpreted.needsClarification = true;
          interpreted.updateProfile = false;
          interpreted.rationale = [
            interpreted.rationale,
            ...unresolved.map(
              (candidate) =>
                `Please clarify who or what “${candidate.mention}” refers to; its identity is unresolved.`,
            ),
          ]
            .filter(Boolean)
            .join("\n\n");
        }
        const references = resolveReferences(
          interpreted.referenceIds,
          evidence.candidates,
          item.references,
        );
        const fields = itemFieldsSchema.parse({ ...item, ...interpreted });
        if (
          fields.relatedId &&
          !evidence.related.some((related) => related.id === fields.relatedId && related.id !== id)
        )
          fields.relatedId = null;
        const updated = store.update(
          id,
          {
            ...(referencesOnly ? {} : fields),
            references,
            processing:
              interpreted.needsClarification ||
              (referencesOnly ? item.kind : fields.kind) === "note"
                ? "review"
                : "ready",
            processingError: null,
            rationale: interpreted.rationale,
            sourcePaths: [
              ...new Set([
                ...(referencesOnly ? item.sourcePaths : interpreted.sources),
                ...references.map((reference) => reference.source),
              ]),
            ],
          },
          item.revision,
        );
        if (
          !referencesOnly &&
          updated.kind === "note" &&
          interpreted.updateProfile &&
          !interpreted.needsClarification
        )
          await mergeNote(id, updated.revision);
      } catch {
        if (store.get(id)?.revision === item.revision)
          store.update(
            id,
            {
              processing: "pending",
              processingError:
                "Interpretation failed. Check model settings, retry, or organize this item manually.",
            },
            item.revision,
          );
      }
    })().finally(() => processing.delete(id));
    processing.set(id, task);
    return task;
  };

  return {
    list: () => store.list(),
    today: () => store.today(today()),
    history: (id: string) => store.history(id),
    capture(text: string) {
      const item = store.capture(text);
      void processItem(item.id);
      return item;
    },
    process: processItem,
    busy: () => processing.size > 0,
    close: async () => {
      await Promise.all(processing.values());
    },
    async retry(id: string, input: { resetReferences: boolean; revision?: number }) {
      const item = store.get(id);
      if (!item) throw new ApplicationError("not-found", "Item not found");
      if (item.kind === "note" && item.status === "done") return item;
      if (!getAssistant())
        throw new ApplicationError("unavailable", "Connect and validate a model in Settings.");
      if (input.resetReferences) {
        if (input.revision === undefined)
          throw new ApplicationError(
            "invalid",
            "Supply the current revision to resolve aliases again.",
          );
        await processing.get(item.id);
        store.update(
          item.id,
          { references: [], processing: "pending", processingError: null },
          input.revision,
        );
      }
      await processItem(item.id, input.resetReferences);
      return store.get(item.id);
    },
    edit(id: string, fields: Partial<ItemFields>, revision: number) {
      const current = store.get(id);
      if (!current) throw new Error("Item not found");
      if (
        (fields.kind ?? current.kind) === "note" &&
        fields.status === "done" &&
        current.status !== "done"
      )
        throw new ZodError([
          { code: "custom", path: ["status"], message: "Use Add to profile to complete a note." },
        ]);
      const bodyChanged = fields.body !== undefined && fields.body !== current.body;
      const updated = store.update(
        id,
        {
          ...fields,
          processing: bodyChanged
            ? "pending"
            : (fields.kind ?? current.kind) === "note" &&
                (fields.status ?? current.status) !== "done"
              ? "review"
              : "ready",
          processingError: null,
          ...(bodyChanged || (fields.kind !== undefined && fields.kind !== current.kind)
            ? {
                profilePath: null,
                ...((fields.kind ?? current.kind) === "note" &&
                (fields.status ?? current.status) === "done"
                  ? { status: "open" as const }
                  : {}),
              }
            : {}),
          ...(bodyChanged
            ? {
                references: retainReferences(
                  current.body,
                  fields.body ?? current.body,
                  current.references,
                ),
              }
            : {}),
        },
        revision,
      );
      if (bodyChanged) {
        const active = processing.get(current.id);
        if (active) void active.then(() => processItem(current.id, true));
        else void processItem(current.id, true);
      }
      return updated;
    },
  };
}
