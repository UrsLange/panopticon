import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ExplorationError, type ProjectExploration } from "../server/application/exploration.js";
import { dueSlot } from "../server/application/project-documents.js";
import { createApp } from "../server/bootstrap.js";
import { config } from "../server/config.js";
import { Profile } from "../server/profile.js";
import { createProjectScanner, repositorySnapshot } from "../server/projects.js";
import { SettingsStore } from "../server/settings.js";
import { Store } from "../server/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pa-projects-"));
  const projects = join(root, "repositories");
  mkdirSync(projects);
  const profile = new Profile(join(root, "profile"));
  profile.initialize();
  const settings = new SettingsStore({
    ...config,
    dataDir: join(root, "data"),
    profileDir: profile.root,
    apiKey: "",
    keyFile: "",
  });
  settings.saveProjectRoots([projects]);
  const repo = join(projects, "example");
  mkdirSync(repo);
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# Example\nAn app for team onboarding.");
  return { root, projects, profile, settings, repo };
}
async function explore({ document }: ProjectExploration) {
  return document.content.replace(
    /<!-- project-summary:start -->[\s\S]*?<!-- project-summary:end -->/,
    "<!-- project-summary:start -->\n## Purpose\nTeam onboarding\n\n## Sources\n- README.md\n<!-- project-summary:end -->",
  );
}

it("does not commit external index edits made while a model reviews a project", async () => {
  const { settings, profile, repo } = fixture();
  await createProjectScanner(settings, explore).run();
  writeFileSync(join(repo, "new.ts"), "new source");
  const index = join(profile.root, "index.md");
  const scanner = createProjectScanner(settings, async (request) => {
    writeFileSync(index, `${readFileSync(index, "utf8")}External personal edit\n`);
    return explore(request);
  });
  await scanner.run();
  expect(scanner.status().error).toBeNull();
  expect(
    execFileSync("git", ["-C", profile.root, "show", "HEAD:index.md"], { encoding: "utf8" }),
  ).not.toContain("External personal edit");
  expect(readFileSync(index, "utf8")).toContain("External personal edit");
  expect(
    execFileSync("git", ["-C", profile.root, "status", "--porcelain"], { encoding: "utf8" }).trim(),
  ).toBe("M index.md");
});

it("rejects empty summaries and preserves profile content after a failed model request", async () => {
  const { settings, profile } = fixture();
  const empty = createProjectScanner(settings, async ({ document }) => document.content);
  await empty.run();
  expect(empty.status().projects[0].error).toContain("empty summary");
  expect(readFileSync(join(profile.root, "index.md"), "utf8")).toContain(
    `(${empty.status().projects[0].document})`,
  );
  const before = profile.documents();
  const failed = createProjectScanner(settings, async () => {
    throw new ExplorationError({
      category: "provider",
      message: "Project discovery provider failed",
    });
  });
  await failed.run();
  expect(failed.status().projects[0].diagnostic?.category).toBe("provider");
  expect(profile.documents()).toEqual(before);
  const retry = createProjectScanner(settings, explore);
  await retry.run();
  expect(retry.status().error).toBeNull();
});

it("reports edits outside the summary without accepting the new fingerprint", async () => {
  const { settings, profile, repo } = fixture();
  await createProjectScanner(settings, explore).run();
  const before = profile.documents().find((doc) => doc.type === "Project");
  writeFileSync(join(repo, "source.ts"), "new source");
  const scanner = createProjectScanner(settings, async ({ document }) => {
    return document.content.replace("## Personal notes", "## Removed notes");
  });
  await scanner.run();
  expect(scanner.status().projects[0].error).toContain("protected profile content");
  const after = profile.documents().find((doc) => doc.type === "Project");
  expect(after).toEqual(before);
});

it.each(["frontmatter", "yaml", "metadata", "markers"])(
  "rejects invalid %s in a draft without damaging the profile or blocking a retry",
  async (failure) => {
    const { settings, profile, repo } = fixture();
    await createProjectScanner(settings, explore).run();
    const before = profile.documents();
    const head = execFileSync("git", ["-C", profile.root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    writeFileSync(join(repo, "new.ts"), "new source");
    const scanner = createProjectScanner(settings, async (request) => {
      const content = await explore(request);
      if (failure === "frontmatter") return "# No frontmatter";
      if (failure === "yaml") return "---\ntype: [\n---\n";
      if (failure === "metadata") return content.replace("type: Project", "type: Note");
      return content.replace("## Purpose", "<!-- project-summary:start -->\n## Purpose");
    });
    await scanner.run();
    expect(scanner.status().projects[0]).toMatchObject({
      outcome: "failed",
      diagnostic: { category: "validation" },
    });
    expect(profile.documents()).toEqual(before);
    expect(profile.context("onboarding").documents.length).toBeGreaterThan(0);
    expect(
      execFileSync("git", ["-C", profile.root, "rev-parse", "HEAD"], { encoding: "utf8" }),
    ).toBe(head);
    expect(
      execFileSync("git", ["-C", profile.root, "status", "--porcelain"], { encoding: "utf8" }),
    ).toBe("");
    const retry = createProjectScanner(settings, explore);
    await retry.run();
    expect(retry.status().error).toBeNull();
  },
);

it("keeps profile reads and edits available during discovery and rejects stale drafts", async () => {
  const { settings, profile, repo } = fixture();
  await createProjectScanner(settings, explore).run();
  writeFileSync(join(repo, "new.ts"), "new source");
  let enter = () => {};
  let resume = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const scanner = createProjectScanner(settings, async (request) => {
    enter();
    await gate;
    return explore(request);
  });
  const store = new Store(":memory:");
  const app = createApp({ settings, profile, store, projectScanner: scanner, assistant: null });
  const headers = { host: "127.0.0.1:4317" };
  const running = scanner.run();
  try {
    await entered;
    const response = await app.inject({ method: "GET", url: "/api/profile", headers });
    expect(response.statusCode).toBe(200);
    const document = profile.documents().find((doc) => doc.type === "Project");
    if (!document) throw new Error("Missing project document");
    expect(
      profile.context("onboarding").documents.some((doc) => doc.content.includes("Partial output")),
    ).toBe(false);
    const updated = `${document.content}Concurrent personal note\n`;
    const saved = await app.inject({
      method: "PUT",
      url: "/api/profile",
      headers,
      payload: { path: document.path, hash: document.hash, content: updated },
    });
    expect(saved.statusCode).toBe(200);
    resume();
    await running;
    expect(scanner.status().projects[0].error).toContain("changed during review");
    expect(readFileSync(join(profile.root, document.path), "utf8")).toBe(updated);
  } finally {
    resume();
    await running;
    await app.close();
    store.db.close();
  }
});

it("indexes only direct child Git repositories and preserves manual notes and timestamps on unchanged scans", async () => {
  const { projects, profile, settings, repo } = fixture();
  mkdirSync(join(projects, "container", "nested"), { recursive: true });
  execFileSync("git", ["init", join(projects, "container", "nested")], { stdio: "ignore" });
  symlinkSync(repo, join(projects, "alias"));
  let calls = 0;
  let now = new Date("2026-09-17T08:00:00Z");
  const scanner = createProjectScanner(
    settings,
    async (request) => {
      calls++;
      return explore(request);
    },
    () => now,
  );
  await scanner.run();
  expect(scanner.status().projects).toHaveLength(1);
  expect(calls).toBe(1);
  const doc = profile.documents().find((doc) => doc.type === "Project");
  if (!doc) throw new Error("No project document");
  expect(doc.content).toContain("updated_at:");
  expect(doc.content).not.toContain("last_scanned");
  expect(doc.content).not.toContain("invented.md");
  profile.change("add personal project context", () =>
    profile.save(doc.path, `${doc.content}My own context: keep this.\n`, doc.hash),
  );
  const saved = readFileSync(join(profile.root, doc.path), "utf8");
  now = new Date("2026-09-18T08:00:00Z");
  await scanner.run();
  expect(calls).toBe(1);
  expect(readFileSync(join(profile.root, doc.path), "utf8")).toBe(saved);
  writeFileSync(join(repo, "README.md"), "# Example\nNew documentation.");
  await scanner.run();
  expect(calls).toBe(2);
  const updated = readFileSync(join(profile.root, doc.path), "utf8");
  expect(updated).toContain("My own context: keep this.");
  expect(updated).toContain("2026-09-17T08:00:00.000Z");
  expect(updated).not.toBe(saved);
});

it("retries failed reviews without advancing the fingerprint and detects edits during review", async () => {
  const { profile, settings, repo } = fixture();
  let fail = false;
  let calls = 0;
  const scanner = createProjectScanner(settings, async (request) => {
    calls++;
    if (fail) throw new Error("Provider failure");
    return explore(request);
  });
  await scanner.run();
  const doc = profile.documents().find((doc) => doc.type === "Project");
  if (!doc) throw new Error("No document");
  writeFileSync(join(repo, "README.md"), "Changed");
  fail = true;
  await scanner.run();
  expect(scanner.status().error).toBeTruthy();
  expect(readFileSync(join(profile.root, doc.path), "utf8")).toBe(doc.content);
  fail = false;
  await scanner.run();
  expect(calls).toBe(3);
  writeFileSync(join(repo, "README.md"), "Changed again");
  const racing = createProjectScanner(settings, async (request) => {
    writeFileSync(join(repo, "README.md"), "Changed during review");
    return explore(request);
  });
  await racing.run();
  expect(racing.status().projects[0].error).toContain("changed during");
});

it("does not read credentials or follow documentation symlinks and detects dirty and untracked changes", async () => {
  const { repo, root } = fixture();
  writeFileSync(join(repo, ".env"), "SECRET=do-not-read");
  writeFileSync(join(root, "outside.md"), "private outside file");
  mkdirSync(join(repo, "docs"));
  symlinkSync(join(root, "outside.md"), join(repo, "docs", "overview.md"));
  const before = await repositorySnapshot(repo);
  expect(JSON.stringify(before)).not.toContain("do-not-read");
  expect(JSON.stringify(before)).not.toContain("private outside");
  writeFileSync(join(repo, "code.ts"), "export const value = 1;");
  const after = await repositorySnapshot(repo);
  expect(after.fingerprint).not.toBe(before.fingerprint);
  execFileSync("git", ["-C", repo, "add", "code.ts"], { stdio: "ignore" });
  expect((await repositorySnapshot(repo)).fingerprint).not.toBe(after.fingerprint);
});

it("retains missing project knowledge and recovers index state from the profile", async () => {
  const { root, profile, settings, repo } = fixture();
  const scanner = createProjectScanner(settings, explore);
  await scanner.run();
  renameSync(repo, join(root, "moved-away"));
  scanner.reset();
  await scanner.run();
  expect(scanner.status().projects[0].availability).toBe("missing");
  expect(profile.documents().find((doc) => doc.type === "Project")?.content).toContain(
    "availability: missing",
  );
  expect(readFileSync(join(profile.root, "index.md"), "utf8")).toContain(
    `(${scanner.status().projects[0].document}) — unavailable`,
  );
});

it("repairs the index on scheduled checks and with no configured roots", async () => {
  const { settings, profile } = fixture();
  let calls = 0;
  const scanner = createProjectScanner(settings, async (request) => {
    calls++;
    return explore(request);
  });
  await scanner.run(true);
  const project = profile.documents().find((doc) => doc.type === "Project");
  if (!project) throw new Error("No project document");
  renameSync(join(profile.root, project.path), join(profile.root, "renamed.md"));
  await scanner.run(true);
  expect(calls).toBe(1);
  expect(readFileSync(join(profile.root, "index.md"), "utf8")).toContain("(renamed.md)");
  settings.saveProjectRoots([]);
  scanner.invalidate();
  const manual = profile.create("Manual project", "Project", "");
  await scanner.run(true);
  expect(scanner.status().error).toBeNull();
  expect(readFileSync(join(profile.root, "index.md"), "utf8")).toContain(`(${manual.path})`);
  expect(readFileSync(join(profile.root, "index.md"), "utf8")).toContain("(renamed.md)");
});

it("keeps projects linked when a root cannot be read", async () => {
  const { settings, profile, projects, root } = fixture();
  const scanner = createProjectScanner(settings, explore);
  await scanner.run();
  const before = readFileSync(join(profile.root, "index.md"), "utf8");
  renameSync(projects, join(root, "inaccessible"));
  await scanner.run();
  expect(scanner.status().error).toContain("Cannot read project root");
  expect(readFileSync(join(profile.root, "index.md"), "utf8")).toBe(before);
});

it("reports index failures without completing the scan and repairs them on retry", async () => {
  const { settings, profile } = fixture();
  const index = join(profile.root, "index.md");
  writeFileSync(index, "---\ntype: Collection\n---\n<!-- projects:start -->\n");
  const scanner = createProjectScanner(settings, explore);
  await scanner.run(true);
  expect(scanner.status().error).toContain("Profile index reconciliation failed");
  expect(scanner.status().lastSuccess).toBeNull();
  expect(scanner.status().completedSlot).toBeNull();
  const retry = scanner.status().nextRetry;
  await scanner.run(true);
  expect(scanner.status().nextRetry).toBe(retry);
  writeFileSync(index, "---\ntype: Collection\n---\nMy notes\n");
  execFileSync("git", ["-C", profile.root, "add", "--", "index.md"]);
  execFileSync("git", ["-C", profile.root, "commit", "-m", "docs(profile): repair index"]);
  await scanner.run();
  expect(scanner.status().error).toBeNull();
  expect(scanner.status().completedSlot).not.toBeNull();
  expect(readFileSync(index, "utf8")).toContain(`(${scanner.status().projects[0].document})`);
});

it("coalesces concurrent scans and catches up a missed 8am slot across restart", async () => {
  const { settings } = fixture();
  let calls = 0;
  const now = () => new Date("2026-09-17T09:00:00Z");
  const scanner = createProjectScanner(
    settings,
    async (request: ProjectExploration) => {
      calls++;
      return explore(request);
    },
    now,
  );
  await Promise.all([scanner.run(true), scanner.run(true)]);
  expect(calls).toBe(1);
  const restarted = createProjectScanner(
    settings,
    async (request) => {
      calls++;
      return explore(request);
    },
    now,
  );
  await restarted.run(true);
  expect(calls).toBe(1);
  expect(dueSlot(new Date("2026-09-17T05:59:00Z"), "Europe/Berlin")).toBe(
    "Europe/Berlin:2026-09-16",
  );
  expect(dueSlot(new Date("2026-09-17T06:00:00Z"), "Europe/Berlin")).toBe(
    "Europe/Berlin:2026-09-17",
  );
  expect(dueSlot(new Date("2026-10-25T07:00:00Z"), "Europe/Berlin")).toBe(
    "Europe/Berlin:2026-10-25",
  );
});

it("recognizes Git worktrees as direct child repositories", async () => {
  const { projects, settings, repo } = fixture();
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "test: create worktree fixture"], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", join(projects, "worktree")], {
    stdio: "ignore",
  });
  const scanner = createProjectScanner(settings, explore);
  await scanner.run();
  expect(scanner.status().projects.map((project) => project.name)).toEqual(["example", "worktree"]);
  expect(scanner.status().error).toBeNull();
});

it("accepts newline normalization while restoring personal notes byte for byte", async () => {
  const { settings, profile } = fixture();
  let original = "";
  const scanner = createProjectScanner(settings, async (request) => {
    original = request.document.content;
    return (await explore(request)).replace(/\n\n$/, "\n");
  });
  await scanner.run();
  expect(scanner.status().error).toBeNull();
  expect(scanner.status().projects[0].outcome).toBe("updated");
  const content = profile.documents().find((doc) => doc.type === "Project")?.content ?? "";
  expect(content.split("<!-- project-summary:end -->")[1]).toBe(
    original.split("<!-- project-summary:end -->")[1],
  );
  expect(content).toContain("repository_fingerprint:");
});

it("publishes current activity and completed results before a scan finishes", async () => {
  const { settings, projects } = fixture();
  const second = join(projects, "second");
  mkdirSync(second);
  execFileSync("git", ["init", second], { stdio: "ignore" });
  let enter = () => {};
  let resume = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const scanner = createProjectScanner(settings, async (request) => {
    if (request.repository === second) {
      request.onProgress?.({ phase: "reading", filesRead: 4, responseId: "response-test" });
      enter();
      await release;
    }
    return explore(request);
  });
  const running = scanner.run();
  await entered;
  expect(scanner.status()).toMatchObject({ running: true, completed: 1, total: 2 });
  expect(scanner.status().projects[0]).toMatchObject({ phase: "done", outcome: "updated" });
  expect(scanner.status().projects[1]).toMatchObject({
    phase: "reading",
    filesRead: 4,
    responseId: "response-test",
  });
  const recovered = createProjectScanner(settings).status();
  expect(recovered.running).toBe(false);
  expect(recovered.error).toContain("interrupted");
  expect(recovered.projects[0].outcome).toBe("updated");
  expect(recovered.projects[1].phase).toBe("interrupted");
  resume();
  await running;
  expect(scanner.status()).toMatchObject({ running: false, completed: 2 });
});

it("retains provider diagnostics and retries only selected failures", async () => {
  const { settings, projects } = fixture();
  const second = join(projects, "second");
  mkdirSync(second);
  execFileSync("git", ["init", second], { stdio: "ignore" });
  const scanner = createProjectScanner(settings, async () => {
    throw new ExplorationError({
      category: "provider",
      message: "Project discovery provider unavailable",
      statusCode: 503,
    });
  });
  await scanner.run();
  const [first, other] = scanner.status().projects;
  let enter = () => {};
  let resume = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const calls: string[] = [];
  const retry = createProjectScanner(settings, async (request) => {
    calls.push(request.repository);
    enter();
    await release;
    return explore(request);
  });
  const running = retry.run(false, [first.id]);
  await entered;
  expect(retry.status().projects[0]).toMatchObject({ previousError: first.error, error: null });
  resume();
  await running;
  expect(calls).toEqual([first.path]);
  expect(retry.status().projects[0]).toMatchObject({
    outcome: "updated",
    error: null,
    previousError: null,
  });
  expect(retry.status().projects[1]).toMatchObject({
    id: other.id,
    diagnostic: { statusCode: 503 },
  });
  expect(retry.status().lastSuccess).toBeNull();
});

it("waits fifteen minutes after a long failed scan finishes before retrying", async () => {
  const { settings } = fixture();
  let now = new Date("2026-09-18T08:00:00Z");
  let calls = 0;
  const scanner = createProjectScanner(
    settings,
    async () => {
      calls++;
      now = new Date(now.getTime() + 20 * 60000);
      throw new Error("Project discovery provider unavailable");
    },
    () => now,
  );
  await scanner.run(true);
  expect(scanner.status().nextRetry).toBe("2026-09-18T08:35:00.000Z");
  await scanner.run(true);
  expect(calls).toBe(1);
  now = new Date("2026-09-18T08:35:00Z");
  await scanner.run(true);
  expect(calls).toBe(2);
});
