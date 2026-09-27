import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createProjectWorkspace } from "../server/application/project-workspace.js";
import { createProjectWorkspaceIO, repositoryWebUrl } from "../server/project-repositories.js";
import { Store } from "../server/store.js";
import { type Project, projectAttention, projectNeedsAttention } from "../shared/projects.js";

const roots: string[] = [];
const stores: Store[] = [];
function version(project: Project) {
  assert(project.git);
  return project.git.version;
}
async function listReady(workspace: ReturnType<typeof createProjectWorkspace>) {
  await workspace.list();
  await workspace.close();
  return workspace.list();
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
  const io = createProjectWorkspaceIO(async () => ({
    checkedAt: new Date().toISOString(),
    reviews: [],
    findings: [],
    reviewError: null,
    securityErrors: [],
  }));
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

it("returns saved projects without loading indicators during automatic discovery", async () => {
  const f = fixture();
  const saved = (await listReady(f.workspace)).projects[0];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const discover = f.io.discover;
  vi.spyOn(f.io, "discover").mockImplementation(async (...args) => {
    await gate;
    return discover(...args);
  });
  f.tick();
  try {
    const state = await f.workspace.list();
    expect(state.projects).toEqual([saved]);
    expect(state.refreshing).toBe(false);
    expect(state.refreshingIds).toEqual([]);
  } finally {
    release();
    await f.workspace.close();
  }
  expect((await f.workspace.list()).refreshingIds).toEqual([]);
});

it.each(["inspect", "insights"])(
  "allows commits during background %s and rejects stale refresh writes",
  async (phase) => {
    const f = fixture();
    writeFileSync(join(f.repo, "README.md"), "commit me");
    const p = (await listReady(f.workspace)).projects[0];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspect = f.io.inspect;
    let started = false;
    vi.spyOn(f.io, "inspect").mockImplementation(async (path) => {
      const git = await inspect(path);
      if (phase === "inspect" && !started) {
        started = true;
        await gate;
      }
      return { ...git, repositoryUrl: "https://github.com/acme/app" };
    });
    vi.spyOn(f.io, "refreshRemote").mockResolvedValue();
    vi.spyOn(f.io, "insights").mockImplementation(async (_url, options) => {
      if (phase === "insights") {
        started = true;
        await gate;
      }
      const insights = {
        checkedAt: "2026-01-01",
        reviews: [],
        findings: [],
        reviewError: null,
        securityErrors: [],
      };
      options?.onUpdate?.(insights);
      return insights;
    });
    f.tick();
    await f.workspace.list();
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      expect((await f.workspace.list()).refreshingIds).toEqual([]);
      const result = await f.workspace.action(p.id, {
        action: "commit",
        version: version(p),
        files: ["README.md"],
        message: "fix: user action",
      });
      expect(result.project.git?.dirty).toBe(false);
      const head = result.project.git?.head;
      release();
      await f.workspace.close();
      expect(f.store.projects(f.profile)[0].git).toMatchObject({ head, dirty: false });
    } finally {
      release();
      await f.workspace.close();
    }
  },
);

it("queues a pull behind an in-flight fetch instead of rejecting it as another action", async () => {
  const f = fixture();
  const p = (await listReady(f.workspace)).projects[0];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetching = vi.spyOn(f.io, "refreshRemote").mockImplementation(() => gate);
  const execute = vi.spyOn(f.io, "execute");
  f.workspace.refresh();
  await vi.waitFor(() => expect(fetching).toHaveBeenCalled());
  const action = f.workspace.action(p.id, { action: "pull", version: version(p) });
  await expect(f.workspace.action(p.id, { action: "pull", version: version(p) })).rejects.toThrow(
    "An action is already running",
  );
  expect(execute).not.toHaveBeenCalled();
  release();
  expect((await action).project.git?.behind).toBe(0);
  await f.workspace.close();
});

it("refreshes other repositories again while one remote is still blocked", async () => {
  const f = fixture();
  const base = (await listReady(f.workspace)).projects[0];
  const entries = Array.from({ length: 8 }, (_, i) => ({
    ...base,
    id: `repo-${i}`,
    name: `repo-${i}`,
    path: `${f.directory}/repo-${i}`,
    remoteAttemptedAt: undefined,
    remoteCheckedAt: null,
  }));
  for (const entry of entries) f.store.saveProject(entry);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let time = Date.now();
  const inspect = vi.fn(async () => {
    assert(base.git);
    return { ...base.git, repositoryUrl: "https://github.com/acme/app" };
  });
  const remote = vi.fn(async (path: string) => {
    if (path.endsWith("repo-0")) await gate;
  });
  const workspace = createProjectWorkspace({
    records: f.store,
    scope: () => ({ profile: f.profile, roots: [f.directory] }),
    documents: () => [],
    now: () => new Date(time).toISOString(),
    io: {
      ...f.io,
      discover: async () => ({
        repositories: entries.map(({ id, name, path, root }) => ({ id, name, path, root })),
        errors: [],
      }),
      validate: async () => {},
      inspect,
      refreshRemote: remote,
    },
  });
  try {
    await workspace.list();
    await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(8));
    await vi.waitFor(() =>
      expect(
        f.store.projects(f.profile).find((p) => p.id === "repo-7")?.remoteCheckedAt,
      ).toBeTruthy(),
    );
    expect((await workspace.list()).refreshingIds).toEqual([]);
    const before = inspect.mock.calls.length;
    time += 16000;
    await workspace.list();
    await vi.waitFor(() => expect(inspect.mock.calls.length).toBe(before + 7));
    expect(remote).toHaveBeenCalledTimes(8);
  } finally {
    release();
    await workspace.close();
  }
});

it("reuses persisted remote freshness after restarting the workspace", async () => {
  const f = fixture();
  const p = (await listReady(f.workspace)).projects[0];
  const remote = vi.spyOn(f.io, "refreshRemote");
  const workspace = createProjectWorkspace({
    records: f.store,
    scope: () => ({ profile: f.profile, roots: [f.directory] }),
    documents: () => [],
    io: f.io,
    now: () => p.remoteCheckedAt ?? "",
  });
  await listReady(workspace);
  expect(remote).not.toHaveBeenCalled();
  workspace.refresh();
  await workspace.close();
  expect(remote).toHaveBeenCalledTimes(1);
});

it("discovers independent projects, skips symlinks and nested repositories, and persists preferences", async () => {
  const f = fixture();
  symlinkSync(f.repo, join(f.directory, "alias"));
  mkdirSync(join(f.directory, "container"));
  git(f.root, "init", join(f.directory, "container", "nested"));
  const state = await listReady(f.workspace);
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
  expect((await listReady(f.workspace)).projects).toEqual([]);
  await expect(f.workspace.detail(project.id)).rejects.toThrow("not found");
});

it("persists T3 overrides across refreshes and restarts and can restore inheritance", async () => {
  const f = fixture(true);
  const p = (await listReady(f.workspace)).projects[0];
  const t3 = {
    model: { instanceId: "custom", model: "project-model" },
    workspaceMode: "checkout" as const,
    runtimeMode: "full-access" as const,
  };
  f.workspace.update(p.id, { t3 });
  f.workspace.refresh();
  await f.workspace.close();
  expect((await f.workspace.detail(p.id)).project.t3).toEqual(t3);
  const reopened = new Store(join(f.root, "projects.sqlite"));
  stores.push(reopened);
  expect(reopened.projects(f.profile)[0].t3).toEqual(t3);
  f.workspace.update(p.id, { t3: {} });
  expect(reopened.projects(f.profile)[0].t3).toEqual({});
});

it.each([false, true])(
  "preserves T3 settings saved during a remote check, inherit=%s",
  async (inherit) => {
    const f = fixture();
    const p = (await listReady(f.workspace)).projects[0];
    f.workspace.update(p.id, { t3: { runtimeMode: "approval-required" } });
    const t3 = inherit
      ? {}
      : {
          model: { instanceId: "custom", model: "project-model" },
          workspaceMode: "checkout" as const,
          runtimeMode: "full-access" as const,
        };
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checking = vi.spyOn(f.io, "refreshRemote").mockImplementation(() => gate);
    f.workspace.refresh();
    await vi.waitFor(() => expect(checking).toHaveBeenCalled());
    try {
      expect(f.workspace.update(p.id, { t3 }).t3).toEqual(t3);
      expect((await f.workspace.list()).projects[0].t3).toEqual(t3);
    } finally {
      release();
      await f.workspace.close();
    }
    expect(f.store.projects(f.profile)[0].t3).toEqual(t3);
  },
);

it("persists hidden projects across refreshes and database restarts and allows restoring them", async () => {
  const f = fixture(true);
  const p = (await listReady(f.workspace)).projects[0];
  expect(p.hidden).toBe(false);
  f.workspace.update(p.id, { hidden: true });
  f.workspace.refresh();
  await f.workspace.close();
  expect((await listReady(f.workspace)).projects[0].hidden).toBe(true);
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
  const p = (await listReady(f.workspace)).projects[0];
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
    expect(f.workspace.update(p.id, { returnToDefault: false }).returnToDefault).toBe(false);
  } finally {
    release();
    await f.workspace.close();
  }
  expect(f.store.projects(f.profile)[0]).toMatchObject({ hidden, returnToDefault: false });
});

it("preserves hiding while discovery finds an unavailable checkout", async () => {
  const f = fixture();
  const p = (await listReady(f.workspace)).projects[0];
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
    const p = (await listReady(f.workspace)).projects[0];
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
  await listReady(f.workspace);
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
  await listReady(f.workspace);
  f.workspace.refresh();
  await f.workspace.close();
  const p = (await listReady(f.workspace)).projects[0];
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
  const p = (await listReady(f.workspace)).projects[0];
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
  const p = (await listReady(f.workspace)).projects[0];
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
  const p = (await listReady(f.workspace)).projects[0];
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
  const p = (await listReady(f.workspace)).projects[0];
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
  const p = (await listReady(f.workspace)).projects[0];
  const result = await f.io.discover([join(f.root, "absent")], f.profile);
  expect(result.errors).toHaveLength(1);
  const alias = join(f.directory, "alias");
  symlinkSync(f.repo, alias);
  await expect(f.io.validate({ ...p, name: "alias", path: alias })).rejects.toThrow(
    "configured checkout",
  );
});

it("reserves security attention for findings while retaining coverage errors", async () => {
  const f = fixture();
  await listReady(f.workspace);
  f.workspace.refresh();
  await f.workspace.close();
  const p = (await listReady(f.workspace)).projects[0];
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
  const project = (await listReady(f.workspace)).projects[0];
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
  expect((await listReady(workspace)).projects[0].document).toBe("automatic.md");
  workspace.update(project.id, { document: "manual.md" });
  time += 16000;
  expect((await listReady(workspace)).projects[0].document).toBe("manual.md");
  workspace.update(project.id, { document: null });
  time += 16000;
  expect((await listReady(workspace)).projects[0].document).toBeNull();
});

it("publishes a new branch explicitly and then enables returning to main", async () => {
  const f = fixture();
  git(f.repo, "switch", "-c", "new-feature");
  const p = (await listReady(f.workspace)).projects[0];
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
  const p = (await listReady(f.workspace)).projects[0];
  await f.workspace.action(p.id, {
    action: "commit",
    version: version(p),
    message: "refactor: rename",
    files: ["renamed.md", ":(glob)*.txt"],
  });
  expect(git(f.repo, "ls-tree", "--name-only", "HEAD")).toBe(":(glob)*.txt\nrenamed.md");
  expect(git(f.repo, "status", "--porcelain")).toBe("");
});

it("discards selected tracked and new files while preserving unrelated staged changes", async () => {
  const f = fixture();
  writeFileSync(join(f.repo, "README.md"), "staged edit");
  git(f.repo, "add", "README.md");
  writeFileSync(join(f.repo, "README.md"), "unstaged edit");
  writeFileSync(join(f.repo, "added.txt"), "added");
  writeFileSync(join(f.repo, "keep.txt"), "keep");
  git(f.repo, "add", "added.txt", "keep.txt");
  writeFileSync(join(f.repo, ":(glob)*.txt"), "untracked");
  const p = (await listReady(f.workspace)).projects[0];
  const result = await f.workspace.action(p.id, {
    action: "discard",
    version: version(p),
    files: ["README.md", "added.txt", ":(glob)*.txt"],
  });
  expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe("initial\n");
  expect(existsSync(join(f.repo, "added.txt"))).toBe(false);
  expect(existsSync(join(f.repo, ":(glob)*.txt"))).toBe(false);
  expect(git(f.repo, "diff", "--cached", "--name-only")).toBe("keep.txt");
  expect(result.changes.files.map((file) => file.path)).toEqual(["keep.txt"]);
});

it("discards all reviewed changes including renames and deletions", async () => {
  const f = fixture();
  writeFileSync(join(f.repo, "deleted.txt"), "restore me");
  git(f.repo, "add", "deleted.txt");
  git(f.repo, "commit", "-m", "test: deletion fixture");
  git(f.repo, "rm", "deleted.txt");
  git(f.repo, "mv", "README.md", "renamed.md");
  writeFileSync(join(f.repo, "new.txt"), "new");
  const p = (await listReady(f.workspace)).projects[0];
  const before = await f.workspace.detail(p.id);
  const result = await f.workspace.action(p.id, {
    action: "discard",
    version: version(before.project),
    files: before.changes.files.map((file) => file.path),
  });
  expect(result.changes.files).toEqual([]);
  expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe("initial\n");
  expect(readFileSync(join(f.repo, "deleted.txt"), "utf8")).toBe("restore me");
  expect(existsSync(join(f.repo, "renamed.md"))).toBe(false);
});

it("rejects stale and invalid discard requests without deleting files", async () => {
  const f = fixture();
  writeFileSync(join(f.repo, "README.md"), "first");
  const p = (await listReady(f.workspace)).projects[0];
  writeFileSync(join(f.repo, "README.md"), "later edit");
  await expect(
    f.workspace.action(p.id, { action: "discard", version: version(p), files: ["README.md"] }),
  ).rejects.toThrow("checkout changed");
  const current = await f.workspace.detail(p.id);
  for (const files of [undefined, [], ["../outside"], ["unchanged.txt"]]) {
    await expect(
      f.workspace.action(p.id, { action: "discard", version: version(current.project), files }),
    ).rejects.toThrow("Choose");
  }
  expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe("later edit");
});

it("discards staged and untracked files before the first commit", async () => {
  const f = fixture();
  const repo = join(f.directory, "unborn");
  git(f.root, "init", "--initial-branch=main", repo);
  writeFileSync(join(repo, "staged.txt"), "staged");
  git(repo, "add", "staged.txt");
  writeFileSync(join(repo, "staged.txt"), "edited after staging");
  writeFileSync(join(repo, "untracked.txt"), "untracked");
  const p = (await listReady(f.workspace)).projects.find((p) => p.name === "unborn");
  assert(p);
  const result = await f.workspace.action(p.id, {
    action: "discard",
    version: version(p),
    files: ["staged.txt", "untracked.txt"],
  });
  expect(result.changes.files).toEqual([]);
  expect(existsSync(join(repo, "staged.txt"))).toBe(false);
  expect(existsSync(join(repo, "untracked.txt"))).toBe(false);
});

it("discards a symlink itself without deleting its target", async () => {
  const f = fixture();
  const outside = join(f.root, "outside.txt");
  writeFileSync(outside, "keep me");
  symlinkSync(outside, join(f.repo, "link.txt"));
  const p = (await listReady(f.workspace)).projects[0];
  await f.workspace.action(p.id, { action: "discard", version: version(p), files: ["link.txt"] });
  expect(existsSync(join(f.repo, "link.txt"))).toBe(false);
  expect(readFileSync(outside, "utf8")).toBe("keep me");
});
