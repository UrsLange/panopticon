import { ZodError } from "zod";
import { type Capture, type Item, type ItemFields, itemFieldsSchema } from "../../shared/schema.js";
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
  resolveRepository,
}: {
  store: CaptureStorage;
  getAssistant: () => Assistant | null;
  context: ReturnType<typeof createContext>;
  notes: ReturnType<typeof createProfileUpdates>;
  today: () => string;
  resolveRepository(item: Pick<Item, "project" | "references" | "noProject">): string | null;
}) {
  const processing = new Map<string, Promise<void>>();
  const captureState = (item: Item): Capture => ({
    ...item,
    refinement: processing.has(item.id)
      ? "running"
      : item.processingError
        ? "failed"
        : item.processing === "pending"
          ? "paused"
          : item.processing,
  });
  const mergeNote = notes.merge;
  const processItem = (id: string, mode: "full" | "references" | "edited" = "full") => {
    const referencesOnly = mode === "references";
    if (processing.has(id)) return processing.get(id);
    const task = (async () => {
      const item = store.get(id);
      if (!item || notes.has(id) || (item.kind === "note" && item.status === "done")) return;
      try {
        const assistant = getAssistant();
        if (!assistant) return;
        const evidence = context(item.body, [], item.references);
        evidence.related = evidence.related.filter((related) => related.id !== id);
        evidence.commitments = {
          ...evidence.commitments,
          due: evidence.commitments.due.filter((related) => related.id !== id),
          suggested: evidence.commitments.suggested.filter((related) => related.id !== id),
          waiting: evidence.commitments.waiting.filter((related) => related.id !== id),
        };
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
          interpreted.prompt += `\n\nClarify unresolved references before dependent work: ${unresolved.map((candidate) => candidate.mention).join(", ")}.`;
        }
        const references = resolveReferences(
          interpreted.referenceIds,
          evidence.candidates,
          item.references,
        );
        const fields = itemFieldsSchema.parse({ ...item, ...interpreted });
        if (item.noProject) fields.project = "";
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
            repositoryId: resolveRepository({ ...(referencesOnly ? item : fields), references }),
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
          mode === "full" &&
          updated.kind === "note" &&
          interpreted.updateProfile &&
          !interpreted.needsClarification
        )
          await mergeNote(id, updated.revision);
      } catch (error) {
        if (store.get(id)?.revision === item.revision)
          store.update(
            id,
            {
              processing: "pending",
              processingError:
                error instanceof ApplicationError
                  ? error.message
                  : "Interpretation failed. Check model settings, retry, or organize this item manually.",
            },
            item.revision,
          );
      }
    })().finally(() => processing.delete(id));
    processing.set(id, task);
    return task;
  };

  return {
    list: () => store.list().map(captureState),
    today: () => {
      const daily = store.today(today());
      return {
        ...daily,
        due: daily.due.map(captureState),
        suggested: daily.suggested.map(captureState),
        waiting: daily.waiting.map(captureState),
      };
    },
    history: (id: string) => store.history(id),
    capture(text: string) {
      const item = store.capture(text);
      void processItem(item.id);
      return captureState(item);
    },
    process: processItem,
    busy: () => processing.size > 0,
    close: async () => {
      while (processing.size) await Promise.all(processing.values());
    },
    async retry(id: string, input: { resetReferences: boolean; revision?: number }) {
      const item = store.get(id);
      if (!item) throw new ApplicationError("not-found", "Item not found");
      if (item.kind === "note" && item.status === "done") return captureState(item);
      if (processing.has(id))
        throw new ApplicationError(
          "conflict",
          "Refinement is already running. Wait for it to finish.",
        );
      if (!getAssistant())
        throw new ApplicationError("unavailable", "Connect and validate a model in Settings.");
      if (input.resetReferences) {
        if (input.revision === undefined)
          throw new ApplicationError(
            "invalid",
            "Supply the current revision to resolve aliases again.",
          );
        store.update(
          item.id,
          { references: [], repositoryId: null, processing: "pending", processingError: null },
          input.revision,
        );
      } else if (
        !processing.has(item.id) &&
        (item.processing !== "pending" || item.processingError)
      ) {
        store.update(
          item.id,
          { processing: "pending", processingError: null },
          input.revision ?? item.revision,
        );
      }
      await processItem(item.id, input.resetReferences ? "references" : "full");
      return captureState(store.get(item.id) as Item);
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
      if (processing.has(id) && !bodyChanged)
        throw new ApplicationError(
          "conflict",
          "Refinement is running. Save your edits when it finishes.",
        );
      const updated = store.update(
        id,
        {
          ...fields,
          repositoryId: bodyChanged
            ? null
            : (fields.project !== undefined && fields.project !== current.project) ||
                (fields.noProject !== undefined && fields.noProject !== current.noProject)
              ? resolveRepository({ ...current, ...fields, references: [] })
              : current.repositoryId,
          processing: bodyChanged
            ? "pending"
            : (fields.kind ?? current.kind) === "note" &&
                (fields.status ?? current.status) !== "done"
              ? "review"
              : current.processing,
          processingError: bodyChanged ? null : current.processingError,
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
        if (active)
          void active.then(() => {
            if (store.get(current.id)?.revision === updated.revision)
              return processItem(current.id, "edited");
          });
        else void processItem(current.id, "edited");
      }
      return captureState(updated);
    },
  };
}
