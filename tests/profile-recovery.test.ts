import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ProfileLearningTool } from "../server/application/profile-learning-model.js";
import { Profile } from "../server/profile.js";
import { runProfileEditing } from "../server/profile-learning-workspace.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pa-recovery-"));
  const profile = new Profile(root);
  profile.initialize();
  const doc = profile.change("add context", () =>
    profile.create("Team", "Team", "Original context"),
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  return { root, profile, doc, git };
}
async function call(tools: ProfileLearningTool[], name: string, args: unknown = {}) {
  const tool = tools.find((tool) => tool.name === name);
  if (!tool) throw new Error("Missing tool");
  return tool.execute(args);
}
const message = {
  summary: "record team responsibility",
  body: "Record the team's confirmed responsibility for partner enablement.",
};

it("resumes an owned interrupted draft across instances and exposes its original failure", async () => {
  const f = fixture();
  await expect(
    runProfileEditing(f.profile, {}, async (_workspace, tools) => {
      await call(tools, "write_file", {
        path: f.doc.path,
        content: `${f.doc.content}\nPartner enablement\n`,
      });
      throw new Error("Provider interrupted");
    }),
  ).rejects.toThrow("Provider interrupted");
  await runProfileEditing(new Profile(f.root), {}, async (workspace, tools) => {
    const recovery = JSON.parse(readFileSync(workspace.artifactPaths["recovery.json"], "utf8"));
    expect(recovery.error).toBe("Provider interrupted");
    expect(recovery.entries[f.doc.path].after).toContain("Partner enablement");
    await call(tools, "commit_profile", message);
    return "Recovered and committed";
  });
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.git("log", "-1", "--format=%B")).toContain(message.body);
});

it("preserves manual edits to an interrupted draft instead of adopting them", async () => {
  const f = fixture();
  await expect(
    runProfileEditing(f.profile, {}, async (_workspace, tools) => {
      await call(tools, "write_file", {
        path: f.doc.path,
        content: `${f.doc.content}\nAgent draft\n`,
      });
      throw new Error("Interrupted");
    }),
  ).rejects.toThrow();
  const manual = `${f.doc.content}\nUser correction\n`;
  writeFileSync(join(f.root, f.doc.path), manual);
  await expect(
    runProfileEditing(new Profile(f.root), {}, async () => "No changes"),
  ).rejects.toThrow("changed outside the agent");
  expect(readFileSync(join(f.root, f.doc.path), "utf8")).toBe(manual);
});

it("allows another task to update clean documents without adopting a dirty draft", async () => {
  const f = fixture();
  const dirty = `${f.doc.content}\nPersonal unfinished edit\n`;
  writeFileSync(join(f.root, f.doc.path), dirty);
  await runProfileEditing(
    f.profile,
    {},
    async (_workspace, tools) => {
      await expect(
        call(tools, "write_file", { path: f.doc.path, content: "Overwrite" }),
      ).rejects.toThrow("uncommitted changes");
      await call(tools, "write_file", {
        path: "other.md",
        content: "---\ntype: Topic\ntitle: Other\n---\nIndependent knowledge\n",
      });
      await call(tools, "commit_profile", message);
      return "Updated another topic";
    },
    () => {},
    "other-task",
  );
  expect(readFileSync(join(f.root, f.doc.path), "utf8")).toBe(dirty);
  expect(f.git("show", "--format=", "--name-only", "HEAD")).toBe("other.md");
});

it("recovers staged agent edits after a failing hook without bypassing the hook", async () => {
  const f = fixture();
  const hook = join(f.root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  await expect(
    runProfileEditing(f.profile, {}, async (_workspace, tools) => {
      await call(tools, "write_file", {
        path: f.doc.path,
        content: `${f.doc.content}\nNew responsibility\n`,
      });
      await call(tools, "commit_profile", message);
      return "Done";
    }),
  ).rejects.toThrow("not committed");
  writeFileSync(hook, "#!/bin/sh\nexit 0\n");
  await runProfileEditing(new Profile(f.root), {}, async (_workspace, tools) => {
    await call(tools, "commit_profile", message);
    return "Recovered";
  });
  expect(f.git("status", "--porcelain")).toBe("");
});

it("keeps conventional subjects short and puts legacy detailed summaries in the body", () => {
  const f = fixture();
  const summary = `docs(profile): docs(profile): ${"Detailed project finding ".repeat(10)}`;
  f.profile.change(summary, () =>
    f.profile.save(f.doc.path, `${f.doc.content}\nNew fact\n`, f.doc.hash),
  );
  const subject = f.git("log", "-1", "--format=%s");
  expect(subject.length).toBeLessThanOrEqual(72);
  expect(subject.match(/docs\(profile\):/g)).toHaveLength(1);
  expect(f.git("log", "-1", "--format=%b")).toContain("Detailed project finding ".repeat(5));
});

it("allows the agent to repair an invalid draft left by an interruption", async () => {
  const f = fixture();
  await expect(
    runProfileEditing(f.profile, {}, async (_workspace, tools) => {
      await call(tools, "write_file", {
        path: "draft.md",
        content: "Incomplete draft without frontmatter",
      });
      throw new Error("Interrupted while drafting");
    }),
  ).rejects.toThrow("Interrupted");
  await runProfileEditing(new Profile(f.root), {}, async (_workspace, tools) => {
    await call(tools, "write_file", {
      path: "draft.md",
      content: "---\ntype: Topic\ntitle: Recovered\n---\nVerified knowledge\n",
    });
    await call(tools, "commit_profile", message);
    return "Repaired";
  });
  expect(f.git("status", "--porcelain")).toBe("");
});

it("refuses to adopt external staged changes even when the working file still matches its draft", async () => {
  const f = fixture();
  const draft = `${f.doc.content}\nAgent draft\n`;
  await expect(
    runProfileEditing(f.profile, {}, async (_workspace, tools) => {
      await call(tools, "write_file", { path: f.doc.path, content: draft });
      throw new Error("Interrupted");
    }),
  ).rejects.toThrow();
  writeFileSync(join(f.root, f.doc.path), `${f.doc.content}\nUser staged edit\n`);
  f.git("add", "--", f.doc.path);
  writeFileSync(join(f.root, f.doc.path), draft);
  await expect(
    runProfileEditing(new Profile(f.root), {}, async () => "No changes"),
  ).rejects.toThrow("external staged edits");
  expect(f.git("show", `:${f.doc.path}`)).toContain("User staged edit");
});
