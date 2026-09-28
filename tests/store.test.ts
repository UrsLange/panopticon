import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../server/store.js";
import { dayInTimezone } from "../shared/schema.js";
import type { Implementation } from "../shared/t3.js";

const stores: Store[] = [];
function store() {
  const db = new Store(":memory:");
  stores.push(db);
  return db;
}
afterEach(() => {
  for (const db of stores.splice(0)) db.db.close();
});

it("persists GitHub validators, response data, and retry deadlines across database restarts", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pa-github-cache-")), "assistant.sqlite");
  const original = new Store(path);
  const entry = {
    body: { default_branch: "main" },
    etag: '"version"',
    checkedAt: 100,
    expires: 1000,
    retryAt: 2000,
  };
  original.saveGithubCache("repos/acme/app", entry);
  original.db.close();
  const reopened = new Store(path);
  stores.push(reopened);
  expect(reopened.githubCache("repos/acme/app")).toEqual(entry);
  expect(reopened.githubCache("repos/acme/unknown")).toBeUndefined();
});

it("retains learning checkpoints and provisional memory across restarts, scoped to each profile", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pa-learning-state-")), "assistant.sqlite");
  const original = new Store(path);
  original.recordProfileActivity("/profile", "capture", { text: "My team owns onboarding." });
  original.recordProfileActivity("/other", "capture", { text: "Another profile's observation." });
  const state = {
    cursor: 1,
    completedDay: "2026-09-28",
    lastAttempt: "2026-09-28T12:00:00Z",
    lastSuccess: "2026-09-28T12:01:00Z",
    summary: "Updated responsibility",
    provisionalMemory: "Unresolved scope with evidence",
    error: null,
  };
  original.saveProfileLearningState("/profile", state);
  original.db.close();
  const reopened = new Store(path);
  stores.push(reopened);
  expect(reopened.profileLearningState("/profile")).toEqual(state);
  expect(reopened.profileLearningState("/other")).toBeUndefined();
  expect(reopened.profileActivity("/profile", 0)).toHaveLength(1);
  expect(reopened.profileActivity("/profile", 1)).toEqual([]);
});

it("journals implementation state transitions without duplicating unchanged polls or storing connection details", () => {
  const db = store();
  const item = db.capture("Prepare the onboarding portal.");
  const entry: Implementation = {
    id: "implementation",
    itemId: item.id,
    revision: 0,
    profileRoot: "/profile",
    endpoint: "https://private-instance.example",
    environmentId: "environment",
    repositoryId: "repository",
    workspaceRoot: "/workspace",
    baseBranch: "main",
    projectId: "project",
    title: "Onboarding",
    prompt: "Generated implementation prompt",
    model: { instanceId: "instance", model: "model" },
    createdAt: "2026-09-28T12:00:00Z",
    state: "submitted",
    error: null,
  };
  db.saveImplementation(entry);
  db.saveImplementation(entry);
  db.saveImplementation({
    ...entry,
    progress: { turnState: "completed", checkedAt: "2026-09-28T12:01:00Z", error: null },
  });
  db.saveImplementation({
    ...entry,
    progress: { turnState: "completed", checkedAt: "2026-09-28T12:02:00Z", error: null },
  });
  const events = db.profileActivity("/profile", 0);
  expect(events).toHaveLength(2);
  expect(JSON.parse(events[1].content)).toMatchObject({
    originalCapture: item.original,
    turnState: "completed",
    taskStatus: "open",
  });
  expect(events[1].content).not.toContain("private-instance");
  expect(events[1].content).not.toContain("Generated implementation prompt");
});

describe("capture and planning", () => {
  it("migrates and persists interview questions, answers, and revision history", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pa-interview-")), "assistant.sqlite");
    const original = new Store(path);
    const item = original.capture("A demo");
    original.db.exec("ALTER TABLE items DROP COLUMN clarifications");
    original.db.close();
    const migrated = new Store(path);
    expect(migrated.get(item.id)?.clarifications).toEqual([]);
    const question = { id: "0:0", question: "Which project?", answer: "", resolved: false };
    migrated.update(item.id, { clarifications: [question] }, 0);
    migrated.update(item.id, { clarifications: [{ ...question, answer: "Portal" }] }, 1);
    migrated.db.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.get(item.id)?.clarifications[0].answer).toBe("Portal");
    expect(reopened.list()[0].clarifications[0].answer).toBe("Portal");
    expect(reopened.history(item.id)[0].item.clarifications[0].answer).toBe("");
  });
  it("migrates unassigned projects and persists deliberate no-project choices and history", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pa-no-project-")), "assistant.sqlite");
    const original = new Store(path);
    const item = original.capture("Ask Anna for an answer");
    original.update(item.id, { project: "Portal", repositoryId: "portal" }, 0);
    original.db.exec(`ALTER TABLE items DROP COLUMN noProject;
      UPDATE item_history SET snapshot = json_remove(snapshot, '$.noProject')`);
    original.db.close();
    const migrated = new Store(path);
    expect(migrated.get(item.id)?.noProject).toBe(false);
    expect(migrated.history(item.id)[0].item.noProject).toBe(false);
    expect(migrated.update(item.id, { noProject: true }, 1)).toMatchObject({
      noProject: true,
      project: "",
      repositoryId: null,
    });
    migrated.update(item.id, { status: "waiting" }, 2);
    migrated.db.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.get(item.id)).toMatchObject({
      noProject: true,
      project: "",
      status: "waiting",
    });
    expect(reopened.list()[0].noProject).toBe(true);
    expect(reopened.history(item.id).map(({ item }) => item.noProject)).toEqual([
      true,
      false,
      false,
    ]);
  });
  it("migrates repository associations and preserves them across restarts and history", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pa-repository-")), "assistant.sqlite");
    const original = new Store(path);
    const item = original.capture("Implement portal search");
    original.db.exec("ALTER TABLE items DROP COLUMN repositoryId");
    original.db.close();
    const migrated = new Store(path);
    expect(migrated.get(item.id)?.repositoryId).toBeNull();
    migrated.update(item.id, { repositoryId: "portal" }, 0);
    migrated.update(item.id, { title: "Search" }, 1);
    migrated.db.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.get(item.id)?.repositoryId).toBe("portal");
    expect(reopened.history(item.id)[0].item.repositoryId).toBe("portal");
  });
  it("migrates existing descriptions and history to prompts without losing content", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pa-prompt-migration-")), "assistant.sqlite");
    const original = new Store(path);
    const item = original.capture("Original input");
    original.update(item.id, { prompt: "Existing description" }, 0);
    original.update(item.id, { prompt: "Revised description" }, 1);
    original.db.exec(`
      ALTER TABLE items RENAME COLUMN prompt TO refinedDescription;
      UPDATE item_history SET snapshot = json_remove(
        json_set(snapshot, '$.refinedDescription', json_extract(snapshot, '$.prompt')),
        '$.prompt'
      );
    `);
    original.db.close();
    const migrated = new Store(path);
    expect(migrated.get(item.id)).toMatchObject({
      prompt: "Revised description",
      original: "Original input",
      body: "Original input",
      revision: 2,
    });
    expect(migrated.get(item.id)).not.toHaveProperty("refinedDescription");
    expect(migrated.history(item.id).map(({ item }) => item.prompt)).toEqual([
      "Existing description",
      "",
    ]);
    migrated.db.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.get(item.id)?.prompt).toBe("Revised description");
    expect(reopened.history(item.id)[0].item.prompt).toBe("Existing description");
  });
  it("migrates and persists refined descriptions without changing capture text or references", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pa-description-")), "assistant.sqlite");
    const original = new Store(path);
    const item = original.capture("Review onboarding");
    original.db.exec("ALTER TABLE items DROP COLUMN prompt");
    original.db.close();
    const migrated = new Store(path);
    expect(migrated.get(item.id)?.prompt).toBe("");
    migrated.update(item.id, { prompt: "Verify invitation acceptance in Chromium." }, 0);
    migrated.db.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.get(item.id)).toMatchObject({
      original: "Review onboarding",
      body: "Review onboarding",
      references: [],
      prompt: "Verify invitation acceptance in Chromium.",
    });
    expect(reopened.history(item.id)[0].item.prompt).toBe("");
    expect(reopened.search("Chromium").map((item) => item.id)).toContain(item.id);
  });
  it("reopens legacy completed notes for incorporation and preserves completion after migration", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pa-note-migration-")), "assistant.sqlite");
    const original = new Store(path);
    const note = original.capture("Keep commits atomic");
    original.update(note.id, { kind: "note", status: "done" }, 0);
    original.db.exec("ALTER TABLE items DROP COLUMN profilePath");
    original.db.close();
    const migrated = new Store(path);
    expect(migrated.get(note.id)).toMatchObject({
      status: "open",
      processing: "review",
      profilePath: null,
    });
    expect(migrated.history(note.id)[0].item.status).toBe("done");
    migrated.update(
      note.id,
      { status: "done", profilePath: "/profile", sourcePaths: ["rules.md"] },
      2,
    );
    migrated.db.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.get(note.id)).toMatchObject({
      status: "done",
      profilePath: "/profile",
      sourcePaths: ["rules.md"],
    });
  });
  it("migrates existing captures and persists reference snapshots across restarts", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pa-migration-")), "assistant.sqlite");
    const original = new Store(path);
    const item = original.capture("Ask gham");
    original.db.exec('ALTER TABLE items DROP COLUMN "references"');
    original.db.close();
    const migrated = new Store(path);
    expect(migrated.get(item.id)?.references).toEqual([]);
    const references = [
      {
        start: 4,
        end: 8,
        mention: "gham",
        kind: "project" as const,
        target: "projects/access.md",
        label: "GitHub Access Management",
        source: "aliases.md",
      },
    ];
    migrated.update(item.id, { references }, 0);
    migrated.db.close();
    const reopened = new Store(path);
    stores.push(reopened);
    expect(reopened.get(item.id)?.references).toEqual(references);
    expect(reopened.history(item.id)[0].item.original).toBe("Ask gham");
  });
  it("preserves original wording and revision history when correcting an interpretation", () => {
    const db = store();
    const capture = db.capture("Perhaps we could launch next Friday");
    const edited = db.update(
      capture.id,
      { title: "Launch concept", kind: "idea", dueDate: "2026-09-18" },
      0,
    );
    expect(edited.original).toBe(capture.original);
    expect(edited.dueDate).toBeNull();
    expect(db.history(capture.id)[0].item).toEqual(capture);
    expect(() => db.update(capture.id, { title: "Stale edit" }, 0)).toThrow("changed");
  });

  it("includes every due or overdue unfinished commitment, including waiting ones", () => {
    const db = store();
    for (let i = 0; i < 15; i++) {
      const item = db.capture(`Task ${i}`);
      db.update(
        item.id,
        {
          kind: "commitment",
          dueDate: i < 8 ? "2026-09-16" : "2026-09-17",
          processing: "ready",
          status: i === 0 ? "waiting" : i === 1 ? "in_progress" : i === 2 ? "in_review" : "open",
        },
        0,
      );
    }
    const future = db.capture("Future");
    db.update(future.id, { kind: "commitment", dueDate: "2026-09-18" }, 0);
    const done = db.capture("Done");
    db.update(done.id, { kind: "commitment", dueDate: "2026-09-17", status: "done" }, 0);
    expect(db.today("2026-09-17").due).toHaveLength(15);
    expect(db.today("2026-09-17").waiting).toHaveLength(1);
  });

  it("suggests only undated open commitments and keeps ideas out", () => {
    const db = store();
    for (const kind of ["idea", "note", "commitment"] as const) {
      const item = db.capture(kind);
      db.update(item.id, { kind, processing: "ready" }, 0);
    }
    expect(db.today("2026-09-17").suggested.map((item) => item.kind)).toEqual(["commitment"]);
    for (const status of ["in_progress", "in_review", "waiting", "done"] as const) {
      const item = db.capture(status);
      db.update(item.id, { kind: "commitment", status, processing: "ready" }, 0);
    }
    expect(db.today("2026-09-17").suggested.map((item) => item.status)).toEqual(["open"]);
  });

  it("rejects invalid links without modifying the capture", () => {
    const db = store();
    const item = db.capture("Idea");
    expect(() => db.update(item.id, { relatedId: "missing" }, 0)).toThrow("existing");
    expect(db.get(item.id)?.revision).toBe(0);
  });

  it("uses the configured timezone rather than UTC for the daily boundary", () => {
    expect(dayInTimezone(new Date("2026-09-16T23:30:00Z"), "Europe/Berlin")).toBe("2026-09-17");
    expect(dayInTimezone(new Date("2026-09-17T01:00:00Z"), "America/Los_Angeles")).toBe(
      "2026-09-16",
    );
  });
});

it("migrates execution intent while preserving existing capture content and history", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pa-refinement-migration-")), "assistant.sqlite");
  const original = new Store(path);
  const task = original.capture("Implement the portal");
  original.update(
    task.id,
    {
      kind: "commitment",
      prompt: "Implement the portal with existing access rules",
      rationale: "Existing interpretation",
    },
    task.revision,
  );
  const manual = original.capture("Call Anna");
  original.update(
    manual.id,
    { kind: "commitment", noProject: true, prompt: "Call Anna" },
    manual.revision,
  );
  const savedTask = original.get(task.id);
  if (!savedTask) throw new Error("Task missing");
  original.update(task.id, { priority: "high" }, savedTask.revision);
  original.db.exec("ALTER TABLE items DROP COLUMN parentId");
  original.db.exec("ALTER TABLE items DROP COLUMN execution");
  original.db.exec(
    "UPDATE item_history SET snapshot=json_remove(snapshot, '$.execution', '$.parentId')",
  );
  original.db.close();
  const reopened = new Store(path);
  stores.push(reopened);
  expect(reopened.get(task.id)).toMatchObject({
    execution: "implementation",
    parentId: null,
    original: "Implement the portal",
    prompt: "Implement the portal with existing access rules",
    rationale: "Existing interpretation",
  });
  expect(reopened.get(manual.id)).toMatchObject({ execution: "manual", parentId: null });
  expect(
    reopened.history(task.id).every(({ item }) => item.parentId === null && item.execution),
  ).toBe(true);
  expect(
    reopened
      .history(task.id)
      .some(({ item }) => item.prompt === "Implement the portal with existing access rules"),
  ).toBe(true);
});
