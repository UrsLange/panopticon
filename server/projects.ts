import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProjectExploration } from "./application/exploration.js";
import type { DiscoveryPorts } from "./application/project-ports.js";
import { ProjectScanner, type ScanStatus } from "./application/projects.js";
import { Profile } from "./profile.js";
import { exploreProject } from "./project-exploration.js";
import type { SettingsStore } from "./settings.js";

const execute = promisify(execFile);
async function git(path: string, args: string[]) {
  return (
    await execute(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", path, ...args],
      { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
    )
  ).stdout;
}
const excluded =
  /(^|\/)(\.env[^/]*|\.git|node_modules|dist|build|vendor|coverage|\.next|\.venv|[^/]*(?:secret|credential|token)[^/]*)(\/|$)|\.(?:pem|key|p12|pfx)$/i;
export async function repositorySnapshot(path: string) {
  let commit = "unborn";
  try {
    commit = (await git(path, ["rev-parse", "HEAD"])).trim();
  } catch {
    await git(path, ["rev-parse", "--git-dir"]);
  }
  const files = [
    ...new Set(
      (await git(path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  if (files.length > 50000) throw new Error("Repository exceeds the 50,000-file scan limit.");
  const hash = createHash("sha256")
    .update("project-discovery-v2")
    .update(commit)
    .update(await git(path, ["ls-files", "--stage", "-z"]));
  for (const file of files) {
    if (file.split("/").includes("..") || excluded.test(file)) continue;
    const absolute = join(path, file);
    let stat: Stats;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update(`${file}:deleted`);
        continue;
      }
      throw error;
    }
    hash.update(JSON.stringify([file, stat.mode, stat.size, stat.mtimeMs]));
  }
  return { fingerprint: hash.digest("hex") };
}

export function createProjectScanner(
  settings: SettingsStore,
  explorer: (request: ProjectExploration) => Promise<string> = (request) =>
    exploreProject(request, settings.credentials()),
  now = () => new Date(),
) {
  return new ProjectScanner(settings, projectAdapters(settings.dataDir, explorer), now);
}

export function projectAdapters(
  dataDir: string,
  explorer: (request: ProjectExploration) => Promise<string>,
): DiscoveryPorts {
  const stateFile = join(dataDir, "project-scan.json");
  const identity = (root: string, name: string) => {
    const path = join(root, name);
    return { root, name, path, id: createHash("sha256").update(path).digest("hex").slice(0, 24) };
  };
  return {
    loadStatus: () =>
      existsSync(stateFile)
        ? (JSON.parse(readFileSync(stateFile, "utf8")) as Partial<ScanStatus>)
        : {},
    saveStatus(state) {
      mkdirSync(dataDir, { recursive: true });
      const temporary = `${stateFile}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(temporary, stateFile);
    },
    profileExists: existsSync,
    identity,
    async repositories(root) {
      return (await readdir(root, { withFileTypes: true }))
        .filter(
          (child) =>
            child.isDirectory() &&
            !child.isSymbolicLink() &&
            existsSync(join(root, child.name, ".git")),
        )
        .map((child) => identity(root, child.name));
    },
    async isProfileRepository(path, profile) {
      if (
        (await realpath((await git(path, ["rev-parse", "--show-toplevel"])).trim())) !==
        (await realpath(path))
      )
        throw new Error("Not a repository root");
      return (await realpath(path)) === (await realpath(profile));
    },
    snapshot: repositorySnapshot,
    explore: explorer,
    profile(root) {
      const profile = new Profile(root);
      return {
        root,
        isGit: () => profile.isGit(),
        documents: () => profile.documents(),
        refresh: () => profile.change("refresh profile navigation", () => profile.reconcileIndex()),
        add(file, content) {
          profile.change("add discovered project", () => {
            profile.prepareWrite(file);
            profile.checkWritable("index.md");
            writeFileSync(join(root, file), content, { flag: "wx" });
            profile.reconcileIndex();
          });
        },
        apply(before, content, saved) {
          profile.change("refresh project summary", () => {
            if (profile.documents().find((item) => item.path === before.path)?.hash !== before.hash)
              throw new Error("Profile document changed during review; retry the scan.");
            profile.prepareWrite(before.path);
            if (content !== before.content) {
              profile.save(before.path, content, before.hash);
              saved();
            }
            profile.reconcileIndex();
          });
        },
        markMissing(doc, content) {
          profile.change("mark project unavailable", () => {
            profile.checkWritable("index.md");
            profile.save(doc.path, content, doc.hash);
            profile.reconcileIndex();
          });
        },
      };
    },
  };
}
