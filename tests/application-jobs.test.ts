import { expect, it, vi } from "vitest";
import { ProfileCommitError } from "../server/application/errors.js";
import type {
  PeopleDirectory,
  PeopleSyncPorts,
  PeopleSyncState,
} from "../server/application/people-ports.js";
import { PeopleSync } from "../server/application/people-sync.js";
import { parseConcept } from "../server/application/profile-document.js";
import type { DiscoveryPorts, DiscoveryProfile } from "../server/application/project-ports.js";
import { ProjectScanner, type ScanStatus } from "../server/application/projects.js";
import { defaultEntra, type EntraConfig } from "../shared/people.js";
import type { ProfileDocument } from "../shared/schema.js";

function discovery(saved: Partial<ScanStatus> = {}) {
  const documents: ProfileDocument[] = [];
  const record = (path: string, content: string) => ({
    ...parseConcept(content, path),
    hash: content,
  });
  const profile: DiscoveryProfile = {
    root: "/profile",
    isGit: () => true,
    documents: () => documents,
    refresh: vi.fn(),
    add: (path, content) => {
      documents.push(record(path, content));
    },
    apply: vi.fn((before, content, saved) => {
      const index = documents.findIndex((doc) => doc.path === before.path);
      if (documents[index].hash !== before.hash)
        throw new Error("Profile document changed during review; retry the scan.");
      documents[index] = record(before.path, content);
      saved();
    }),
    markMissing: vi.fn(),
  };
  const identity = (root: string, name: string) => ({
    root,
    name,
    path: `${root}/${name}`,
    id: name,
  });
  let persisted: Partial<ScanStatus> = saved;
  const io: DiscoveryPorts = {
    loadStatus: () => persisted,
    saveStatus: (state) => {
      persisted = structuredClone(state);
    },
    profileExists: () => true,
    profile: () => profile,
    repositories: async (root) => [identity(root, "repo")],
    identity,
    isProfileRepository: async () => false,
    snapshot: vi.fn(async () => ({ fingerprint: "source-one" })),
    explore: vi.fn(async ({ document }) =>
      document.content.replace(
        "<!-- project-summary:start -->",
        "<!-- project-summary:start -->\nVerified summary",
      ),
    ),
  };
  const settings = {
    projectRoots: ["/repos"],
    profilePath: "/profile",
    timezone: "UTC",
    connection: () => ({ model: "model" }),
  };
  const scanner = new ProjectScanner(settings, io, () => new Date("2026-09-19T12:00:00Z"));
  return { scanner, io, profile, documents, settings, persisted: () => persisted };
}

it("validates discovered drafts before applying and skips unchanged repository exploration", async () => {
  const f = discovery();
  await f.scanner.run();
  expect(f.profile.apply).toHaveBeenCalledTimes(1);
  expect(f.scanner.status().projects[0].outcome).toBe("updated");
  expect(f.persisted().completedSlot).toBe("UTC:2026-09-19");
  await f.scanner.run();
  expect(f.io.explore).toHaveBeenCalledTimes(1);
  expect(f.scanner.status().projects[0].outcome).toBe("unchanged");
  await f.scanner.run(true);
  expect(f.profile.apply).toHaveBeenCalledTimes(2);
  expect(f.profile.refresh).toHaveBeenCalledTimes(3);
});

it.each(["metadata", "personal notes", "source"])(
  "rejects discovery when %s changes and schedules a retry",
  async (change) => {
    const f = discovery();
    if (change === "source")
      vi.mocked(f.io.snapshot)
        .mockResolvedValueOnce({ fingerprint: "one" })
        .mockResolvedValue({ fingerprint: "two" });
    else
      vi.mocked(f.io.explore).mockImplementation(async ({ document }) =>
        change === "metadata"
          ? document.content.replace("repository_name: repo", "repository_name: other")
          : document.content
              .replace("<!-- project-summary:start -->", "<!-- project-summary:start -->\nSummary")
              .replace("## Personal notes", "## Replaced notes"),
      );
    await f.scanner.run();
    expect(f.profile.apply).not.toHaveBeenCalled();
    expect(f.scanner.status()).toMatchObject({
      completedSlot: null,
      nextRetry: "2026-09-19T12:15:00.000Z",
    });
    expect(f.scanner.status().projects[0].outcome).toBe("failed");
    expect(f.documents[0].content).not.toContain("repository_fingerprint");
  },
);

it("reports saved-but-uncommitted discovery writes as unverified", async () => {
  const f = discovery();
  vi.mocked(f.profile.apply).mockImplementation((_before, _content, saved) => {
    saved();
    throw new ProfileCommitError("Commit hook failed");
  });
  await f.scanner.run();
  expect(f.scanner.status().projects[0]).toMatchObject({
    outcome: "unverified",
    error: "Commit hook failed",
  });
});

it("rejects a stale profile draft without replacing the concurrent edit", async () => {
  const f = discovery();
  vi.mocked(f.io.explore).mockImplementation(async ({ document }) => {
    f.documents[0] = {
      ...document,
      hash: "manual-edit",
      content: `${document.content}Manual addition`,
    };
    return document.content.replace(
      "<!-- project-summary:start -->",
      "<!-- project-summary:start -->\nSummary",
    );
  });
  await f.scanner.run();
  expect(f.scanner.status().projects[0].error).toContain("changed during review");
  expect(f.documents[0].content).toContain("Manual addition");
});

it("coalesces discovery requests and restores interrupted scan diagnostics", async () => {
  const f = discovery();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    vi.mocked(f.io.explore).mockImplementation(async ({ document }) => {
      resolve();
      await gate;
      return document.content.replace(
        "<!-- project-summary:start -->",
        "<!-- project-summary:start -->\nSummary",
      );
    });
  });
  const active = f.scanner.run();
  await entered;
  expect(f.scanner.run()).toBe(active);
  expect(f.scanner.isRunning()).toBe(true);
  const interrupted = discovery(f.persisted()).scanner.status();
  expect(interrupted.running).toBe(false);
  expect(interrupted.projects[0].phase).toBe("interrupted");
  finish();
  await f.scanner.close();
  expect(f.scanner.isRunning()).toBe(false);
});

it("people synchronization publishes a complete directory once and honors scheduling", async () => {
  const config: EntraConfig = {
    ...defaultEntra,
    enabled: true,
    tenantId: "tenant",
    authMode: "azure-cli",
  };
  let timestamp: string | null = null;
  const directory: PeopleDirectory = {
    peopleSyncedAt: () => timestamp,
    replacePeople: vi.fn((_root, _tenant, _people, syncedAt) => {
      timestamp = syncedAt;
    }),
  };
  let persisted: Partial<PeopleSyncState> = {};
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const io: PeopleSyncPorts = {
    loadStatus: () => persisted,
    saveStatus: (state) => {
      persisted = structuredClone(state);
    },
    migrate: vi.fn(),
    loadPeople: vi.fn(async () => {
      await gate;
      return { people: [], skipped: 2, warnings: ["Unresolved hierarchy"] };
    }),
  };
  let now = new Date("2026-09-19T12:00:00Z");
  const sync = new PeopleSync(
    { profilePath: "/profile", profileReady: true, entraCredentials: () => config },
    directory,
    io,
    () => now,
  );
  const first = sync.run();
  expect(sync.run()).toBe(first);
  expect(directory.replacePeople).not.toHaveBeenCalled();
  finish();
  await first;
  expect(directory.replacePeople).toHaveBeenCalledWith("/profile", "tenant", [], now.toISOString());
  expect(sync.status()).toMatchObject({
    running: false,
    skipped: 2,
    warnings: ["Unresolved hierarchy"],
  });
  await sync.run(true);
  expect(io.loadPeople).toHaveBeenCalledTimes(1);
  now = new Date("2026-09-20T12:00:00Z");
  vi.mocked(io.loadPeople).mockRejectedValue(new Error("Provider secret details"));
  await sync.run(true);
  expect(directory.replacePeople).toHaveBeenCalledTimes(1);
  expect(sync.status().error).not.toContain("secret details");
  expect(timestamp).toBe("2026-09-19T12:00:00.000Z");
  now = new Date("2026-09-20T12:14:00Z");
  await sync.run(true);
  expect(io.loadPeople).toHaveBeenCalledTimes(2);
  now = new Date("2026-09-20T12:15:00Z");
  await sync.run(true);
  expect(io.loadPeople).toHaveBeenCalledTimes(3);
});
