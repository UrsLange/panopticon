import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { Assistant } from "../server/application/assistant.js";
import { createProfileLearning } from "../server/application/profile-learning.js";
import { Profile } from "../server/profile.js";
import { profileAdapter } from "../server/profile-adapter.js";
import { Store } from "../server/store.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pa-learning-"));
  const store = new Store(join(root, "activity.sqlite"));
  stores.push(store);
  const profile = new Profile(join(root, "profile"));
  profile.initialize(() => profile.create("About me", "Profile", "I lead the platform team."));
  const document = profile.documents().find((doc) => doc.type === "Profile");
  assert(document);
  let selected = profileAdapter(profile);
  let now = new Date("2026-09-28T20:00:00Z");
  let busy = false;
  const assistant: Assistant = {
    interpret: vi.fn(),
    ask: vi.fn(),
    updateProfile: vi.fn(),
    consolidateProfile: vi.fn(async () => ({
      summary: "No profile changes.",
      paths: [],
      changes: [],
      provisionalMemory: "",
    })),
  };
  const options = {
    records: store,
    getProfile: () => selected,
    getAssistant: () => assistant,
    busy: () => busy,
    timezone: () => "Europe/Berlin",
    now: () => now,
  };
  const learning = createProfileLearning(options);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", profile.root, ...args], { encoding: "utf8" }).trim();
  const activity = (text: string) => store.recordProfileActivity(profile.root, "capture", { text });
  return {
    store,
    profile,
    document,
    assistant,
    options,
    learning,
    git,
    activity,
    setNow: (date: string) => {
      now = new Date(date);
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
    switchProfile: () => {
      selected = profileAdapter(new Profile(join(root, "other")));
    },
  };
}

it("consolidates original evidence, commits changes, and keeps provisional memory outside profile context", async () => {
  const f = fixture();
  f.activity("Prepare the briefing for the partner launch.");
  f.store.recordProfileActivity(f.profile.root, "clarification", {
    question: "Which team owns this?",
    answer: "My platform team owns partner enablement.",
  });
  f.store.recordProfileActivity("/other-profile", "capture", { text: "Unrelated private context" });
  const memory =
    "Possible cross-team coordination role; event 1, observed 2026-09-28; scope uncertain.";
  vi.mocked(f.assistant.consolidateProfile).mockResolvedValueOnce({
    summary: "Recorded partner enablement responsibility and likely upcoming launch context.",
    paths: [f.document.path],
    changes: [
      {
        path: f.document.path,
        content: `${f.document.content}\nThe team owns partner enablement. Preparation suggests an upcoming partner launch.\n`,
      },
    ],
    provisionalMemory: memory,
  });
  await f.learning.run(true);
  const input = vi.mocked(f.assistant.consolidateProfile).mock.calls[0][0];
  expect(input.documents).toEqual(expect.arrayContaining([f.document]));
  expect(input.activity).toHaveLength(2);
  expect(input.activity[1].content).toContain("My platform team owns partner enablement");
  expect(input).toMatchObject({
    date: "2026-09-28",
    timezone: "Europe/Berlin",
    provisionalMemory: "",
  });
  expect(f.git("log", "-1", "--format=%s")).toBe("docs(profile): consolidate daily activity");
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 2,
    provisionalMemory: memory,
    error: null,
  });
  expect(JSON.stringify(f.profile.context("coordination"))).not.toContain(memory);
  await f.learning.run(true);
  expect(f.assistant.consolidateProfile).toHaveBeenCalledTimes(1);
  f.setNow("2026-09-28T22:01:00Z");
  const head = f.git("rev-parse", "HEAD");
  await createProfileLearning(f.options).run(true);
  expect(vi.mocked(f.assistant.consolidateProfile).mock.calls[1][0]).toMatchObject({
    date: "2026-09-29",
    activity: [],
    provisionalMemory: memory,
  });
  expect(f.git("rev-parse", "HEAD")).toBe(head);
});

it("retains the checkpoint on model failure, retries after restart, and catches up after missed days", async () => {
  const f = fixture();
  f.activity("I now coordinate onboarding.");
  vi.mocked(f.assistant.consolidateProfile).mockRejectedValueOnce(new Error("provider secret"));
  await f.learning.run(true);
  expect(f.learning.status()).toMatchObject({ lastSuccess: null, running: false });
  expect(f.learning.status().error).not.toContain("provider secret");
  expect(f.store.profileLearningState(f.profile.root)?.cursor).toBe(0);
  await createProfileLearning(f.options).run(true);
  expect(f.assistant.consolidateProfile).toHaveBeenCalledTimes(1);
  f.setNow("2026-10-01T20:00:00Z");
  f.activity("Our next priority is partner onboarding.");
  await createProfileLearning(f.options).run(true);
  expect(vi.mocked(f.assistant.consolidateProfile).mock.calls[1][0].activity).toHaveLength(2);
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 2,
    completedDay: "2026-10-01",
    error: null,
  });
});

it("processes a backlog in bounded batches without skipping activity or waiting another day", async () => {
  const f = fixture();
  for (let i = 0; i < 105; i++) f.activity(`Observation ${i}`);
  await f.learning.run(true);
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 100,
    completedDay: null,
  });
  await f.learning.run(true);
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 105,
    completedDay: "2026-09-28",
  });
  expect(vi.mocked(f.assistant.consolidateProfile).mock.calls[1][0].activity[0].id).toBe(101);
  f.activity("x".repeat(30000));
  f.activity("y".repeat(30000));
  f.setNow("2026-09-29T20:00:00Z");
  await f.learning.run(true);
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 106,
    completedDay: null,
  });
  await f.learning.run(true);
  expect(f.store.profileLearningState(f.profile.root)?.cursor).toBe(107);
});

it("coalesces running requests, waits on shutdown, and leaves activity arriving mid-run for the next batch", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(f.assistant.consolidateProfile).mockImplementationOnce(async () => {
    await gate;
    return { changes: [], paths: [], summary: "No changes", provisionalMemory: "" };
  });
  f.activity("First observation");
  const first = f.learning.run(true);
  expect(f.learning.run(true)).toBe(first);
  await Promise.resolve();
  f.activity("Second observation");
  expect(f.learning.busy()).toBe(true);
  let closed = false;
  const close = f.learning.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await close;
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 1,
    completedDay: null,
  });
  await f.learning.run(true);
  expect(f.store.profileLearningState(f.profile.root)?.cursor).toBe(2);
});

it.each(["profile switch", "concurrent edit", "busy"])(
  "retains evidence after a %s during consolidation",
  async (change) => {
    const f = fixture();
    f.activity("A new fact");
    vi.mocked(f.assistant.consolidateProfile).mockImplementationOnce(async () => {
      if (change === "profile switch") f.switchProfile();
      if (change === "busy") f.setBusy(true);
      if (change === "concurrent edit")
        f.profile.change("manual correction", () =>
          f.profile.save(
            f.document.path,
            `${f.document.content}\nManual correction\n`,
            f.document.hash,
          ),
        );
      return {
        changes: [{ path: f.document.path, content: `${f.document.content}\nModel update\n` }],
        paths: [f.document.path],
        summary: "Update",
        provisionalMemory: "candidate",
      };
    });
    await f.learning.run();
    expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
      cursor: 0,
      lastSuccess: null,
      provisionalMemory: "",
    });
    expect(readFileSync(join(f.profile.root, f.document.path), "utf8")).not.toContain(
      "Model update",
    );
  },
);

it("does not checkpoint saved-but-uncommitted work, even when a retry returns no changes", async () => {
  const f = fixture();
  f.activity("I own onboarding.");
  const hook = join(f.profile.root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  vi.mocked(f.assistant.consolidateProfile).mockResolvedValueOnce({
    changes: [{ path: f.document.path, content: `${f.document.content}\nI own onboarding.\n` }],
    paths: [f.document.path],
    summary: "Updated responsibility",
    provisionalMemory: "candidate",
  });
  const head = f.git("rev-parse", "HEAD");
  await f.learning.run();
  expect(f.learning.status().error).toContain("Profile saved, but not committed");
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(f.profile.root, f.document.path), "utf8")).toContain("I own onboarding");
  await f.learning.run();
  expect(f.learning.status().error).toContain("uncommitted changes");
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 0,
    lastSuccess: null,
    provisionalMemory: "",
  });
});

it("rejects invalid model changes without committing or consuming activity", async () => {
  const f = fixture();
  f.activity("A fact");
  const head = f.git("rev-parse", "HEAD");
  vi.mocked(f.assistant.consolidateProfile).mockResolvedValueOnce({
    changes: [{ path: "../outside.md", content: "Bad path" }],
    paths: [f.document.path],
    summary: "Invalid",
    provisionalMemory: "",
  });
  await f.learning.run();
  expect(f.store.profileLearningState(f.profile.root)?.cursor).toBe(0);
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(f.git("status", "--porcelain")).toBe("");
});

it("preserves scoped conversation context across checkpoints without including other profiles", () => {
  const f = fixture();
  f.store.recordProfileActivity(f.profile.root, "conversation", {
    role: "assistant",
    content: "Does your team own partner enablement?",
  });
  f.store.recordProfileActivity("/other", "conversation", {
    role: "assistant",
    content: "Unrelated question",
  });
  expect(f.store.profileConversation(f.profile.root)).toEqual([
    { role: "assistant", content: "Does your team own partner enablement?" },
  ]);
});
