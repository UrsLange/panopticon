import type { Item } from "../../shared/schema.js";
import type { ItemChanges } from "./ports.js";

export function assertRevision(
  current: Item | undefined,
  revision: number,
): asserts current is Item {
  if (!current) throw new Error("Item not found");
  if (current.revision !== revision) throw new Error("This item changed. Reload it before saving.");
}

export function assertItemLink(id: string, relatedId: string | null | undefined, exists: boolean) {
  if (relatedId && (relatedId === id || !exists))
    throw new Error("Choose an existing, different item to link.");
}

export function capturedItem(text: string, id: string, now: string): Item {
  return {
    id,
    original: text,
    title: text.split("\n")[0].slice(0, 120),
    body: text,
    kind: "unclassified",
    status: "open",
    project: "",
    dueDate: null,
    priority: "normal",
    relatedId: null,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    processing: "pending",
    processingError: null,
    rationale: "",
    sourcePaths: [],
    references: [],
    profilePath: null,
    prompt: "",
  };
}
export function revisedItem(
  current: Item,
  fields: ItemChanges,
  revision: number,
  now: string,
): Item {
  const next = {
    ...current,
    ...fields,
    revision: revision + 1,
    updatedAt: now,
  };
  if (next.kind !== "commitment") next.dueDate = null;
  return next;
}
export function dailyCommitments(items: Item[], date: string) {
  const active = items.filter(
    (item) => item.kind === "commitment" && (item.status === "open" || item.status === "waiting"),
  );
  const due = active
    .filter((item) => item.dueDate && item.dueDate <= date)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
  const suggested = active
    .filter((item) => item.status === "open" && !item.dueDate)
    .sort(
      (a, b) =>
        Number(b.priority === "high") - Number(a.priority === "high") ||
        a.createdAt.localeCompare(b.createdAt),
    )
    .slice(0, 3);
  return { date, due, suggested, waiting: active.filter((item) => item.status === "waiting") };
}

export function relatedItems(items: Item[], query: string, limit = 8) {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return items
    .map((item) => ({
      item,
      score: terms.reduce(
        (n, term) =>
          n +
          Number(
            `${item.title} ${item.body} ${item.prompt} ${item.project} ${item.references.map((reference) => `${reference.target} ${reference.label}`).join(" ")}`
              .toLowerCase()
              .includes(term),
          ),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => item);
}
