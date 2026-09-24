import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ImplementationRepository } from "../server/application/implementation-repository.js";
import { createT3, type T3Client } from "../server/application/t3.js";
import { createApp } from "../server/bootstrap.js";
import { config } from "../server/config.js";
import { SettingsStore } from "../server/settings.js";
import { Store } from "../server/store.js";
import { createT3Client, implementationWorkspace, readLocalMerge } from "../server/t3.js";
import type { ProfileDocument } from "../shared/schema.js";
import {
  type Implementation,
  type LocalMerge,
  type T3Connection,
  t3ConnectionSchema,
} from "../shared/t3.js";
import { mockT3 } from "./mock-t3.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const connection: T3Connection = {
  endpoint: "http://127.0.0.1:3773",
  accessToken: "private-token",
  environmentId: "local",
  serverVersion: "0.0.29",
  defaultModel: { instanceId: "codex", model: "test-model" },
};

function fixture() {
  const store = new Store(":memory:");
  cleanup.push(() => store.db.close());
  const capture = store.capture("Implement portal search");
  const item = store.update(
    capture.id,
    {
      kind: "commitment",
      processing: "ready",
      prompt: "Search titles and show matching results.",
      references: [
        {
          start: 10,
          end: 16,
          mention: "portal",
          kind: "project",
          target: "portal.md",
          label: "Portal",
          source: "aliases.md",
        },
      ],
    },
    0,
  );
  let saved: T3Connection | undefined = connection;
  let sequence = 0;
  const documents: ProfileDocument[] = [
    {
      path: "portal.md",
      title: "Portal",
      type: "Project",
      description: "",
      content: "Use the existing search index.",
      hash: "1",
    },
    {
      path: "private.md",
      title: "Private",
      type: "Person",
      description: "",
      content: "Unrelated personal context",
      hash: "2",
    },
  ];
  const repositories: ImplementationRepository[] = [
    { id: "repo", name: "portal", path: "/repos/portal", document: "portal.md" },
  ];
  const client: T3Client = {
    connect: vi.fn(async () => connection),
    projects: vi.fn(async () => []),
    launch: vi.fn(async () => {}),
    progress: vi.fn<T3Client["progress"]>(async () => "running"),
  };
  const settings = {
    t3Connection: () => saved,
    saveT3: (value: T3Connection | undefined) => {
      saved = value;
    },
  };
  const ports = {
    records: store,
    settings,
    client,
    getProfile: () => ({
      root: "/profile",
      isGit: () => true,
      documents: () => documents,
      incorporate: () => {},
    }),
    repositories: () => repositories,
    workspace: vi.fn(async (path: string) => ({ path, branch: "commit-sha" })),
    id: () => `id-${++sequence}`,
    now: () => "2026-09-21T12:00:00.000Z",
    localMerge: vi.fn(
      async (entry: Implementation): Promise<LocalMerge> => ({
        branch: `panopticon/${entry.id}`,
        mainBranch: "main",
        head: "implementation-commit",
        mainHead: "main-commit",
        merged: false,
        dirty: false,
      }),
    ),
  };
  return { service: createT3(ports), ports, store, item, client, documents, repositories };
}

it("routes exact references, sends saved context, and marks the commitment in progress", async () => {
  const { service, store, item, client } = fixture();
  expect(service.options(item.id).suggestedRepositoryId).toBe("repo");
  const launched = await service.implement(item.id, { revision: item.revision });
  const entry = store.latestImplementation(item.id, "/profile");
  assert(entry);
  expect(entry.prompt).toBe(item.prompt);
  expect(vi.mocked(client.launch).mock.calls[0][1].prompt).toBe(item.prompt);
  expect(launched?.url).toBe("http://127.0.0.1:3773/local/id-1");
  expect(entry.state).toBe("submitted");
  expect(store.get(item.id)?.status).toBe("in_progress");
  expect(client.launch).toHaveBeenCalledTimes(1);
});

it("moves finished turns to review, respects manual resume, and never treats a turn as task completion", async () => {
  const { service, store, item, client } = fixture();
  await service.implement(item.id, { revision: item.revision });
  vi.mocked(client.progress).mockResolvedValue("completed");
  await service.refresh(item.id);
  const reviewed = store.get(item.id);
  assert(reviewed);
  expect(reviewed.status).toBe("in_review");
  store.update(item.id, { status: "in_progress" }, reviewed.revision);
  vi.mocked(client.progress).mockRejectedValueOnce(new Error("offline"));
  await service.refresh(item.id);
  await service.refresh(item.id);
  expect(store.get(item.id)?.status).toBe("in_progress");
  vi.mocked(client.progress).mockResolvedValue("error");
  await service.refresh(item.id);
  expect(store.get(item.id)?.status).toBe("in_progress");
});

it("requires confirmation after a local merge and does not undo reopening", async () => {
  const { service, store, item, ports, client } = fixture();
  await service.implement(item.id, { revision: item.revision });
  await service.refreshActive();
  expect(store.get(item.id)?.status).toBe("in_progress");
  ports.localMerge.mockResolvedValue({
    branch: "panopticon/id-1",
    mainBranch: "main",
    head: "implementation-commit",
    mainHead: "merge-commit",
    merged: true,
    dirty: false,
  });
  vi.mocked(client.progress).mockRejectedValue(new Error("offline private-token"));
  await service.refreshActive();
  expect(store.get(item.id)?.status).toBe("in_progress");
  const [candidate] = service.completionReviews();
  expect(candidate.reason).toContain("merged into main");
  const completed = service.reviewCompletion(item.id, { ...candidate, decision: "confirm" });
  expect(completed.status).toBe("done");
  expect(service.completionReviews()).toEqual([]);
  expect(service.options(item.id).latest?.progress?.error).not.toContain("private-token");
  store.update(item.id, { status: "in_progress" }, completed.revision);
  ports.localMerge.mockRejectedValueOnce(new Error("private repository diagnostic"));
  await service.refresh(item.id);
  expect(service.options(item.id).latest?.progress?.error).not.toContain(
    "private repository diagnostic",
  );
  await service.refresh(item.id);
  expect(store.get(item.id)?.status).toBe("in_progress");
  expect(store.latestImplementation(item.id, "/profile")?.mergedCommit).toBe(
    "implementation-commit",
  );
  expect(service.completionReviews()).toEqual([]);
});

it("persists pending reviews and suppresses rejected evidence across service restarts", async () => {
  const { service, store, item, ports } = fixture();
  await service.implement(item.id, { revision: item.revision });
  const merge: LocalMerge = {
    branch: "panopticon/id-1",
    mainBranch: "main",
    head: "first",
    mainHead: "main",
    merged: true,
    dirty: false,
  };
  ports.localMerge.mockResolvedValue(merge);
  await service.refreshActive();
  const restarted = createT3(ports);
  expect(restarted.completionReviews()).toEqual(service.completionReviews());
  const [candidate] = restarted.completionReviews();
  restarted.reviewCompletion(item.id, { ...candidate, decision: "keep_open" });
  expect(store.get(item.id)?.status).toBe("in_progress");
  const again = createT3(ports);
  await again.refreshActive();
  expect(again.completionReviews()).toEqual([]);
  ports.localMerge.mockResolvedValue({ ...merge, head: "new-commit" });
  await again.refreshActive();
  expect(again.completionReviews()).toMatchObject([{ head: "new-commit" }]);
});

it("rejects stale decisions and isolates changed prompts, closed tasks, profiles and implementations", async () => {
  const { service, store, item, ports } = fixture();
  const implementation = await service.implement(item.id, { revision: item.revision });
  ports.localMerge.mockResolvedValue({
    branch: "panopticon/id-1",
    mainBranch: "main",
    head: "first",
    mainHead: "main",
    merged: true,
    dirty: false,
  });
  await service.refreshActive();
  const [candidate] = service.completionReviews();
  for (const fields of [{ head: "stale" }, { implementationId: "old" }, { revision: 0 }])
    expect(() =>
      service.reviewCompletion(item.id, { ...candidate, ...fields, decision: "confirm" }),
    ).toThrow(/changed/);
  expect(store.get(item.id)?.status).toBe("in_progress");
  const otherProfile = createT3({
    ...ports,
    getProfile: () => ({ ...ports.getProfile(), root: "/other" }),
  });
  expect(otherProfile.completionReviews()).toEqual([]);
  for (const fields of [
    { prompt: "Changed scope" },
    { status: "done" as const },
    { status: "archived" as const },
  ]) {
    const current = store.get(item.id);
    assert(current);
    const updated = store.update(item.id, fields, current.revision);
    expect(service.completionReviews()).toEqual([]);
    expect(() =>
      service.reviewCompletion(item.id, {
        ...candidate,
        revision: updated.revision,
        decision: "confirm",
      }),
    ).toThrow(/changed/);
    store.update(item.id, { prompt: item.prompt, status: "in_progress" }, updated.revision);
  }
  const current = store.get(item.id);
  assert(current && implementation);
  await service.implement(item.id, {
    revision: current.revision,
    previousAttemptId: implementation.id,
  });
  expect(service.completionReviews()).toEqual([]);
});

it("does not resurrect a rejection when an earlier progress check finishes", async () => {
  const { service, item, ports, client } = fixture();
  await service.implement(item.id, { revision: item.revision });
  ports.localMerge.mockResolvedValue({
    branch: "panopticon/id-1",
    mainBranch: "main",
    head: "first",
    mainHead: "main",
    merged: true,
    dirty: false,
  });
  await service.refreshActive();
  const [candidate] = service.completionReviews();
  let finish: (state: "running") => void = () => {};
  vi.mocked(client.progress).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = service.refresh(item.id);
  service.reviewCompletion(item.id, { ...candidate, decision: "keep_open" });
  finish("running");
  await pending;
  expect(service.completionReviews()).toEqual([]);
});

it("preserves paused tasks, changed scope, and edits made during progress checks", async () => {
  const { service, store, item, client, ports } = fixture();
  const entry = await service.implement(item.id, { revision: item.revision });
  let current = store.get(item.id);
  assert(current && entry);
  store.update(item.id, { status: "waiting" }, current.revision);
  vi.mocked(client.progress).mockResolvedValue("completed");
  await service.refresh(item.id);
  expect(store.get(item.id)?.status).toBe("waiting");
  current = store.get(item.id);
  assert(current);
  store.update(
    item.id,
    { prompt: "A different requirement", status: "in_progress" },
    current.revision,
  );
  ports.localMerge.mockResolvedValue({
    branch: "panopticon/id-1",
    mainBranch: "main",
    head: "implementation-commit",
    mainHead: "merge-commit",
    merged: true,
    dirty: false,
  });
  await service.refresh(item.id);
  expect(store.get(item.id)?.status).toBe("in_progress");
  vi.mocked(client.progress).mockImplementationOnce(async () => {
    const latest = store.get(item.id);
    assert(latest);
    store.update(item.id, { status: "archived" }, latest.revision);
    return "completed";
  });
  await service.refresh(item.id);
  expect(store.get(item.id)?.status).toBe("archived");
});

it("isolates replaced T3 instances while still checking the local merge", async () => {
  const { service, item, client, ports } = fixture();
  await service.implement(item.id, { revision: item.revision });
  ports.settings.saveT3({ ...connection, environmentId: "different" });
  await service.refresh(item.id);
  expect(client.progress).not.toHaveBeenCalled();
  expect(ports.localMerge).toHaveBeenCalledTimes(1);
  expect(service.options(item.id).latest?.progress?.error).toContain("original T3");
});

it("keeps connection actions responsive during slow polling and deduplicates checks", async () => {
  const { service, item, client } = fixture();
  await service.implement(item.id, { revision: item.revision });
  let finish: (state: "running") => void = () => {};
  vi.mocked(client.progress).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = service.refreshActive();
  const second = service.refresh(item.id);
  await service.test();
  expect(client.progress).toHaveBeenCalledTimes(1);
  finish("running");
  await Promise.all([first, second]);
});

function localMergeFixture() {
  const root = mkdtempSync(join(tmpdir(), "pa-local-merge-"));
  const repository = join(root, "repository");
  const worktree = join(root, "implementation");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main", repository);
  git("-C", repository, "commit", "--allow-empty", "-m", "test: initialize");
  const baseBranch = git("-C", repository, "rev-parse", "HEAD");
  git("-C", repository, "worktree", "add", "-b", "panopticon/test", worktree);
  return {
    entry: { id: "test", workspaceRoot: repository, baseBranch },
    repository,
    worktree,
    git,
    commitWork() {
      writeFileSync(join(worktree, "feature.txt"), "implementation\n");
      git("-C", worktree, "add", "feature.txt");
      git("-C", worktree, "commit", "-m", "feat: implementation");
    },
  };
}

it.each(["--ff-only", "--no-ff"])(
  "detects a local %s merge, including one completed before polling",
  async (mode) => {
    const { entry, repository, git, commitWork } = localMergeFixture();
    commitWork();
    git("-C", repository, "merge", mode, "panopticon/test", "-m", "Merge implementation");
    const result = await readLocalMerge(entry);
    expect(result).toMatchObject({
      branch: "panopticon/test",
      mainBranch: "main",
      merged: true,
      dirty: false,
    });
  },
);

it.each(["--ff-only", "--no-ff"])(
  "detects a local %s merge after branch and worktree cleanup",
  async (mode) => {
    const { entry, repository, worktree, git, commitWork } = localMergeFixture();
    commitWork();
    git("-C", repository, "merge", mode, "panopticon/test", "-m", "Merge implementation");
    git("-C", repository, "worktree", "remove", worktree);
    git("-C", repository, "branch", "-d", "panopticon/test");
    expect((await readLocalMerge(entry)).merged).toBe(true);
  },
);

it("proposes completion from real local Git evidence without T3 connectivity", async () => {
  const { entry, repository, git, commitWork } = localMergeFixture();
  const { ports, item, store, repositories, client } = fixture();
  repositories[0].path = repository;
  ports.workspace.mockResolvedValue({ path: repository, branch: entry.baseBranch });
  const service = createT3({ ...ports, id: () => entry.id, localMerge: readLocalMerge });
  await service.implement(item.id, { revision: item.revision });
  commitWork();
  await service.refresh(item.id);
  expect(store.get(item.id)?.status).toBe("in_progress");
  git("-C", repository, "merge", "--ff-only", "panopticon/test");
  vi.mocked(client.progress).mockRejectedValue(new Error("offline"));
  await service.refreshActive();
  expect(store.get(item.id)?.status).toBe("in_progress");
  expect(service.completionReviews()).toMatchObject([{ itemId: item.id }]);
  expect(service.options(item.id).latest?.progress?.localMerge?.merged).toBe(true);
});

it("does not complete untouched branches, unmerged work, or a branch merely updated from main", async () => {
  const { entry, repository, worktree, git } = localMergeFixture();
  expect((await readLocalMerge(entry)).merged).toBe(false);
  git("-C", repository, "commit", "--allow-empty", "-m", "chore: unrelated main work");
  git("-C", worktree, "merge", "--ff-only", "main");
  expect((await readLocalMerge(entry)).merged).toBe(false);
  writeFileSync(join(worktree, "feature.txt"), "implementation\n");
  git("-C", worktree, "add", "feature.txt");
  git("-C", worktree, "commit", "-m", "feat: implementation");
  expect((await readLocalMerge(entry)).merged).toBe(false);
});

it("requires clean implementation worktrees even after the committed work was merged", async () => {
  const { entry, repository, worktree, git, commitWork } = localMergeFixture();
  commitWork();
  git("-C", repository, "merge", "--ff-only", "panopticon/test");
  writeFileSync(join(worktree, "unfinished.txt"), "unfinished\n");
  expect(await readLocalMerge(entry)).toMatchObject({ merged: false, dirty: true });
});

it("uses origin's default branch metadata instead of the currently checked out branch", async () => {
  const { entry, repository, git, commitWork } = localMergeFixture();
  git("-C", repository, "branch", "-m", "main", "trunk");
  git("-C", repository, "update-ref", "refs/remotes/origin/trunk", entry.baseBranch);
  git("-C", repository, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  commitWork();
  git("-C", repository, "merge", "--ff-only", "panopticon/test");
  git("-C", repository, "switch", "-c", "unrelated");
  expect(await readLocalMerge(entry)).toMatchObject({ mainBranch: "trunk", merged: true });
});

it("keeps squash merges and merges into another branch for manual confirmation", async () => {
  const { entry, repository, git, commitWork } = localMergeFixture();
  commitWork();
  git("-C", repository, "switch", "-c", "integration");
  git("-C", repository, "merge", "--ff-only", "panopticon/test");
  expect((await readLocalMerge(entry)).merged).toBe(false);
  git("-C", repository, "switch", "main");
  git("-C", repository, "merge", "--squash", "panopticon/test");
  git("-C", repository, "commit", "-m", "feat: squashed implementation");
  expect((await readLocalMerge(entry)).merged).toBe(false);
});

it("reports missing implementation branches and ambiguous local main branches", async () => {
  const { entry, repository, git } = localMergeFixture();
  await expect(readLocalMerge({ ...entry, id: "missing" })).rejects.toThrow("missing or renamed");
  git("-C", repository, "branch", "master");
  await expect(readLocalMerge(entry)).rejects.toThrow("identify the local main branch");
});

it("validates T3 progress against the saved environment and project", async () => {
  const { service, store, item } = fixture();
  await service.implement(item.id, { revision: item.revision });
  const entry = store.latestImplementation(item.id, "/profile");
  assert(entry);
  const request = vi.fn(async (url: string | URL | Request) =>
    String(url).includes(".well-known")
      ? Response.json({ environmentId: connection.environmentId, serverVersion: "test" })
      : Response.json({
          thread: {
            projectId: entry.projectId,
            deletedAt: null,
            latestTurn: { state: "completed" },
          },
        }),
  );
  const client = createT3Client(request);
  expect(await client.progress(connection, entry)).toBe("completed");
  request.mockResolvedValueOnce(Response.json({ environmentId: "other", serverVersion: "test" }));
  await expect(client.progress(connection, entry)).rejects.toThrow("original T3");
  request.mockResolvedValueOnce(
    Response.json({ environmentId: connection.environmentId, serverVersion: "test" }),
  );
  request.mockResolvedValueOnce(
    Response.json({
      thread: { projectId: "other", deletedAt: null, latestTurn: { state: "completed" } },
    }),
  );
  await expect(client.progress(connection, entry)).rejects.toThrow("thread is unavailable");
});

it("requires selection for ambiguous references and never matches a project by name", async () => {
  const { service, store, item, repositories } = fixture();
  repositories.push({
    id: "second",
    name: "portal",
    path: "/another/portal",
    document: "portal.md",
  });
  expect(service.options(item.id).suggestedRepositoryId).toBeNull();
  await expect(service.implement(item.id, { revision: item.revision })).rejects.toThrow(
    "Choose a discovered repository",
  );
  await service.implement(item.id, { revision: item.revision, repositoryId: "second" });
  expect(store.latestImplementation(item.id, "/profile")?.workspaceRoot).toBe("/another/portal");
});

it.each(["portal", "Portal", "portal.md", "/repos/portal"])(
  "routes an existing commitment's exact project %s without alias references",
  async (project) => {
    const { service, store, item, ports } = fixture();
    const saved = store.update(item.id, { project, references: [] }, item.revision);
    expect(service.options(item.id).suggestedRepositoryId).toBe("repo");
    await service.implement(item.id, { revision: saved.revision });
    expect(ports.workspace).toHaveBeenCalledWith("/repos/portal");
  },
);

it("does not guess between duplicate project names or use a previous handoff after a project change", async () => {
  const { service, store, item, repositories } = fixture();
  await service.implement(item.id, { revision: item.revision });
  repositories.push({ id: "second", name: "portal", path: "/another/portal", document: null });
  const current = store.get(item.id);
  assert(current);
  const changed = store.update(item.id, { project: "portal", references: [] }, current.revision);
  expect(service.options(item.id).suggestedRepositoryId).toBeNull();
  store.update(item.id, { project: "unknown" }, changed.revision);
  expect(service.options(item.id).suggestedRepositoryId).toBeNull();
});

it("uses a persisted repository identity and does not reroute it when unavailable", async () => {
  const { service, store, item, repositories } = fixture();
  const saved = store.update(
    item.id,
    { repositoryId: "repo", project: "Old name", references: [] },
    item.revision,
  );
  expect(service.options(item.id).suggestedRepositoryId).toBe("repo");
  await service.implement(item.id, { revision: saved.revision });
  repositories.splice(0);
  expect(service.options(item.id).suggestedRepositoryId).toBeNull();
});

it("reuses a project and its full model selection, including options", async () => {
  const { service, client, item, store } = fixture();
  const model = {
    instanceId: "custom-provider",
    model: "project-model",
    options: { effort: "high" },
  };
  vi.mocked(client.projects).mockResolvedValue([
    { id: "existing", workspaceRoot: "/repos/portal", defaultModelSelection: model },
  ]);
  await service.implement(item.id, { revision: item.revision });
  expect(store.latestImplementation(item.id, "/profile")).toMatchObject({
    projectId: "existing",
    model,
  });
});

it("deduplicates concurrent launches and explicit new-thread requests", async () => {
  const { service, item, client, store } = fixture();
  const [first, duplicate] = await Promise.all([
    service.implement(item.id, { revision: item.revision }),
    service.implement(item.id, { revision: item.revision }),
  ]);
  expect(first?.id).toBe(duplicate?.id);
  expect(client.launch).toHaveBeenCalledTimes(1);
  const current = store.get(item.id);
  assert(current);
  const revision = current.revision;
  const [next, nextDuplicate] = await Promise.all([
    service.implement(item.id, { revision, previousAttemptId: first?.id }),
    service.implement(item.id, { revision, previousAttemptId: first?.id }),
  ]);
  expect(next?.id).not.toBe(first?.id);
  expect(next?.id).toBe(nextDuplicate?.id);
  expect(client.launch).toHaveBeenCalledTimes(2);
});

it("resumes the persisted handoff after a restart without changing its task or IDs", async () => {
  const { service, ports, item, client, store } = fixture();
  vi.mocked(client.launch).mockRejectedValueOnce(new Error("lost response with private-token"));
  await expect(service.implement(item.id, { revision: item.revision })).rejects.toThrow(
    "could not confirm",
  );
  const pending = store.latestImplementation(item.id, "/profile");
  assert(pending);
  expect(store.get(item.id)?.status).toBe("open");
  expect(pending.error).not.toContain("private-token");
  store.update(item.id, { prompt: "A later edit" }, item.revision);
  await createT3(ports).implement(item.id, { revision: item.revision });
  const retried = vi.mocked(client.launch).mock.calls[1][1];
  expect(retried.id).toBe(pending.id);
  expect(retried.prompt).toBe(pending.prompt);
  expect(service.options(item.id).latest?.revision).toBe(item.revision);
});

it("rejects stale, unrefined, closed, and missing-repository tasks before dispatch", async () => {
  const { service, store, item, client, documents } = fixture();
  await expect(service.implement(item.id, { revision: 0 })).rejects.toThrow("changed");
  const review = store.update(item.id, { processing: "review" }, item.revision);
  await expect(service.implement(item.id, { revision: review.revision })).rejects.toThrow(
    "refined commitment",
  );
  const closed = store.update(item.id, { processing: "ready", status: "done" }, review.revision);
  await expect(service.implement(item.id, { revision: closed.revision })).rejects.toThrow(
    "refined commitment",
  );
  const ready = store.update(item.id, { status: "open" }, closed.revision);
  await expect(
    service.implement(item.id, { revision: ready.revision, repositoryId: "unknown" }),
  ).rejects.toThrow("Choose a discovered");
  expect(client.launch).not.toHaveBeenCalled();
  documents[0].content = "x".repeat(120000);
  await service.implement(item.id, { revision: ready.revision });
  expect(vi.mocked(client.launch).mock.calls[0][1].prompt).toBe(item.prompt);
});

it("preserves a working connection when reconnection fails and isolates pending handoffs by instance", async () => {
  const { service, item, client, ports } = fixture();
  vi.mocked(client.connect).mockRejectedValueOnce(new Error("rejected"));
  await expect(
    service.connect({
      endpoint: "https://other.example",
      credential: "bad",
      instanceId: "codex",
      model: "model",
    }),
  ).rejects.toThrow("rejected");
  expect(service.status().endpoint).toBe(connection.endpoint);
  vi.mocked(client.launch).mockRejectedValueOnce(new Error("lost reply"));
  await expect(service.implement(item.id, { revision: item.revision })).rejects.toThrow(
    "could not confirm",
  );
  ports.settings.saveT3({ ...connection, environmentId: "other-instance" });
  await expect(service.implement(item.id, { revision: item.revision })).rejects.toThrow(
    "original T3 Code instance",
  );
  expect(client.launch).toHaveBeenCalledTimes(1);
});

it("rechecks the item revision after network reads before authorizing a handoff", async () => {
  const { service, item, client, store } = fixture();
  vi.mocked(client.projects).mockImplementationOnce(async () => {
    store.update(item.id, { prompt: "Changed during connection" }, item.revision);
    return [];
  });
  await expect(service.implement(item.id, { revision: item.revision })).rejects.toThrow("changed");
  expect(client.launch).not.toHaveBeenCalled();
  expect(store.latestImplementation(item.id, "/profile")).toBeNull();
});

it("exchanges pairing credentials, validates the API, and never reuses tokens across endpoints", async () => {
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/.well-known/t3/environment")
      return Response.json({ environmentId: "local", serverVersion: "0.0.29" });
    if (path === "/oauth/token") {
      expect(new URLSearchParams(String(init?.body)).get("subject_token")).toBe("pairing-token");
      expect(init?.redirect).toBe("error");
      return Response.json({
        access_token: "private-token",
        token_type: "Bearer",
        scope: "orchestration:read orchestration:operate",
      });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-token");
    return Response.json({ projects: [] });
  });
  const client = createT3Client(request);
  const input = {
    endpoint: connection.endpoint,
    credential: "pairing-token",
    instanceId: "codex",
    model: "test-model",
  };
  expect(await client.connect(input)).toEqual(connection);
  await expect(
    client.connect({ ...input, endpoint: "https://other.example", credential: "" }, connection),
  ).rejects.toThrow("fresh T3 Code pairing token");
  for (const endpoint of [
    "file:///tmp",
    "https://user:password@example.com",
    "https://example.com/?token=secret",
    "https://example.com/path",
  ])
    expect(t3ConnectionSchema.safeParse({ ...input, endpoint }).success).toBe(false);
});

it("bootstraps over WebSocket and recovers a lost reply from the authoritative thread snapshot", async () => {
  const { service, item, store } = fixture();
  await service.implement(item.id, { revision: item.revision });
  const entry = store.latestImplementation(item.id, "/profile");
  assert(entry);
  const server = mockT3();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = createT3Client();
  const connected = await client.connect({
    endpoint,
    credential: "fixture-pairing",
    instanceId: "codex",
    model: "fixture-model",
  });
  entry.endpoint = endpoint;
  entry.environmentId = connected.environmentId;
  await expect(client.launch(connected, entry)).rejects.toThrow("disconnected before confirming");
  await client.launch(connected, entry);
  const commands = await fetch(`${endpoint}/test/commands`).then((response) => response.json());
  expect(commands[0]).toMatchObject({ type: "project.create", workspaceRoot: "/repos/portal" });
  expect(commands[1]).toMatchObject({
    type: "thread.turn.start",
    threadId: entry.id,
    runtimeMode: "approval-required",
    bootstrap: {
      prepareWorktree: { baseBranch: "commit-sha", requireWorktree: true },
      createThread: { projectId: entry.projectId },
    },
  });
  expect(commands).toHaveLength(2);
  await client.launch(connected, { ...entry, id: "another-thread" });
  const repeated = await fetch(`${endpoint}/test/commands`).then((response) => response.json());
  expect(repeated).toHaveLength(3);
});

it("redacts external errors and reports unsupported API responses", async () => {
  const denied = createT3Client(async () =>
    Response.json({ error: "private-token" }, { status: 401 }),
  );
  await expect(denied.projects(connection)).rejects.toThrow("Reconnect in Settings");
  const incompatible = createT3Client(async () => Response.json({ unexpected: true }));
  await expect(incompatible.projects(connection)).rejects.toThrow("unsupported project API");
});

it("persists private settings and handoffs, and exposes only sanitized connection state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-t3-"));
  const defaults = { ...config, dataDir: root, profileDir: join(root, "profile") };
  const settings = new SettingsStore(defaults);
  settings.saveT3(connection);
  expect(statSync(join(root, "settings.json")).mode & 0o777).toBe(0o600);
  expect(new SettingsStore(defaults).t3Connection()).toEqual(connection);
  const store = new Store(join(root, "assistant.sqlite"));
  const item = store.capture("task");
  const { service: source, store: sourceStore, item: sourceItem } = fixture();
  await source.implement(sourceItem.id, { revision: sourceItem.revision });
  const entry = sourceStore.latestImplementation(sourceItem.id, "/profile");
  assert(entry);
  store.update(
    item.id,
    { kind: "commitment", processing: "ready", prompt: entry.prompt },
    item.revision,
  );
  store.saveImplementation({
    ...entry,
    itemId: item.id,
    profileRoot: defaults.profileDir,
    mergedCommit: "merged-head",
    completionReview: { head: "merged-head", reason: "Merged into main with no uncommitted work." },
  });
  store.db.close();
  const reopened = new Store(join(root, "assistant.sqlite"));
  const app = createApp({ settings, store: reopened, assistant: null });
  cleanup.push(async () => {
    await app.close();
    reopened.db.close();
  });
  expect(reopened.latestImplementation(item.id, defaults.profileDir)?.state).toBe("submitted");
  const pending = await app.inject({
    url: "/api/completion-reviews",
    headers: { host: "localhost" },
  });
  expect(pending.statusCode).toBe(200);
  const [candidate] = pending.json();
  expect(candidate).toMatchObject({ itemId: item.id, head: "merged-head", revision: 1 });
  const review = (body: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/items/${item.id}/completion-review`,
      headers: { host: "localhost", "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  expect((await review({ ...candidate, decision: "invalid" })).statusCode).toBe(400);
  expect((await review({ ...candidate, revision: 0, decision: "confirm" })).statusCode).toBe(409);
  expect(reopened.get(item.id)?.status).toBe("open");
  expect((await review({ ...candidate, decision: "confirm" })).json().status).toBe("done");
  expect(
    reopened.latestImplementation(item.id, defaults.profileDir)?.completionReview,
  ).toBeUndefined();
  expect(
    (await app.inject({ url: "/api/completion-reviews", headers: { host: "localhost" } })).json(),
  ).toEqual([]);
  expect((await review({ ...candidate, decision: "confirm" })).statusCode).toBe(409);
  const response = await app.inject({ url: "/api/settings/t3", headers: { host: "localhost" } });
  expect(response.json()).toMatchObject({ configured: true, endpoint: connection.endpoint });
  expect(response.body).not.toContain(connection.accessToken);
  const disconnected = await app.inject({
    method: "DELETE",
    url: "/api/settings/t3",
    headers: { host: "localhost" },
  });
  expect(disconnected.json().configured).toBe(false);
  expect(new SettingsStore(defaults).t3Connection()).toBeUndefined();
});

it("resolves a local Git workspace and rejects repositories without a commit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pa-t3-repo-"));
  execFileSync("git", ["init", directory]);
  await expect(implementationWorkspace(directory)).rejects.toThrow("have a commit");
  execFileSync("git", [
    "-C",
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "test: initialize",
  ]);
  expect(await implementationWorkspace(directory)).toMatchObject({
    path: expect.stringContaining("pa-t3-repo-"),
    branch: expect.stringMatching(/^[a-f0-9]{40}$/),
  });
});
