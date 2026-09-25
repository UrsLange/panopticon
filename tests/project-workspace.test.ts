import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createProjectWorkspace } from "../server/application/project-workspace.js";
import { createProjectWorkspaceIO, repositoryWebUrl } from "../server/project-repositories.js";
import { repositoryInsights } from "../server/repository-insights.js";
import { Store } from "../server/store.js";
import { type Project, projectAttention, projectNeedsAttention } from "../shared/projects.js";

const roots: string[] = [];
const stores: Store[] = [];
function version(project: Project) {
  assert(project.git);
  return project.git.version;
}
const identity = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};
function git(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...identity },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function fixture(persistent = false) {
  for (const [key, value] of Object.entries(identity)) vi.stubEnv(key, value);
  const root = mkdtempSync(join(tmpdir(), "project-workspace-"));
  roots.push(root);
  const directory = join(root, "projects");
  const profile = join(root, "profile");
  mkdirSync(directory);
  mkdirSync(profile);
  const remote = join(root, "remote.git");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  const repo = join(directory, "example");
  git(root, "clone", remote, repo);
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "test: initial");
  git(repo, "push", "-u", "origin", "main");
  const io = createProjectWorkspaceIO();
  const store = new Store(persistent ? join(root, "projects.sqlite") : ":memory:");
  stores.push(store);
  let selectedRoots = [directory];
  let clock = Date.now();
  const workspace = createProjectWorkspace({
    records: store,
    scope: () => ({ profile, roots: selectedRoots }),
    documents: () => [],
    io,
    now: () => new Date(clock).toISOString(),
  });
  return {
    root,
    directory,
    profile,
    remote,
    repo,
    io,
    store,
    workspace,
    removeRoot: () => {
      selectedRoots = [];
    },
    tick: () => {
      clock += 16000;
    },
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("discovers independent projects, skips symlinks and nested repositories, and persists preferences", async () => {
  const f = fixture();
  symlinkSync(f.repo, join(f.directory, "alias"));
  mkdirSync(join(f.directory, "container"));
  git(f.root, "init", join(f.directory, "container", "nested"));
  const state = await f.workspace.list();
  expect(state.projects).toHaveLength(1);
  const project = state.projects[0];
  expect(project).toMatchObject({
    name: "example",
    document: null,
    git: { branch: "main", dirty: false },
  });
  f.workspace.update(project.id, { returnToDefault: false });
  expect(f.store.projects(f.profile)[0].returnToDefault).toBe(false);
  expect(f.store.projects("/another-profile")).toEqual([]);
  f.removeRoot();
  expect((await f.workspace.list()).projects).toEqual([]);
  await expect(f.workspace.detail(project.id)).rejects.toThrow("not found");
});

it("persists hidden projects across refreshes and database restarts and allows restoring them", async () => {
  const f = fixture(true);
  const p = (await f.workspace.list()).projects[0];
  expect(p.hidden).toBe(false);
  f.workspace.update(p.id, { hidden: true });
  f.workspace.refresh();
  await f.workspace.close();
  expect((await f.workspace.list()).projects[0].hidden).toBe(true);
  expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe("initial\n");
  stores.splice(stores.indexOf(f.store), 1);
  f.store.db.close();
  const store = new Store(join(f.root, "projects.sqlite"));
  stores.push(store);
  const restarted = createProjectWorkspace({
    records: store,
    scope: () => ({ profile: f.profile, roots: [f.directory] }),
    documents: () => [],
    io: f.io,
    now: () => new Date().toISOString(),
  });
  expect((await restarted.list()).projects[0].hidden).toBe(true);
  expect((await restarted.detail(p.id)).project.hidden).toBe(true);
  restarted.update(p.id, { hidden: false });
  expect(store.projects(f.profile)[0].hidden).toBe(false);
  await restarted.close();
});

it.each([true, false])("preserves hidden=%s when a remote check finishes", async (hidden) => {
  const f = fixture();
  const p = (await f.workspace.list()).projects[0];
  f.workspace.update(p.id, { hidden: !hidden });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const checking = vi.spyOn(f.io, "refreshRemote").mockImplementation(() => gate);
  f.workspace.refresh();
  await vi.waitFor(() => expect(checking).toHaveBeenCalled());
  try {
    expect(f.workspace.update(p.id, { hidden }).hidden).toBe(hidden);
    expect((await f.workspace.list()).projects[0].hidden).toBe(hidden);
    expect(() => f.workspace.update(p.id, { hidden: !hidden, returnToDefault: false })).toThrow(
      "Wait for",
    );
  } finally {
    release();
    await f.workspace.close();
  }
  expect(f.store.projects(f.profile)[0].hidden).toBe(hidden);
});

it("preserves hiding while discovery finds an unavailable checkout", async () => {
  const f = fixture();
  const p = (await f.workspace.list()).projects[0];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(f.io, "discover").mockImplementation(async () => {
    await gate;
    return { repositories: [], errors: [] };
  });
  f.workspace.refresh();
  try {
    f.workspace.update(p.id, { hidden: true });
  } finally {
    release();
    await f.workspace.close();
  }
  expect(f.store.projects(f.profile)[0]).toMatchObject({
    hidden: true,
    error: "Checkout unavailable. Check its directory.",
  });
});

it.each([true, false])(
  "preserves hiding during a detail check with success=%s",
  async (success) => {
    const f = fixture();
    const p = (await f.workspace.list()).projects[0];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspect = f.io.inspect;
    const checking = vi.spyOn(f.io, "inspect").mockImplementation(async (path) => {
      await gate;
      if (!success) throw new Error("Checkout unavailable");
      return inspect(path);
    });
    const detail = f.workspace.detail(p.id);
    await vi.waitFor(() => expect(checking).toHaveBeenCalled());
    try {
      f.workspace.update(p.id, { hidden: true });
    } finally {
      release();
    }
    expect((await detail).project.hidden).toBe(true);
    expect(f.store.projects(f.profile)[0].hidden).toBe(true);
  },
);

it("migrates existing project records to visible by default", async () => {
  const f = fixture(true);
  await f.workspace.list();
  f.store.db.exec("UPDATE projects SET snapshot = json_remove(snapshot, '$.hidden')");
  await f.workspace.close();
  stores.splice(stores.indexOf(f.store), 1);
  f.store.db.close();
  const store = new Store(join(f.root, "projects.sqlite"));
  stores.push(store);
  expect(store.projects(f.profile)[0].hidden).toBe(false);
});

it("tracks incoming commits and fast-forward pulls without touching local work", async () => {
  const f = fixture();
  const other = join(f.root, "other");
  git(f.root, "clone", f.remote, other);
  writeFileSync(join(other, "remote.txt"), "incoming");
  git(other, "add", "remote.txt");
  git(other, "commit", "-m", "test: remote");
  git(other, "push");
  await f.workspace.list();
  f.workspace.refresh();
  await f.workspace.close();
  const p = (await f.workspace.list()).projects[0];
  expect(p.git?.behind).toBe(1);
  expect(p.remoteCheckedAt).toBeTruthy();
  expect(projectAttention(p).incoming).toBe("Pull updates");
  const result = await f.workspace.action(p.id, { action: "pull", version: version(p) });
  expect(result.project.git?.behind).toBe(0);
  expect(readFileSync(join(f.repo, "remote.txt"), "utf8")).toBe("incoming");
  expect(projectNeedsAttention(result.project)).toBe(false);
});

it("rejects stale actions and commits selected files without including unrelated staged work", async () => {
  const f = fixture();
  const p = (await f.workspace.list()).projects[0];
  writeFileSync(join(f.repo, "chosen.txt"), "chosen");
  writeFileSync(join(f.repo, "other.txt"), "other");
  git(f.repo, "add", "other.txt");
  await expect(
    f.workspace.action(p.id, {
      action: "commit",
      version: version(p),
      files: ["chosen.txt"],
      message: "feat: chosen",
    }),
  ).rejects.toThrow("checkout changed");
  const before = await f.workspace.detail(p.id);
  const result = await f.workspace.action(p.id, {
    action: "commit",
    version: version(before.project),
    files: ["chosen.txt"],
    message: "feat: chosen",
  });
  expect(git(f.repo, "show", "--format=", "--name-only", "HEAD")).toBe("chosen.txt");
  expect(git(f.repo, "diff", "--cached", "--name-only")).toBe("other.txt");
  expect(result.project.git?.ahead).toBe(1);
});

it("respects commit hooks and does not amend a previous commit after failure", async () => {
  const f = fixture();
  const p = (await f.workspace.list()).projects[0];
  const head = git(f.repo, "rev-parse", "HEAD");
  writeFileSync(join(f.repo, "README.md"), "edited");
  writeFileSync(join(f.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  const detail = await f.workspace.detail(p.id);
  await expect(
    f.workspace.action(p.id, {
      action: "commit",
      version: version(detail.project),
      message: "fix: edit",
      files: ["README.md"],
    }),
  ).rejects.toThrow("Git could not complete");
  expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
  expect((await f.workspace.detail(p.id)).project.git?.dirty).toBe(true);
});

it("publishes commits and switches to the default branch only after work is safe", async () => {
  const f = fixture();
  git(f.repo, "switch", "-c", "feature");
  git(f.repo, "push", "-u", "origin", "feature");
  const p = (await f.workspace.list()).projects[0];
  writeFileSync(join(f.repo, "work.txt"), "work");
  git(f.repo, "add", "work.txt");
  git(f.repo, "commit", "-m", "feat: work");
  let detail = await f.workspace.detail(p.id);
  await expect(
    f.workspace.action(p.id, { action: "switch", version: version(detail.project) }),
  ).rejects.toThrow("Publish this branch");
  detail = await f.workspace.action(p.id, { action: "push", version: version(detail.project) });
  expect(detail.project.git?.ahead).toBe(0);
  detail = await f.workspace.action(p.id, {
    action: "switch",
    version: version(detail.project),
  });
  expect(detail.project.git?.branch).toBe("main");
  expect(git(f.repo, "branch", "--list", "feature")).toBe("feature");
});

it("refuses to pull dirty or diverged checkouts and exposes an explicit merge", async () => {
  const f = fixture();
  const other = join(f.root, "other");
  git(f.root, "clone", f.remote, other);
  writeFileSync(join(other, "remote.txt"), "remote");
  git(other, "add", "remote.txt");
  git(other, "commit", "-m", "feat: remote");
  git(other, "push");
  const p = (await f.workspace.list()).projects[0];
  writeFileSync(join(f.repo, "local.txt"), "local");
  let detail = await f.workspace.detail(p.id);
  await expect(
    f.workspace.action(p.id, { action: "pull", version: version(detail.project) }),
  ).rejects.toThrow("Commit your local");
  git(f.repo, "add", "local.txt");
  git(f.repo, "commit", "-m", "feat: local");
  detail = await f.workspace.detail(p.id);
  await expect(
    f.workspace.action(p.id, { action: "pull", version: version(detail.project) }),
  ).rejects.toThrow("diverged");
  detail = await f.workspace.detail(p.id);
  detail = await f.workspace.action(p.id, {
    action: "merge",
    version: version(detail.project),
  });
  expect(detail.project.git).toMatchObject({ behind: 0, dirty: false });
  expect(git(f.repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
});

it("reports unreadable roots and does not operate on replaced symlink checkouts", async () => {
  const f = fixture();
  const p = (await f.workspace.list()).projects[0];
  const result = await f.io.discover([join(f.root, "absent")], f.profile);
  expect(result.errors).toHaveLength(1);
  const alias = join(f.directory, "alias");
  symlinkSync(f.repo, alias);
  await expect(f.io.validate({ ...p, name: "alias", path: alias })).rejects.toThrow(
    "configured checkout",
  );
});

it("reads only requested reviews and Dependabot alerts and rejects invalid links", async () => {
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === "pr")
      return JSON.stringify([
        { number: 2, title: "Review me", url: "https://github.com/acme/app/pull/2" },
      ]);
    if (args.some((value) => value.includes("/dependabot/")))
      return [
        JSON.stringify({
          number: 1,
          title: "Dependency",
          url: "https://github.com/acme/app/security/dependabot/1",
          severity: "high",
        }),
        JSON.stringify({
          number: 3,
          title: "Invalid link",
          url: "https://evil.test/alert",
          severity: "high",
        }),
      ].join("\n");
    throw new Error("Forbidden");
  });
  const result = await repositoryInsights("https://github.com/acme/app", run);
  expect(result.reviews).toHaveLength(1);
  expect(result.findings).toHaveLength(1);
  expect(result.securityErrors).toEqual([]);
  expect(result.reviewError).toBeNull();
  expect(run.mock.calls.some(([args]) => args.includes("--paginate"))).toBe(true);
  expect(run).toHaveBeenCalledTimes(3);
  const securityCalls = run.mock.calls.filter(([args]) =>
    args.some((arg) => arg.includes("/dependabot/")),
  );
  expect(securityCalls).toHaveLength(1);
  expect(securityCalls[0][0]).toContain("repos/acme/app/dependabot/alerts?state=open&per_page=100");
  for (const [args] of securityCalls) {
    expect(args).not.toContain("--slurp");
    expect(args[args.indexOf("--jq") + 1]).toMatch(/^\.\[\] \| /);
  }
  const unavailable = await repositoryInsights("https://github.com/acme/app", async () => {
    throw new Error("No gh");
  });
  expect(unavailable.reviewError).toContain("GitHub CLI");
  expect(unavailable.securityErrors).toHaveLength(1);
  expect(unavailable.securityErrors[0]).toContain("Dependabot unavailable");
});

it("reads findings across pages and accepts empty security results", async () => {
  const findings = [1, 2].map((number) => ({
    number,
    title: `Dependency ${number}`,
    url: `https://github.com/acme/app/security/dependabot/${number}`,
    severity: "high",
  }));
  const result = await repositoryInsights("https://github.com/acme/app", async (args) => {
    if (args[0] === "pr") return "[]";
    if (args.some((value) => value.includes("/dependabot/")))
      return `${findings.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    return "";
  });
  expect(result.findings).toEqual(findings.map((entry) => ({ ...entry, source: "Dependabot" })));
  expect(result.securityErrors).toEqual([]);
  const empty = await repositoryInsights("https://github.com/acme/app", async (args) =>
    args[0] === "pr" ? "[]" : "",
  );
  expect(empty.findings).toEqual([]);
  expect(empty.securityErrors).toEqual([]);
});

it("reserves security attention for findings while retaining coverage errors", async () => {
  const f = fixture();
  await f.workspace.list();
  f.workspace.refresh();
  await f.workspace.close();
  const p = (await f.workspace.list()).projects[0];
  p.insights = {
    checkedAt: new Date().toISOString(),
    reviews: [],
    findings: [],
    reviewError: null,
    securityErrors: ["Dependabot unavailable"],
  };
  expect(projectAttention(p).security).toBeNull();
  expect(projectNeedsAttention(p)).toBe(false);
  p.insights.findings.push({
    number: 1,
    title: "Update dependency",
    url: "https://github.com/acme/app/security/dependabot/1",
    source: "Dependabot",
    severity: "high",
  });
  expect(projectAttention(p).security).toBe("Review Dependabot alerts");
  expect(projectNeedsAttention(p)).toBe(true);
  expect(p.insights.securityErrors).toEqual(["Dependabot unavailable"]);
});

it("removes remote credentials and supports SSH repository URLs", () => {
  expect(repositoryWebUrl("https://user:secret@github.com/acme/app.git")).toBe(
    "https://github.com/acme/app",
  );
  expect(repositoryWebUrl("git@github.com:acme/app.git")).toBe("https://github.com/acme/app");
  expect(repositoryWebUrl("/local/repo.git")).toBeNull();
});

it("preserves manually assigned or unlinked profile pages across discovery refreshes", async () => {
  const f = fixture();
  const project = (await f.workspace.list()).projects[0];
  let time = Date.now();
  const documents = ["automatic.md", "manual.md"].map((path) => ({
    path,
    title: path,
    type: "Project",
    description: "",
    hash: path,
    content: `---\ntype: Project\n${path === "automatic.md" ? `repository_id: ${project.id}\n` : ""}---\nDescription`,
  }));
  const workspace = createProjectWorkspace({
    records: f.store,
    scope: () => ({ profile: f.profile, roots: [f.directory] }),
    documents: () => documents,
    io: f.io,
    now: () => new Date(time).toISOString(),
  });
  expect((await workspace.list()).projects[0].document).toBe("automatic.md");
  workspace.update(project.id, { document: "manual.md" });
  time += 16000;
  expect((await workspace.list()).projects[0].document).toBe("manual.md");
  workspace.update(project.id, { document: null });
  time += 16000;
  expect((await workspace.list()).projects[0].document).toBeNull();
});

it("publishes a new branch explicitly and then enables returning to main", async () => {
  const f = fixture();
  git(f.repo, "switch", "-c", "new-feature");
  const p = (await f.workspace.list()).projects[0];
  expect(projectAttention(p).local).toBe("Publish this branch");
  const published = await f.workspace.action(p.id, { action: "push", version: version(p) });
  expect(published.project.git?.upstream).toBe("origin/new-feature");
  expect(
    (await f.workspace.action(p.id, { action: "switch", version: version(published.project) }))
      .project.git?.branch,
  ).toBe("main");
});

it("commits a selected rename atomically and treats pathspec-like filenames literally", async () => {
  const f = fixture();
  git(f.repo, "mv", "README.md", "renamed.md");
  writeFileSync(join(f.repo, ":(glob)*.txt"), "literal filename");
  const p = (await f.workspace.list()).projects[0];
  await f.workspace.action(p.id, {
    action: "commit",
    version: version(p),
    message: "refactor: rename",
    files: ["renamed.md", ":(glob)*.txt"],
  });
  expect(git(f.repo, "ls-tree", "--name-only", "HEAD")).toBe(":(glob)*.txt\nrenamed.md");
  expect(git(f.repo, "status", "--porcelain")).toBe("");
});
