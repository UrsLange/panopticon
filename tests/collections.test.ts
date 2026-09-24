import { expect, it } from "vitest";
import { capturedItem, dailyCommitments } from "../server/application/items";
import { captureCollection, taskNeedsAttention } from "../shared/collections";
import type { Capture } from "../shared/schema";

const task: Capture = {
  ...capturedItem("Send proposal", "task", "2026-09-24T10:00:00Z"),
  kind: "commitment",
  prompt: "Send the reviewed proposal to Anna.",
  processing: "ready",
  refinement: "ready",
};

it("keeps unfinished captures in Inbox regardless of their classified kind", () => {
  for (const kind of ["idea", "commitment", "note", "unclassified"] as const) {
    for (const refinement of ["running", "paused", "failed", "review"] as const) {
      expect(captureCollection({ ...task, kind, refinement })).toBe("inbox");
    }
  }
  expect(captureCollection({ ...task, processingError: "Refinement failed" })).toBe("inbox");
});

it("routes refined ideas and tasks and retains closed task history", () => {
  expect(captureCollection(task)).toBe("tasks");
  expect(captureCollection({ ...task, kind: "idea" })).toBe("notebook");
  expect(captureCollection({ ...task, kind: "note" })).toBe("inbox");
  expect(captureCollection({ ...task, kind: "note", status: "done" })).toBeNull();
  expect(captureCollection({ ...task, status: "done", refinement: "paused" })).toBe("tasks");
});

it("counts actionable deadlines and reviews, excluding unfinished and closed tasks", () => {
  for (const fields of [
    { dueDate: "2026-09-23" },
    { dueDate: "2026-09-24" },
    { status: "in_review" as const },
    { status: "waiting" as const, dueDate: "2026-09-24" },
  ]) {
    expect(taskNeedsAttention({ ...task, ...fields }, "2026-09-24")).toBe(true);
  }
  for (const fields of [
    { dueDate: "2026-09-25" },
    { dueDate: null },
    { status: "done" as const },
    { status: "archived" as const },
    { kind: "idea" as const },
    { refinement: "running" as const },
    { processingError: "Failed" },
  ]) {
    expect(taskNeedsAttention({ ...task, dueDate: "2026-09-24", ...fields }, "2026-09-24")).toBe(
      false,
    );
  }
});

it("excludes unfinished tasks from every Today collection", () => {
  const unfinished = ["pending", "review"].flatMap((processing) =>
    ["open", "waiting", "in_progress", "in_review"].flatMap((status) =>
      [null, "2026-09-24"].map((dueDate) => ({ ...task, processing, status, dueDate }) as Capture),
    ),
  );
  unfinished.push({ ...task, refinement: "running" });
  unfinished.push({ ...task, processingError: "Failed", dueDate: "2026-09-24" });
  expect(dailyCommitments(unfinished, "2026-09-24")).toEqual({
    date: "2026-09-24",
    due: [],
    suggested: [],
    waiting: [],
  });
  expect(dailyCommitments([task, ...unfinished], "2026-09-24").suggested).toEqual([task]);
});
