import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createT3, type T3Client } from "../server/application/t3.js";
import { createApp } from "../server/bootstrap.js";
import { config } from "../server/config.js";
import { SettingsStore } from "../server/settings.js";
import { Store } from "../server/store.js";
import { createT3Client, implementationWorkspace } from "../server/t3.js";
import type { ProfileDocument } from "../shared/schema.js";
import { type T3Connection, t3ConnectionSchema } from "../shared/t3.js";
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
  const repositories = [
    { id: "repo", name: "portal", path: "/repos/portal", document: "portal.md" },
  ];
  const client: T3Client = {
    connect: vi.fn(async () => connection),
    projects: vi.fn(async () => []),
    launch: vi.fn(async () => {}),
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
  };
  return { service: createT3(ports), ports, store, item, client, documents, repositories };
}

it("routes exact references, sends saved context, and leaves the commitment open", async () => {
  const { service, store, item, client } = fixture();
  expect(service.options(item.id).suggestedRepositoryId).toBe("repo");
  const launched = await service.implement(item.id, { revision: item.revision });
  const entry = store.latestImplementation(item.id, "/profile");
  assert(entry);
  expect(entry.prompt).toBe(item.prompt);
  expect(vi.mocked(client.launch).mock.calls[0][1].prompt).toBe(item.prompt);
  expect(launched?.url).toBe("http://127.0.0.1:3773/local/id-1");
  expect(entry.state).toBe("submitted");
  expect(store.get(item.id)?.status).toBe("open");
  expect(client.launch).toHaveBeenCalledTimes(1);
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
  const { service, item, client } = fixture();
  const [first, duplicate] = await Promise.all([
    service.implement(item.id, { revision: item.revision }),
    service.implement(item.id, { revision: item.revision }),
  ]);
  expect(first?.id).toBe(duplicate?.id);
  expect(client.launch).toHaveBeenCalledTimes(1);
  const [next, nextDuplicate] = await Promise.all([
    service.implement(item.id, { revision: item.revision, previousAttemptId: first?.id }),
    service.implement(item.id, { revision: item.revision, previousAttemptId: first?.id }),
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
  store.saveImplementation({
    ...entry,
    itemId: item.id,
  });
  store.db.close();
  const reopened = new Store(join(root, "assistant.sqlite"));
  const app = createApp({ settings, store: reopened, assistant: null });
  cleanup.push(async () => {
    await app.close();
    reopened.db.close();
  });
  expect(reopened.latestImplementation(item.id, "/profile")?.state).toBe("submitted");
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
