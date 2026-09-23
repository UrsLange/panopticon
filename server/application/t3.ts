import type { Item } from "../../shared/schema.js";
import type {
  Implementation,
  ImplementationOptions,
  ImplementationProgress,
  PullRequest,
  T3Connection,
  T3ConnectionInput,
  T3Model,
  T3Status,
} from "../../shared/t3.js";
import { ApplicationError } from "./errors.js";
import {
  type ImplementationRepository,
  resolveImplementationRepository,
} from "./implementation-repository.js";
import { assertRevision } from "./items.js";
import type { CaptureRecords, ProfileNotes } from "./ports.js";

export interface T3Client {
  connect(input: T3ConnectionInput, previous?: T3Connection): Promise<T3Connection>;
  projects(
    connection: T3Connection,
  ): Promise<{ id: string; workspaceRoot: string; defaultModelSelection: T3Model | null }[]>;
  launch(connection: T3Connection, implementation: Implementation): Promise<void>;
  progress(
    connection: T3Connection,
    implementation: Implementation,
  ): Promise<ImplementationProgress["turnState"]>;
}
export interface ImplementationRecords extends CaptureRecords {
  list(): Item[];
  latestImplementation(itemId: string, profileRoot: string): Implementation | null;
  saveImplementation(implementation: Implementation): void;
}

export function createT3({
  records,
  settings,
  client,
  getProfile,
  repositories,
  workspace,
  id,
  now,
  pullRequest,
}: {
  records: ImplementationRecords;
  settings: {
    t3Connection(): T3Connection | undefined;
    saveT3(connection: T3Connection | undefined): void;
  };
  client: T3Client;
  getProfile(): ProfileNotes;
  repositories(): ImplementationRepository[];
  workspace(path: string): Promise<{ path: string; branch: string }>;
  id(): string;
  now(): string;
  pullRequest(url: string): Promise<PullRequest>;
}) {
  let active: Promise<unknown> | null = null;
  const status = (): T3Status => {
    const connection = settings.t3Connection();
    return {
      configured: !!connection,
      endpoint: connection?.endpoint ?? "",
      serverVersion: connection?.serverVersion ?? "",
      defaultModel: connection?.defaultModel ?? { instanceId: "codex", model: "" },
    };
  };
  const summary = (entry: Implementation | null) =>
    entry && {
      id: entry.id,
      revision: entry.revision,
      repositoryId: entry.repositoryId,
      workspaceRoot: entry.workspaceRoot,
      createdAt: entry.createdAt,
      state: entry.state,
      error: entry.error,
      pullRequestUrl: entry.pullRequestUrl,
      progress: entry.progress,
      taskChanged: records.get(entry.itemId)?.prompt !== entry.prompt,
      url: `${entry.endpoint}/${encodeURIComponent(entry.environmentId)}/${encodeURIComponent(entry.id)}`,
    };
  const options = (itemId: string): ImplementationOptions => {
    const item = records.get(itemId);
    if (!item) throw new ApplicationError("not-found", "Item not found");
    const latest = records.latestImplementation(itemId, getProfile().root);
    const available = repositories();
    return {
      configured: status().configured,
      repositories: available,
      suggestedRepositoryId: item.repositoryId
        ? (available.find((repo) => repo.id === item.repositoryId)?.id ?? null)
        : resolveImplementationRepository(item, available, getProfile().documents()),
      latest: summary(latest),
    };
  };
  const implement = async (
    itemId: string,
    input: { revision: number; repositoryId?: string; previousAttemptId?: string },
  ) => {
    const connection = settings.t3Connection();
    if (!connection) throw new ApplicationError("invalid", "Connect T3 Code in Settings first.");
    const profile = getProfile();
    const previous = records.latestImplementation(itemId, profile.root);
    if (previous?.state === "submitted" && input.previousAttemptId !== previous.id)
      return summary(previous);
    let entry = previous?.state === "pending" ? previous : null;
    if (
      entry &&
      (entry.endpoint !== connection.endpoint || entry.environmentId !== connection.environmentId)
    )
      throw new ApplicationError(
        "conflict",
        "Reconnect the original T3 Code instance to retry this handoff.",
      );
    if (!entry) {
      const item = records.get(itemId);
      assertRevision(item, input.revision);
      if (
        item.kind !== "commitment" ||
        !["open", "in_progress", "in_review", "waiting"].includes(item.status) ||
        item.processing !== "ready" ||
        item.processingError ||
        !item.prompt.trim()
      )
        throw new ApplicationError(
          "invalid",
          "Use an open, refined commitment without unresolved processing errors.",
        );
      const repositoryId = input.repositoryId ?? options(itemId).suggestedRepositoryId;
      const repository = repositories().find((repo) => repo.id === repositoryId);
      if (!repository)
        throw new ApplicationError(
          "invalid",
          "Choose a discovered repository for this commitment.",
        );
      const location = await workspace(repository.path);
      const projects = await client.projects(connection);
      const matches = projects.filter((project) => project.workspaceRoot === location.path);
      if (matches.length > 1)
        throw new ApplicationError(
          "conflict",
          "Multiple T3 projects use this repository. Remove the ambiguity in T3 Code before implementing.",
        );
      const project = matches[0];
      entry = {
        id: id(),
        itemId,
        revision: item.revision,
        profileRoot: profile.root,
        endpoint: connection.endpoint,
        environmentId: connection.environmentId,
        repositoryId: repository.id,
        workspaceRoot: location.path,
        baseBranch: location.branch,
        projectId: project?.id ?? id(),
        title: item.title,
        prompt: item.prompt,
        model: project?.defaultModelSelection ?? connection.defaultModel,
        createdAt: now(),
        state: "pending",
        error: null,
      };
      assertRevision(records.get(itemId), input.revision);
      if (getProfile().root !== profile.root)
        throw new ApplicationError("conflict", "The profile changed. Reload before implementing.");
      records.saveImplementation(entry);
    }
    try {
      await client.launch(connection, entry);
      entry.state = "submitted";
      entry.error = null;
      records.saveImplementation(entry);
      const current = records.get(itemId);
      if (
        current?.kind === "commitment" &&
        current.revision === input.revision &&
        current.prompt === entry.prompt &&
        getProfile().root === entry.profileRoot &&
        !["done", "archived"].includes(current.status)
      )
        records.update(itemId, { status: "in_progress" }, current.revision);
      return summary(entry);
    } catch (error) {
      entry.error =
        error instanceof ApplicationError
          ? error.message
          : "T3 Code could not confirm the handoff. Retry to check the same thread.";
      records.saveImplementation(entry);
      throw new ApplicationError("unavailable", entry.error);
    }
  };
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = (active ?? Promise.resolve()).catch(() => {}).then(action);
    active = pending;
    void pending
      .finally(() => {
        if (active === pending) active = null;
      })
      .catch(() => {});
    return pending;
  };
  const refresh = async (itemId: string) => {
    const profileRoot = getProfile().root;
    const entry = records.latestImplementation(itemId, profileRoot);
    const item = records.get(itemId);
    if (
      entry?.state !== "submitted" ||
      !item ||
      item.kind !== "commitment" ||
      ["done", "archived"].includes(item.status)
    )
      return;
    const connection = settings.t3Connection();
    const progress: ImplementationProgress = {
      turnState: entry.progress?.turnState ?? null,
      checkedAt: now(),
      error: null,
      pullRequest: entry.progress?.pullRequest,
    };
    const errors: string[] = [];
    if (
      connection?.endpoint === entry.endpoint &&
      connection.environmentId === entry.environmentId
    ) {
      try {
        progress.turnState = await client.progress(connection, entry);
      } catch {
        errors.push("T3 progress is unavailable. Reconnect or check the thread in T3 Code.");
      }
    } else {
      errors.push("Reconnect the original T3 Code instance to check agent progress.");
    }
    if (entry.pullRequestUrl) {
      try {
        progress.pullRequest = await pullRequest(entry.pullRequestUrl);
      } catch {
        errors.push(
          "Pull request status is unavailable. Check GitHub CLI installation, sign-in, and repository access on the Panopticon server.",
        );
      }
    }
    if (getProfile().root !== profileRoot) return;
    const latest = records.latestImplementation(itemId, profileRoot);
    if (latest?.id !== entry.id || latest.pullRequestUrl !== entry.pullRequestUrl) return;
    const current = records.get(itemId);
    if (!current || current.revision !== item.revision) return;
    const newlyMerged =
      progress.pullRequest?.state === "MERGED" &&
      !!progress.pullRequest.mergedAt &&
      !(entry.progress?.pullRequest?.state === "MERGED" && entry.progress.pullRequest.mergedAt);
    const newlyFinished =
      progress.turnState === "completed" && entry.progress?.turnState !== "completed";
    const newlyRunning =
      progress.turnState === "running" && entry.progress?.turnState !== "running";
    const firstCheck = entry.progress?.turnState == null;
    progress.error = errors.length ? errors.join(" ") : null;
    entry.progress = progress;
    records.saveImplementation(entry);
    if (current.processing !== "ready" || current.prompt !== entry.prompt) return;
    if (newlyMerged) records.update(itemId, { status: "done" }, current.revision);
    else if (
      (current.status === "in_progress" || (current.status === "open" && firstCheck)) &&
      newlyFinished
    )
      records.update(itemId, { status: "in_review" }, current.revision);
    else if (
      (current.status === "in_review" || (current.status === "open" && firstCheck)) &&
      newlyRunning
    )
      records.update(itemId, { status: "in_progress" }, current.revision);
  };
  const checks = new Map<string, Promise<void>>();
  const checkProgress = (itemId: string) => {
    const pending = checks.get(itemId);
    if (pending) return pending;
    const check = refresh(itemId).finally(() => checks.delete(itemId));
    checks.set(itemId, check);
    return check;
  };
  let refreshing: Promise<void> | null = null;
  return {
    status,
    options,
    refresh: async (itemId: string) => {
      await checkProgress(itemId);
      return options(itemId);
    },
    refreshActive: () => {
      if (refreshing) return refreshing;
      refreshing = Promise.all(
        records
          .list()
          .filter(
            (item) => item.kind === "commitment" && !["done", "archived"].includes(item.status),
          )
          .map((item) => checkProgress(item.id)),
      )
        .then(() => {})
        .finally(() => {
          refreshing = null;
        });
      return refreshing;
    },
    linkPullRequest: (
      itemId: string,
      input: { implementationId: string; url: string | null; revision: number },
    ) =>
      exclusive(async () => {
        await checks.get(itemId);
        const item = records.get(itemId);
        assertRevision(item, input.revision);
        const entry = records.latestImplementation(itemId, getProfile().root);
        if (!entry || entry.id !== input.implementationId || entry.state !== "submitted")
          throw new ApplicationError(
            "conflict",
            "Reload the current implementation before linking a pull request.",
          );
        if (["done", "archived"].includes(item.status))
          throw new ApplicationError(
            "invalid",
            "Reopen the task before changing its pull request.",
          );
        if (input.url !== (entry.pullRequestUrl ?? null) && entry.progress)
          delete entry.progress.pullRequest;
        if (input.url) entry.pullRequestUrl = input.url;
        else delete entry.pullRequestUrl;
        records.saveImplementation(entry);
        await checkProgress(itemId);
        return options(itemId);
      }),
    connect: (input: T3ConnectionInput) =>
      exclusive(async () => {
        settings.saveT3(await client.connect(input, settings.t3Connection()));
        return status();
      }),
    test: () =>
      exclusive(async () => {
        const connection = settings.t3Connection();
        if (!connection) throw new ApplicationError("invalid", "Connect T3 Code first.");
        await client.projects(connection);
        return status();
      }),
    disconnect: () =>
      exclusive(async () => {
        settings.saveT3(undefined);
        return status();
      }),
    implement: (itemId: string, input: Parameters<typeof implement>[1]) =>
      exclusive(() => implement(itemId, input)),
    async close() {
      await active?.catch(() => {});
      await Promise.allSettled(checks.values());
    },
  };
}
