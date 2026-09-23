import type {
  Implementation,
  ImplementationOptions,
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
}
export interface ImplementationRecords extends CaptureRecords {
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
      if (current?.kind === "commitment" && !["done", "archived"].includes(current.status))
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
  return {
    status,
    options,
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
    },
  };
}
