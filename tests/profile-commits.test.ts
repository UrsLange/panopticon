import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Profile } from "../server/profile.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pa-commits-"));
  const profile = new Profile(root);
  profile.initialize();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  return { root, profile, git };
}

it("commits initialization and each complete operation, skipping unchanged navigation", () => {
  const { root, profile, git } = fixture();
  expect(git("log", "-1", "--format=%s")).toBe("docs(profile): initialize personal context");
  expect(git("status", "--porcelain")).toBe("");
  const document = profile.change("add project context", () => {
    const doc = profile.create("Example", "Project", "Project context");
    profile.reconcileIndex();
    return doc;
  });
  expect(git("rev-list", "--count", "HEAD")).toBe("2");
  expect(git("show", "--format=", "--name-only", "HEAD").split("\n").sort()).toEqual(
    ["index.md", document.path].sort(),
  );
  expect(git("show", `HEAD:${document.path}`)).toBe(
    readFileSync(join(root, document.path), "utf8").trim(),
  );
  const head = git("rev-parse", "HEAD");
  profile.change("refresh profile navigation", () => profile.reconcileIndex());
  expect(git("rev-parse", "HEAD")).toBe(head);
});

it("preserves unrelated staged and unstaged edits and treats filenames literally", () => {
  const { root, profile, git } = fixture();
  writeFileSync(join(root, "unrelated.txt"), "staged");
  git("add", "--", "unrelated.txt");
  writeFileSync(join(root, "unrelated.txt"), "unstaged");
  writeFileSync(join(root, "private.txt"), "untracked");
  const before = git("status", "--porcelain");
  profile.change("add literal filename", () => {
    profile.prepareWrite(":(glob)*.md");
    writeFileSync(join(root, ":(glob)*.md"), "---\ntype: Note\n---\nFact\n");
  });
  expect(git("show", "--format=", "--name-only", "HEAD")).toBe(":(glob)*.md");
  expect(git("status", "--porcelain")).toBe(before);
  expect(git("show", ":unrelated.txt")).toBe("staged");
  expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("unstaged");
});

it("rejects dirty targets before overwriting them and leaves history unchanged", () => {
  const { root, profile, git } = fixture();
  const head = git("rev-parse", "HEAD");
  const path = join(root, "index.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}Personal edit\n`);
  const before = readFileSync(path, "utf8");
  expect(() =>
    profile.change("edit index", () => {
      const doc = profile.documents()[0];
      profile.save(doc.path, `${doc.content}New text\n`, doc.hash);
    }),
  ).toThrow("uncommitted changes in index.md");
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(git("rev-parse", "HEAD")).toBe(head);
});

it("honors failing hooks and retains saved files with an explicit commit error", () => {
  const { root, profile, git } = fixture();
  const head = git("rev-parse", "HEAD");
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'test hook rejected commit' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  expect(() =>
    profile.change("add context", () => profile.create("Fact", "Note", "Keep this")),
  ).toThrow("Profile saved, but not committed.");
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(profile.documents().find((doc) => doc.type === "Note")?.content).toContain("Keep this");
  expect(existsSync(join(root, ".git", "pa-profile.lock"))).toBe(false);
});

it("excludes concurrent operations through another profile instance or filesystem alias", async () => {
  const { root, profile, git } = fixture();
  const alias = join(mkdtempSync(join(tmpdir(), "pa-commit-alias-")), "profile");
  symlinkSync(root, alias);
  let resume = () => {};
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const active = profile.change("add delayed context", async () => {
    await wait;
    profile.create("Delayed", "Note", "Fact");
  });
  expect(() => profile.change("overlap on same instance", () => {})).toThrow("being updated");
  expect(() => new Profile(alias).change("add conflicting context", () => {})).toThrow(
    "being updated",
  );
  resume();
  await active;
  new Profile(root).change("refresh navigation", () => {});
  expect(git("status", "--porcelain")).toBe("");
});

it("does not commit rejected model work and releases the operation lock", async () => {
  const { profile, git } = fixture();
  const head = git("rev-parse", "HEAD");
  await expect(
    profile.change("add context", async () => {
      profile.create("Unverified", "Note", "Unverified fact");
      throw new Error("Validation failed");
    }),
  ).rejects.toThrow("Validation failed");
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(git("status", "--porcelain")).toContain("??");
  profile.change("check lock released", () => {});
});

it.each([false, true])(
  "recovers a terminated owner's lock while preserving saved work: %s",
  (writeBeforeExit) => {
    const { root, profile, git } = fixture();
    const module = new URL("../server/profile.ts", import.meta.url).href;
    execFileSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { Profile } from ${JSON.stringify(module)};
    const profile = new Profile(${JSON.stringify(root)});
    profile.change("interrupted update", () => {
      if (${writeBeforeExit}) profile.create("Saved before exit", "Note", "Keep this draft");
      process.exit(0);
    });`,
    ]);
    expect(existsSync(join(root, ".git", "pa-profile.lock"))).toBe(true);
    const before = profile.documents();
    profile.change("recover after restart", () => {});
    expect(existsSync(join(root, ".git", "pa-profile.lock"))).toBe(false);
    expect(profile.documents()).toEqual(before);
    const draft = before.find((doc) => doc.type === "Note");
    if (writeBeforeExit) {
      if (!draft) throw new Error("Missing saved draft");
      expect(() =>
        profile.change("replace interrupted work", () =>
          profile.save(draft.path, `${draft.content}New fact\n`, draft.hash),
        ),
      ).toThrow("uncommitted changes");
      expect(readFileSync(join(root, draft.path), "utf8")).toBe(draft.content);
    }
    const document = profile.change("save after restart", () =>
      profile.create("New fact", "Note", "New fact"),
    );
    expect(git("show", "--format=", "--name-only", "HEAD")).toBe(document.path);
    expect(git("status", "--porcelain")).toBe(writeBeforeExit ? `?? ${draft?.path}` : "");
  },
);

it("recovers empty legacy locks and recognizes a reused process ID", () => {
  const { root, profile } = fixture();
  const lock = join(root, ".git", "pa-profile.lock");
  mkdirSync(lock);
  profile.change("recover legacy lock", () => {});
  expect(existsSync(lock)).toBe(false);
  mkdirSync(lock);
  writeFileSync(
    join(lock, "owner-deadbeef.json"),
    JSON.stringify({ pid: process.pid, startedAt: "Thu Jan  1 00:00:00 1970" }),
  );
  profile.change("recover reused PID", () => {});
  expect(existsSync(lock)).toBe(false);
});

it("allows only one process to recover an abandoned lock at a time", async () => {
  const { root } = fixture();
  const lock = join(root, ".git", "pa-profile.lock");
  mkdirSync(lock);
  writeFileSync(
    join(lock, "owner-deadbeef.json"),
    JSON.stringify({ pid: process.pid, startedAt: "Thu Jan  1 00:00:00 1970" }),
  );
  const module = new URL("../server/profile.ts", import.meta.url).href;
  const source = `
    import { Profile } from ${JSON.stringify(module)};
    import { once } from "node:events";
    process.send("ready");
    const [command] = await once(process, "message");
    if (command === "go") {
      try {
        await new Profile(${JSON.stringify(root)}).change("recover concurrently", async () => {
          const release = once(process, "message");
          process.send("acquired");
          await release;
        });
      } catch (error) {
        if (!error.message.includes("being updated")) throw error;
        process.send("busy");
      }
    }
    process.disconnect();
  `;
  const children = [0, 1].map(() =>
    spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  );
  const exited = children.map((child) => once(child, "exit"));
  try {
    await Promise.all(children.map((child) => once(child, "message")));
    const outcomes = children.map((child) => once(child, "message"));
    for (const child of children) child.send("go");
    expect((await Promise.all(outcomes)).map(([message]) => message).sort()).toEqual([
      "acquired",
      "busy",
    ]);
    expect(existsSync(lock)).toBe(true);
  } finally {
    for (const child of children) {
      if (child.connected) child.send("release", () => {});
    }
    const results = await Promise.all(exited);
    expect(results.map(([code]) => code)).toEqual([0, 0]);
  }
  expect(existsSync(lock)).toBe(false);
});
