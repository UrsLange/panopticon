import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { Assistant } from "../server/application/assistant.js";
import { createProfileLearning } from "../server/application/profile-learning.js";
import type {
  ProfileLearningAgent,
  ProfileLearningTool,
} from "../server/application/profile-learning-model.js";
import { Profile } from "../server/profile.js";
import { profileAdapter } from "../server/profile-adapter.js";
import { Store } from "../server/store.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
});

async function call(tools: ProfileLearningTool[], name: string, args: unknown = {}) {
  const tool = tools.find((tool) => tool.name === name);
  assert(tool, name);
  return await tool.execute(args);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pa-learning-"));
  const store = new Store(join(root, "activity.sqlite"));
  stores.push(store);
  const profile = new Profile(join(root, "profile"));
  profile.initialize(() => profile.create("About me", "Profile", "I lead the platform team."));
  const document = profile.documents().find((doc) => doc.type === "Profile");
  assert(document);
  const selected = profileAdapter(profile);
  let now = new Date("2026-09-28T20:00:00Z");
  let busy = false;
  let behavior: ProfileLearningAgent = async () => "No profile changes.";
  const inputs: { activity: unknown[]; date: string; timezone: string; memory: string }[] = [];
  const assistant: Assistant = {
    interpret: vi.fn(),
    ask: vi.fn(),
    updateProfile: vi.fn(),
    consolidateProfile: vi.fn(async (workspace, tools) => {
      const artifact = (await call(tools, "read_file", {
        path: workspace.activityPath,
        startLine: null,
        endLine: null,
      })) as { content: string };
      const memory = (await call(tools, "read_file", {
        path: workspace.provisionalMemoryPath,
        startLine: null,
        endLine: null,
      })) as { content: string };
      inputs.push({ ...JSON.parse(artifact.content), memory: memory.content });
      return behavior(workspace, tools);
    }),
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
    root,
    store,
    profile,
    document,
    assistant,
    options,
    learning,
    git,
    activity,
    inputs,
    respond: (next: ProfileLearningAgent) => {
      behavior = next;
    },
    setNow: (date: string) => {
      now = new Date(date);
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

it("lets the agent inspect artifacts, edit and commit the profile, and maintain separate provisional memory", async () => {
  const f = fixture();
  f.activity("Prepare the briefing for the partner launch.");
  f.store.recordProfileActivity(f.profile.root, "clarification", {
    question: "Which team owns this?",
    answer: "My platform team owns partner enablement.",
  });
  f.store.recordProfileActivity("/other-profile", "capture", { text: "Unrelated private context" });
  const memory =
    "Possible cross-team coordination role; event 1, observed 2026-09-28; scope uncertain.";
  f.respond(async (workspace, tools) => {
    expect(await call(tools, "list_profile_files")).toEqual({
      files: expect.arrayContaining([f.document.path, "index.md"]),
    });
    const file = (await call(tools, "read_file", {
      path: f.document.path,
      startLine: null,
      endLine: null,
    })) as { content: string };
    expect(file.content).toBe(f.document.content);
    await call(tools, "edit_file", {
      path: f.document.path,
      oldText: "I lead the platform team.",
      newText:
        "I lead the platform team. We own partner enablement. Preparation suggests an upcoming partner launch.",
    });
    await call(tools, "write_file", { path: workspace.provisionalMemoryPath, content: memory });
    expect(await call(tools, "profile_diff")).toMatchObject({
      diff: expect.stringContaining("upcoming partner launch"),
    });
    await call(tools, "check_profile");
    await call(tools, "commit_profile", { summary: "record partner enablement context" });
    return "Recorded partner enablement responsibility and likely upcoming launch context.";
  });
  await f.learning.run(true);
  expect(f.inputs[0]).toMatchObject({ date: "2026-09-28", timezone: "Europe/Berlin", memory: "" });
  expect(f.inputs[0].activity).toHaveLength(2);
  expect(f.inputs[0].activity[1]).toMatchObject({
    evidence: { answer: "My platform team owns partner enablement." },
  });
  expect(f.git("log", "-1", "--format=%s")).toBe(
    "docs(profile): record partner enablement context",
  );
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 2,
    provisionalMemory: memory,
    error: null,
  });
  expect(JSON.stringify(f.profile.context("coordination"))).not.toContain(memory);
  const workspace = vi.mocked(f.assistant.consolidateProfile).mock.calls[0][0];
  expect(existsSync(workspace.activityPath)).toBe(false);
  await f.learning.run(true);
  expect(f.assistant.consolidateProfile).toHaveBeenCalledTimes(1);
  f.setNow("2026-09-28T22:01:00Z");
  f.respond(async () => "No new knowledge.");
  const head = f.git("rev-parse", "HEAD");
  await createProfileLearning(f.options).run(true);
  expect(f.inputs[1]).toMatchObject({ date: "2026-09-29", activity: [], memory });
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
  expect(f.inputs[0].activity).toHaveLength(2);
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 2,
    completedDay: "2026-10-01",
    error: null,
  });
});

it("supplies all pending activity and preserves provisional memory without fixed size limits", async () => {
  const f = fixture();
  for (let i = 0; i < 105; i++) f.activity(`Observation ${i}: ${"x".repeat(1000)}`);
  const memory = "Candidate evidence. ".repeat(1000);
  f.respond(async (workspace, tools) => {
    await call(tools, "write_file", { path: workspace.provisionalMemoryPath, content: memory });
    return "No durable changes.";
  });
  await f.learning.run(true);
  expect(f.inputs[0].activity).toHaveLength(105);
  expect(JSON.stringify(f.inputs[0].activity).length).toBeGreaterThan(60000);
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 105,
    completedDay: "2026-09-28",
    provisionalMemory: memory,
  });
});

it("coalesces requests, waits on shutdown, and retains activity arriving during the run", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.respond(async () => {
    entered();
    await gate;
    return "No changes.";
  });
  f.activity("First observation");
  const first = f.learning.run(true);
  expect(f.learning.run(true)).toBe(first);
  await started;
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

it("holds the profile lock throughout the agent session and defers starting during other work", async () => {
  const f = fixture();
  f.setBusy(true);
  await f.learning.run();
  expect(f.assistant.consolidateProfile).not.toHaveBeenCalled();
  f.setBusy(false);
  f.respond(async () => {
    expect(() => new Profile(f.profile.root).change("concurrent edit", () => {})).toThrow(
      "being updated",
    );
    return "No changes.";
  });
  await f.learning.run();
  expect(f.learning.status().error).toBeNull();
});

it("rejects external changes without overwriting them or consuming activity", async () => {
  const f = fixture();
  f.activity("A new fact");
  f.respond(async (_workspace, tools) => {
    writeFileSync(
      join(f.profile.root, f.document.path),
      `${f.document.content}\nManual correction\n`,
    );
    await expect(
      call(tools, "write_file", { path: f.document.path, content: "Model overwrite" }),
    ).rejects.toThrow("outside the learning session");
    return "No changes.";
  });
  await f.learning.run();
  expect(f.store.profileLearningState(f.profile.root)?.cursor).toBe(0);
  expect(readFileSync(join(f.profile.root, f.document.path), "utf8")).toContain(
    "Manual correction",
  );
});

it("requires the agent to commit and never treats a final success message as a completed write", async () => {
  const f = fixture();
  f.activity("I own onboarding.");
  const head = f.git("rev-parse", "HEAD");
  f.respond(async (_workspace, tools) => {
    await call(tools, "write_file", {
      path: f.document.path,
      content: `${f.document.content}\nI own onboarding.\n`,
    });
    return "Everything is saved and committed.";
  });
  await f.learning.run();
  expect(f.learning.status().error).toContain("uncommitted changes");
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(f.store.profileLearningState(f.profile.root)?.cursor).toBe(0);
});

it("honors failing commit hooks, preserves saved work, and blocks a no-op retry until it is resolved", async () => {
  const f = fixture();
  f.activity("I own onboarding.");
  const hook = join(f.profile.root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  f.respond(async (_workspace, tools) => {
    await call(tools, "write_file", {
      path: f.document.path,
      content: `${f.document.content}\nI own onboarding.\n`,
    });
    await call(tools, "commit_profile", { summary: "record responsibility" });
    return "Updated.";
  });
  const head = f.git("rev-parse", "HEAD");
  await f.learning.run();
  expect(f.learning.status().error).toContain("Profile saved, but not committed");
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(f.profile.root, f.document.path), "utf8")).toContain("I own onboarding");
  f.respond(async () => "No changes.");
  await f.learning.run();
  expect(f.learning.status().error).toContain("uncommitted changes");
  expect(f.store.profileLearningState(f.profile.root)).toMatchObject({
    cursor: 0,
    lastSuccess: null,
    provisionalMemory: "",
  });
});

it("lets the agent repair drafts, reorganize documents, and commit only its own files", async () => {
  const f = fixture();
  writeFileSync(join(f.profile.root, "unrelated.txt"), "Unrelated staged work");
  f.git("add", "--", "unrelated.txt");
  f.respond(async (_workspace, tools) => {
    await call(tools, "write_file", { path: "draft.md", content: "Draft needing metadata" });
    await expect(call(tools, "check_profile")).rejects.toThrow("YAML frontmatter");
    await call(tools, "edit_file", {
      path: "draft.md",
      oldText: "Draft needing metadata",
      newText: "---\ntype: Team\ntitle: Partners\n---\nTeam context\n",
    });
    await call(tools, "move_file", { from: "draft.md", to: "team/partners.md" });
    await call(tools, "write_file", {
      path: "obsolete.md",
      content: "---\ntype: Note\n---\nTemporary\n",
    });
    await call(tools, "delete_file", { path: "obsolete.md" });
    const index = readFileSync(join(f.profile.root, "index.md"), "utf8");
    await call(tools, "write_file", {
      path: "index.md",
      content: `${index}\n- [Partners](team/partners.md)\n`,
    });
    await call(tools, "commit_profile", { summary: "organize team context" });
    return "Created team context.";
  });
  await f.learning.run();
  expect(f.learning.status().error).toBeNull();
  expect(f.git("status", "--porcelain")).toBe("A  unrelated.txt");
  expect(f.git("show", "--format=", "--name-only", "HEAD").split("\n").sort()).toEqual([
    "index.md",
    "team/partners.md",
  ]);
  expect(existsSync(join(f.profile.root, "draft.md"))).toBe(false);
});

it("keeps tools inside the profile and artifacts, and prevents writing the activity evidence", async () => {
  const f = fixture();
  const outside = join(f.root, "outside.md");
  writeFileSync(outside, "Original");
  symlinkSync(outside, join(f.profile.root, "linked.md"));
  const missing = join(f.root, "missing.md");
  symlinkSync(missing, join(f.profile.root, "dangling.md"));
  f.respond(async (workspace, tools) => {
    for (const path of [
      outside,
      "../outside.md",
      ".git/config",
      "linked.md",
      "dangling.md",
      workspace.activityPath,
    ]) {
      await expect(call(tools, "write_file", { path, content: "Overwritten" })).rejects.toThrow();
    }
    await expect(
      call(tools, "read_file", { path: outside, startLine: null, endLine: null }),
    ).rejects.toThrow();
    return "No changes.";
  });
  await f.learning.run();
  expect(f.learning.status().error).toBeNull();
  expect(readFileSync(outside, "utf8")).toBe("Original");
  expect(existsSync(missing)).toBe(false);
});

it("preserves scoped conversation context across checkpoints", () => {
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
