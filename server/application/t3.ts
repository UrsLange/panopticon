import type { Project } from "../../shared/projects.js";
import type { Item } from "../../shared/schema.js";
import type {
  CompletionReview,
  Implementation,
  ImplementationOptions,
  ImplementationProgress,
  LocalMerge,
  T3Connection,
  T3ConnectionInput,
  T3ImplementationSettings,
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
  projects(profile: string): Project[];
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
  localMerge,
}: {
  records: ImplementationRecords;
  settings: {
    t3Connection(): T3Connection | undefined;
    saveT3(connection: T3Connection | undefined): void;
    t3Defaults(): T3ImplementationSettings;
    saveT3Defaults(defaults: T3ImplementationSettings): void;
  };
  client: T3Client;
  getProfile(): ProfileNotes;
  repositories(): ImplementationRepository[];
  workspace(path: string): Promise<{ path: string; branch: string }>;
  id(): string;
  now(): string;
  localMerge(implementation: Implementation): Promise<LocalMerge>;
}) {
  let active: Promise<unknown> | null = null;
  const status = (): T3Status => {
    const connection = settings.t3Connection();
    return {
      autoStart: settings.t3Defaults().autoStart ?? false,
      configured: !!connection,
      endpoint: connection?.endpoint ?? "",
      serverVersion: connection?.serverVersion ?? "",
      defaultModel: settings.t3Defaults().model,
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
      progress: entry.progress,
      workspaceMode: entry.workspaceMode,
      taskChanged: records.get(entry.itemId)?.prompt !== entry.prompt,
      url: `${entry.endpoint}/${encodeURIComponent(entry.environmentId)}/${encodeURIComponent(entry.id)}`,
    };
  const options = (itemId: string): ImplementationOptions => {
    const item = records.get(itemId);
    if (!item) throw new ApplicationError("not-found", "Item not found");
    const latest = records.latestImplementation(itemId, getProfile().root);
    const available = repositories();
    const suggestedRepositoryId = item.noProject
      ? null
      : item.repositoryId
        ? (available.find((repo) => repo.id === item.repositoryId)?.id ?? null)
        : resolveImplementationRepository(item, available, getProfile().documents());
    const project = records.projects(getProfile().root).find((p) => p.id === suggestedRepositoryId);
    return {
      autoStart: project?.t3?.autoStart ?? settings.t3Defaults().autoStart ?? false,
      configured: status().configured,
      repositories: available,
      suggestedRepositoryId,
      latest: summary(latest),
    };
  };
  const autoStartEligible = (itemId: string, revision: number) => {
    const item = records.get(itemId);
    if (
      !item ||
      item.revision !== revision ||
      item.kind !== "commitment" ||
      item.execution !== "implementation" ||
      !["open", "in_progress", "in_review", "waiting"].includes(item.status) ||
      item.processing !== "ready" ||
      item.processingError ||
      item.clarifications.some((entry) => !entry.resolved) ||
      !item.prompt.trim() ||
      item.noProject
    )
      return false;
    const resolved = options(itemId);
    if (!resolved.autoStart || !resolved.suggestedRepositoryId) return false;
    const previous = records.latestImplementation(itemId, getProfile().root);
    return (
      !previous ||
      (previous.state === "pending" &&
        previous.prompt === item.prompt &&
        previous.repositoryId === resolved.suggestedRepositoryId)
    );
  };
  const implement = async (
    itemId: string,
    input: { revision: number; repositoryId?: string; previousAttemptId?: string },
    automatic = false,
  ) => {
    const currentItem = records.get(itemId);
    if (currentItem?.noProject)
      throw new ApplicationError("invalid", "Assign a project before starting work in T3 Code.");
    if (currentItem?.execution === "manual")
      throw new ApplicationError(
        "invalid",
        "Choose Implementation before starting work in T3 Code.",
      );
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
        item.execution !== "implementation" ||
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
      const overrides = records.projects(profile.root).find((p) => p.id === repository.id)?.t3;
      const defaults = settings.t3Defaults();
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
        model: overrides?.model ?? defaults.model,
        workspaceMode: overrides?.workspaceMode ?? defaults.workspaceMode,
        runtimeMode: overrides?.runtimeMode ?? defaults.runtimeMode,
        createdAt: now(),
        state: "pending",
        error: null,
      };
      assertRevision(records.get(itemId), input.revision);
      if (getProfile().root !== profile.root)
        throw new ApplicationError("conflict", "The profile changed. Reload before implementing.");
      if (automatic && !autoStartEligible(itemId, input.revision)) return null;
      if (automatic) entry.autoStarted = true;
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
        records.update(itemId, { status: "in_progress", autoStartError: null }, current.revision);
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
      item.noProject ||
      item.execution !== "implementation" ||
      ["done", "archived"].includes(item.status)
    )
      return;
    const connection = settings.t3Connection();
    const progress: ImplementationProgress = {
      turnState: entry.progress?.turnState ?? null,
      checkedAt: now(),
      error: null,
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
    try {
      if (entry.workspaceMode !== "checkout") progress.localMerge = await localMerge(entry);
    } catch (error) {
      errors.push(
        error instanceof ApplicationError
          ? error.message
          : "Local merge status is unavailable. Check the implementation branch and local repository.",
      );
    }
    if (getProfile().root !== profileRoot) return;
    const latest = records.latestImplementation(itemId, profileRoot);
    if (latest?.id !== entry.id) return;
    const current = records.get(itemId);
    if (!current || current.revision !== item.revision) return;
    const newlyMerged =
      progress.localMerge?.merged && progress.localMerge.head !== entry.mergedCommit;
    if (progress.localMerge?.merged) entry.mergedCommit = progress.localMerge.head;
    const newlyFinished =
      progress.turnState === "completed" && entry.progress?.turnState !== "completed";
    const newlyRunning =
      progress.turnState === "running" && entry.progress?.turnState !== "running";
    const firstCheck = entry.progress?.turnState == null;
    progress.error = errors.length ? errors.join(" ") : null;
    entry.progress = progress;
    const merge = progress.localMerge;
    if (newlyMerged && merge && current.processing === "ready" && current.prompt === entry.prompt) {
      entry.completionReview = {
        head: merge.head,
        reason: `The implementation branch ${merge.branch} was merged into ${merge.mainBranch}, with no uncommitted work detected.`,
      };
    }
    records.saveImplementation(entry);
    if (current.processing !== "ready" || current.prompt !== entry.prompt) return;
    if (
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
  const completionReviews = (): CompletionReview[] =>
    records.list().flatMap((item) => {
      const entry = records.latestImplementation(item.id, getProfile().root);
      if (
        !entry?.completionReview ||
        item.execution !== "implementation" ||
        item.kind !== "commitment" ||
        ["done", "archived"].includes(item.status) ||
        item.processing !== "ready" ||
        item.prompt !== entry.prompt
      )
        return [];
      return [
        {
          itemId: item.id,
          implementationId: entry.id,
          revision: item.revision,
          title: item.title,
          ...entry.completionReview,
        },
      ];
    });
  return {
    status,
    defaults: () => settings.t3Defaults(),
    saveAutoStart: (autoStart: boolean) => {
      settings.saveT3Defaults({ ...settings.t3Defaults(), autoStart });
      return status();
    },
    saveDefaults: (defaults: T3ImplementationSettings) => {
      settings.saveT3Defaults(defaults);
      return settings.t3Defaults();
    },
    options,
    autoStart: (itemId: string, revision: number) =>
      exclusive(async () => {
        if (!autoStartEligible(itemId, revision)) return;
        try {
          await implement(itemId, { revision }, true);
        } catch (error) {
          const current = records.get(itemId);
          if (current?.revision === revision)
            records.update(
              itemId,
              {
                autoStartError:
                  error instanceof ApplicationError
                    ? error.message
                    : "T3 Code auto-start failed. Check T3 settings and try Implement manually.",
              },
              revision,
            );
        }
      }),
    completionReviews,
    reviewCompletion: (
      itemId: string,
      input: {
        implementationId: string;
        head: string;
        revision: number;
        decision: "confirm" | "keep_open";
      },
    ) => {
      const candidate = completionReviews().find((review) => review.itemId === itemId);
      const entry = records.latestImplementation(itemId, getProfile().root);
      if (
        !entry ||
        !candidate ||
        candidate.implementationId !== input.implementationId ||
        candidate.head !== input.head
      )
        throw new ApplicationError(
          "conflict",
          "This completion suggestion changed. Reload before reviewing.",
        );
      const current = records.get(itemId);
      assertRevision(current, input.revision);
      const updated = records.update(
        itemId,
        { status: input.decision === "confirm" ? "done" : current.status },
        input.revision,
      );
      delete entry.completionReview;
      records.saveImplementation(entry);
      return updated;
    },
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
    connect: (input: T3ConnectionInput) =>
      exclusive(async () => {
        const connection = await client.connect(input, settings.t3Connection());
        settings.saveT3(connection);
        settings.saveT3Defaults({ ...settings.t3Defaults(), model: connection.defaultModel });
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
