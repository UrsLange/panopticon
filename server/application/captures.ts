import { ZodError } from "zod";
import type { Capture, Item, ItemFields } from "../../shared/schema.js";
import { retainReferences } from "./aliases.js";
import type { Assistant } from "./assistant.js";
import { captureRefinement } from "./capture-refinement.js";
import type { createContext } from "./context.js";
import { ApplicationError } from "./errors.js";
import { assertRevision } from "./items.js";
import type { CaptureStorage } from "./ports.js";
import type { createProfileUpdates } from "./profile-updates.js";

export function createCaptures({
  store,
  getAssistant,
  getProfileRoot,
  context,
  notes,
  today,
  resolveRepository,
  autoStart,
}: {
  store: CaptureStorage;
  getAssistant: () => Assistant | null;
  getProfileRoot: () => string;
  context: ReturnType<typeof createContext>;
  notes: ReturnType<typeof createProfileUpdates>;
  today: () => string;
  resolveRepository(item: Pick<Item, "project" | "references" | "noProject">): string | null;
  autoStart(itemId: string, revision: number): Promise<unknown>;
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
  const processItem = (id: string, mode: "full" | "references" = "full") => {
    const referencesOnly = mode === "references";
    if (processing.has(id)) return processing.get(id);
    const task = (async () => {
      const item = store.get(id);
      if (!item || notes.has(id) || (item.kind === "note" && item.status === "done")) return;
      const profileRoot = getProfileRoot();
      let refinement: ReturnType<typeof captureRefinement> | undefined;
      try {
        const assistant = getAssistant();
        if (!assistant) return;
        refinement = captureRefinement(
          item,
          store,
          context,
          notes,
          resolveRepository,
          referencesOnly,
          () => {
            if (getProfileRoot() !== profileRoot)
              throw new Error("Profile changed during refinement.");
          },
        );
        await assistant.interpret(item.body, refinement.context, refinement.tools);
        refinement.finish();
        await autoStart(id, refinement.latest().revision);
      } catch (error) {
        console.error("Capture refinement failed", { itemId: id, error });
        const latest = refinement?.latest() ?? item;
        if (store.get(id)?.revision === latest.revision)
          store.update(
            id,
            {
              processing: "pending",
              processingError:
                error instanceof Error
                  ? `Interpretation failed. ${error.message}`
                  : "Interpretation failed. Check model settings, retry, or organize this item manually.",
            },
            latest.revision,
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
      store.recordProfileActivity(getProfileRoot(), "capture", { itemId: item.id, text });
      void processItem(item.id);
      return captureState(item);
    },
    process: processItem,
    busy: () => processing.size > 0,
    close: async () => {
      while (processing.size) await Promise.all(processing.values());
    },
    markRefined(id: string, revision: number) {
      const item = store.get(id);
      if (!item) throw new ApplicationError("not-found", "Item not found");
      if (processing.has(id))
        throw new ApplicationError(
          "conflict",
          "Wait for refinement to finish before accepting this brief.",
        );
      if (!["idea", "commitment"].includes(item.kind))
        throw new ApplicationError(
          "invalid",
          "Choose Task or Idea before marking this capture as refined.",
        );
      return captureState(
        store.update(id, { processing: "ready", processingError: null }, revision),
      );
    },
    answer(id: string, input: { revision: number; answers: { id: string; answer: string }[] }) {
      const item = store.get(id);
      assertRevision(item, input.revision);
      if (processing.has(id))
        throw new ApplicationError(
          "conflict",
          "Wait for refinement to finish before saving answers.",
        );
      if (
        input.answers.some(
          (answer) =>
            !item.clarifications.some((entry) => entry.id === answer.id && !entry.resolved),
        )
      )
        throw new ApplicationError(
          "invalid",
          "These questions have changed. Reload before answering.",
        );
      const updated = store.update(
        id,
        {
          clarifications: item.clarifications.map((entry) => ({
            ...entry,
            answer: input.answers.find((answer) => answer.id === entry.id)?.answer ?? entry.answer,
          })),
        },
        input.revision,
      );
      store.recordProfileActivity(getProfileRoot(), "clarification", {
        itemId: id,
        originalCapture: item.original,
        answers: input.answers.map((answer) => ({
          question: item.clarifications.find((entry) => entry.id === answer.id)?.question,
          answer: answer.answer,
        })),
      });
      return captureState(updated);
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
      if (input.revision !== undefined) assertRevision(item, input.revision);
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
      const changes = Object.fromEntries(
        Object.entries(fields).filter(([key, value]) => value !== current[key as keyof ItemFields]),
      );
      if (Object.keys(changes).length)
        store.recordProfileActivity(getProfileRoot(), "edit", {
          itemId: id,
          originalCapture: current.original,
          changes,
        });
      if (bodyChanged) {
        const active = processing.get(current.id);
        if (active)
          void active.then(() => {
            if (store.get(current.id)?.revision === updated.revision)
              return processItem(current.id);
          });
        else void processItem(current.id);
      }
      return captureState(updated);
    },
  };
}
