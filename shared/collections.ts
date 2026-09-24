import type { Capture, Item } from "./schema.js";

export function isRefined(item: Item | Capture) {
  return (
    item.processing === "ready" &&
    !item.processingError &&
    item.kind !== "unclassified" &&
    (!("refinement" in item) || item.refinement === "ready")
  );
}

export function captureCollection(item: Capture) {
  const closed = item.status === "done" || item.status === "archived";
  if (closed && item.kind === "note") return null;
  if (!closed && !isRefined(item)) return "inbox";
  if (item.kind === "commitment") return "tasks";
  if (item.kind === "idea") return "notebook";
  return "inbox";
}

export function taskNeedsAttention(item: Item, date: string) {
  return (
    item.kind === "commitment" &&
    isRefined(item) &&
    !["done", "archived"].includes(item.status) &&
    (item.status === "in_review" || !!(item.dueDate && item.dueDate <= date))
  );
}
