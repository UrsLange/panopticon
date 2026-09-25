import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ProjectAction, ProjectGit } from "../shared/projects.js";
import { ApplicationError } from "./application/errors.js";
import type { ProjectWorkspaceIO } from "./application/project-workspace.js";
import { repositoryInsights } from "./repository-insights.js";

function git(path: string, args: string[], input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      "git",
      ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", path, ...args],
      {
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end(input);
  });
}

async function optional(path: string, args: string[]) {
  try {
    return (await git(path, args)).trim();
  } catch {
    return null;
  }
}

export function repositoryWebUrl(remote: string | null) {
  if (!remote) return null;
  const ssh = remote.match(/^(?:ssh:\/\/)?git@([^/:]+)[:/]([^?#]+?)(?:\.git)?$/);
  try {
    const url = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : remote);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.protocol = "https:";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function changedFiles(status: string) {
  const entries = status.split("\0");
  const files: { path: string; status: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    files.push({ status: entry.slice(0, 2), path: entry.slice(3) });
    if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  return files;
}

async function inspect(path: string): Promise<ProjectGit> {
  const [status, branch, head, remotes] = await Promise.all([
    git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    optional(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    optional(path, ["rev-parse", "--verify", "HEAD"]),
    git(path, ["remote"]),
  ]);
  const upstream = branch
    ? await optional(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    : null;
  const configuredRemote = branch
    ? await optional(path, ["config", "--get", `branch.${branch}.remote`])
    : null;
  const names = remotes.trim().split("\n").filter(Boolean);
  const remote =
    configuredRemote && configuredRemote !== "."
      ? configuredRemote
      : names.includes("origin")
        ? "origin"
        : (names[0] ?? null);
  const remoteHead = remote
    ? await optional(path, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`])
    : null;
  let defaultBranch = remoteHead?.slice((remote?.length ?? 0) + 1) ?? null;
  if (!defaultBranch) {
    for (const candidate of ["main", "master"]) {
      if (
        (await optional(path, ["rev-parse", "--verify", `refs/heads/${candidate}`])) ||
        (remote &&
          (await optional(path, ["rev-parse", "--verify", `refs/remotes/${remote}/${candidate}`])))
      ) {
        defaultBranch = candidate;
        break;
      }
    }
  }
  const counts =
    upstream && head
      ? (await git(path, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]))
          .trim()
          .split(/\s+/)
          .map(Number)
      : [0, 0];
  const gitDir = (await git(path, ["rev-parse", "--absolute-git-dir"])).trim();
  const operation = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ].some((file) => existsSync(join(gitDir, file)));
  const files = changedFiles(status);
  const hash = createHash("sha256")
    .update(status)
    .update(head ?? "")
    .update(branch ?? "")
    .update(upstream ?? "");
  hash.update(await git(path, ["diff", "--no-ext-diff", "--no-textconv", "--binary"]));
  hash.update(await git(path, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary"]));
  for (const file of files) {
    try {
      const stat = await lstat(join(path, file.path), { bigint: true });
      hash.update(`${file.path}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    branch,
    head: head ?? "",
    upstream,
    remote,
    defaultBranch,
    repositoryUrl: repositoryWebUrl(
      remote ? await optional(path, ["remote", "get-url", remote]) : null,
    ),
    dirty: !!status,
    conflicts: files.some((file) => /U|AA|DD/.test(file.status)),
    operation,
    ahead: counts[0],
    behind: counts[1],
    version: hash.digest("hex"),
  };
}

async function execute(path: string, action: ProjectAction, state: ProjectGit) {
  function reject(message: string): never {
    throw new ApplicationError("conflict", message);
  }
  if (state.conflicts || state.operation)
    reject("Resolve the current Git operation in your editor before continuing.");
  if (!state.branch) reject("Check out a branch before changing this repository.");
  try {
    if (action.action === "commit") {
      if (!action.message || !action.files?.length)
        throw new ApplicationError("invalid", "Choose files and enter a commit message.");
      const files = changedFiles(
        await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      );
      if (
        action.files.some(
          (file) =>
            !files.some((entry) => entry.path === file) ||
            file.includes("\0") ||
            isAbsolute(file) ||
            file.split("/").includes(".."),
        )
      )
        throw new ApplicationError("invalid", "Choose current changed files from this checkout.");
      const input = `${action.files.join("\0")}\0`;
      await git(path, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], input);
      await git(
        path,
        ["commit", "--only", "-m", action.message, "--pathspec-from-file=-", "--pathspec-file-nul"],
        input,
      );
      return;
    }
    if (state.dirty) reject("Commit your local changes before continuing.");
    if (action.action === "switch") {
      if (!state.defaultBranch)
        reject("The default branch is unknown. Set the remote HEAD in Git, then refresh.");
      if (state.ahead || (!state.upstream && state.branch !== state.defaultBranch))
        reject("Publish this branch before returning to the default branch.");
      if (await optional(path, ["rev-parse", "--verify", `refs/heads/${state.defaultBranch}`]))
        await git(path, ["switch", "--", state.defaultBranch]);
      else if (state.remote)
        await git(path, [
          "switch",
          "--track",
          "-c",
          state.defaultBranch,
          `${state.remote}/${state.defaultBranch}`,
        ]);
      else reject("The default branch is unavailable locally.");
      return;
    }
    if (!state.remote || !state.upstream)
      reject("Configure an upstream branch in Git before pulling, merging, or pushing.");
    await git(path, ["fetch", "--", state.remote]);
    const current = await inspect(path);
    if (current.version !== state.version)
      reject("The checkout changed during the remote check. Refresh and review it.");
    if (action.action === "push") {
      if (current.behind) reject("Integrate incoming commits before pushing.");
      const remote = await optional(path, ["config", "--get", `branch.${state.branch}.remote`]);
      const target = await optional(path, ["config", "--get", `branch.${state.branch}.merge`]);
      if (!remote || remote === "." || !target?.startsWith("refs/heads/"))
        reject("Configure a remote upstream before publishing.");
      await git(path, ["push", "--", remote, `HEAD:${target}`]);
    } else if (action.action === "pull") {
      if (current.ahead && current.behind)
        reject(
          "The branch has diverged. Review incoming and outgoing commits, then merge explicitly.",
        );
      await git(path, ["merge", "--ff-only", "--", "@{upstream}"]);
    } else {
      await git(path, ["merge", "--no-edit", "--", "@{upstream}"]);
    }
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "conflict",
      "Git could not complete the action. Review the refreshed checkout for conflicts or staged changes; check credentials, hooks, and Git identity before retrying.",
    );
  }
}

export function createProjectWorkspaceIO(): ProjectWorkspaceIO {
  return {
    async discover(roots, profile) {
      const repositories: { id: string; name: string; path: string; root: string }[] = [];
      const errors: string[] = [];
      for (const root of roots) {
        try {
          for (const entry of await readdir(root, { withFileTypes: true })) {
            const path = join(root, entry.name);
            if (
              !entry.isDirectory() ||
              entry.isSymbolicLink() ||
              !existsSync(join(path, ".git")) ||
              resolve(path) === resolve(profile)
            )
              continue;
            repositories.push({
              id: createHash("sha256").update(path).digest("hex").slice(0, 24),
              name: entry.name,
              root,
              path,
            });
          }
        } catch {
          errors.push(`Cannot read project directory: ${root}`);
        }
      }
      return { repositories, errors };
    },
    async validate(project) {
      if (
        resolve(project.root, project.name) !== resolve(project.path) ||
        (await lstat(project.path)).isSymbolicLink()
      )
        throw new ApplicationError("invalid", "Project path is no longer a configured checkout.");
      const actual = await realpath(project.path);
      if (
        actual === (await realpath(project.profileRoot)) ||
        actual !==
          (await realpath((await git(project.path, ["rev-parse", "--show-toplevel"])).trim()))
      )
        throw new ApplicationError(
          "invalid",
          "Project path must be a repository root outside the profile.",
        );
    },
    inspect,
    async refreshRemote(path) {
      const state = await inspect(path);
      if (state.remote) {
        await git(path, ["fetch", "--", state.remote]);
        const head = await git(path, ["ls-remote", "--symref", "--", state.remote, "HEAD"]);
        const branch = head.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
        if (branch)
          await git(path, [
            "symbolic-ref",
            `refs/remotes/${state.remote}/HEAD`,
            `refs/remotes/${state.remote}/${branch}`,
          ]);
      }
    },
    insights: repositoryInsights,
    async changes(path) {
      const state = await inspect(path);
      const status = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const diff = state.head
        ? await git(path, ["diff", "--no-ext-diff", "--no-textconv", "HEAD"])
        : await git(path, ["diff", "--cached", "--no-ext-diff", "--no-textconv"]);
      const commits: { direction: "incoming" | "outgoing"; hash: string; subject: string }[] = [];
      if (state.upstream && state.head) {
        for (const direction of ["incoming", "outgoing"] as const) {
          const range = direction === "incoming" ? "HEAD..@{upstream}" : "@{upstream}..HEAD";
          const log = await git(path, ["log", "--max-count=100", "--format=%h%x00%s", range, "--"]);
          for (const line of log.trim().split("\n").filter(Boolean)) {
            const [hash, ...subject] = line.split("\0");
            commits.push({ direction, hash, subject: subject.join("\0") });
          }
        }
      }
      return {
        files: changedFiles(status),
        diff:
          diff.length > 120000
            ? `${diff.slice(0, 120000)}\n… Diff truncated. Open your editor for the full diff.`
            : diff,
        commits,
      };
    },
    execute,
  };
}
