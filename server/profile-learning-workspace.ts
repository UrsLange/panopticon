import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ProfileCommitError } from "./application/errors.js";
import type {
  ProfileEditingAgent,
  ProfileLearningAgent,
  ProfileLearningInput,
  ProfileLearningTool,
} from "./application/profile-learning-model.js";
import type { Profile } from "./profile.js";

export function runProfileLearning(
  profile: Profile,
  input: ProfileLearningInput,
  agent: ProfileLearningAgent,
) {
  return runProfileEditing(
    profile,
    {
      "activity.json": {
        content: JSON.stringify(
          {
            date: input.date,
            timezone: input.timezone,
            activity: input.activity.map(({ content, ...event }) => ({
              ...event,
              evidence: JSON.parse(content),
            })),
          },
          null,
          2,
        ),
      },
      "provisional-memory.md": { content: input.provisionalMemory, writable: true },
    },
    (workspace, tools) =>
      agent(
        {
          profileRoot: workspace.profileRoot,
          activityPath: workspace.artifactPaths["activity.json"],
          provisionalMemoryPath: workspace.artifactPaths["provisional-memory.md"],
        },
        tools,
      ),
  ).then(({ summary, artifacts }) => ({
    summary,
    provisionalMemory: artifacts["provisional-memory.md"],
  }));
}

export function runProfileEditing(
  profile: Profile,
  suppliedArtifacts: Record<string, { content: string; writable?: boolean }>,
  agent: ProfileEditingAgent,
  guard: () => void = () => {},
) {
  return profile.runAgent(async () => {
    const root = realpathSync(profile.root);
    const expected = new Map(
      profile.documents().map((doc) => [doc.path, doc.content as string | null]),
    );
    for (const path of expected.keys()) profile.checkWritable(path);
    const originalPaths = new Set(expected.keys());
    const artifacts = mkdtempSync(join(tmpdir(), "pa-profile-editing-"));
    const artifactPaths = Object.fromEntries(
      Object.keys(suppliedArtifacts).map((name) => [name, join(artifacts, name)]),
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["--literal-pathspecs", "-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const profilePath = (path: string) => {
      const file = resolve(root, path);
      const local = relative(root, file);
      if (
        isAbsolute(local) ||
        local.split(/[\\/]/).some((part) => !part || part.startsWith(".")) ||
        !local.endsWith(".md")
      )
        throw new Error("Choose a Markdown document inside the profile repository.");
      let current = root;
      for (const part of local.split("/")) {
        current = join(current, part);
        if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
          throw new Error("Profile tools do not follow symbolic links.");
      }
      return { file, local };
    };
    const locate = (path: string, write = false) => {
      const artifact = Object.entries(artifactPaths).find(([, file]) => file === path);
      if (artifact) {
        if (write && !suppliedArtifacts[artifact[0]].writable)
          throw new Error("This artifact is read-only.");
        return path;
      }
      return profilePath(path).file;
    };
    const files = (directory = root): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) return [];
        const file = join(directory, entry.name);
        return entry.isDirectory()
          ? files(file)
          : entry.name.endsWith(".md")
            ? [relative(root, file)]
            : [];
      });
    const verifyObserved = () => {
      guard();
      for (const [path, content] of expected) {
        const { file } = profilePath(path);
        if ((existsSync(file) ? readFileSync(file, "utf8") : null) !== content)
          throw new ProfileCommitError(
            `Profile changed outside the editing session: ${path}. Review the changes before retrying.`,
          );
      }
      for (const path of files()) profile.checkWritable(path);
    };
    const prepare = (path: string) => {
      const { file, local } = profilePath(path);
      verifyObserved();
      profile.prepareWrite(local);
      return { file, local };
    };
    const write = (path: string, content: string) => {
      if (
        Object.entries(artifactPaths).some(
          ([name, file]) => file === path && suppliedArtifacts[name].writable,
        )
      ) {
        writeFileSync(path, content);
        return;
      }
      const { file, local } = prepare(path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      expected.set(local, content);
    };
    const verify = () => {
      verifyObserved();
      const docs = profile.documents();
      const index = docs.find((doc) => doc.path === "index.md");
      const metadata = index?.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!metadata || parse(metadata[1])?.okf_version !== "0.2")
        throw new Error('index.md must declare okf_version: "0.2".');
      return { documents: docs.map(({ path, type, title }) => ({ path, type, title })) };
    };
    const tool = <T>(
      name: string,
      description: string,
      schema: z.ZodType<T>,
      execute: (args: T) => unknown,
    ): ProfileLearningTool => ({
      name,
      description,
      parameters: z.toJSONSchema(schema),
      execute: (args) => execute(schema.parse(args)),
    });
    const tools = [
      tool(
        "list_profile_files",
        "List all Markdown files in the profile repository, including nested folders.",
        z.object({}),
        () => {
          return { files: files().sort() };
        },
      ),
      tool(
        "read_file",
        "Read a profile document or supplied artifact. Set startLine/endLine to null for the complete file, or choose a 1-based inclusive line range.",
        z.object({
          path: z.string(),
          startLine: z.number().int().positive().nullable(),
          endLine: z.number().int().positive().nullable(),
        }),
        ({ path, startLine, endLine }) => {
          const content = readFileSync(locate(path), "utf8");
          const lines = content.split("\n");
          return {
            content:
              startLine === null && endLine === null
                ? content
                : lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n"),
            totalLines: lines.length,
          };
        },
      ),
      tool(
        "write_file",
        "Create or replace a profile Markdown document or a writable supplied artifact. Read existing content first to preserve unrelated knowledge.",
        z.object({ path: z.string(), content: z.string() }),
        ({ path, content }) => {
          locate(path, true);
          write(path, content);
          return { saved: path };
        },
      ),
      tool(
        "edit_file",
        "Replace one exact, unique occurrence in a profile document or a writable supplied artifact.",
        z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string() }),
        ({ path, oldText, newText }) => {
          const content = readFileSync(locate(path, true), "utf8");
          if (content.split(oldText).length !== 2)
            throw new Error(
              "oldText must match exactly once. Read the file and choose a unique passage.",
            );
          write(
            path,
            content.replace(oldText, () => newText),
          );
          return { saved: path };
        },
      ),
      tool(
        "move_file",
        "Move or rename a profile document. Update links and index navigation as needed.",
        z.object({ from: z.string(), to: z.string() }),
        ({ from, to }) => {
          const source = prepare(from);
          const target = prepare(to);
          if (existsSync(target.file)) throw new Error("The destination already exists.");
          const content = readFileSync(source.file, "utf8");
          mkdirSync(dirname(target.file), { recursive: true });
          renameSync(source.file, target.file);
          expected.set(source.local, null);
          expected.set(target.local, content);
          return { moved: to };
        },
      ),
      tool(
        "delete_file",
        "Delete an obsolete profile document after preserving relevant knowledge elsewhere and updating links.",
        z.object({ path: z.string() }),
        ({ path }) => {
          const target = prepare(path);
          unlinkSync(target.file);
          expected.set(target.local, null);
          return { deleted: path };
        },
      ),
      tool(
        "check_profile",
        "Check profile document structure and detect external edits. Inspect the content and navigation yourself as well.",
        z.object({}),
        verify,
      ),
      tool(
        "profile_diff",
        "Inspect the current Git diff and newly created profile documents before committing.",
        z.object({}),
        () => {
          verifyObserved();
          const paths = profile.pendingPaths();
          return {
            diff: paths.length ? git("diff", "HEAD", "--", ...paths) : "",
            newFiles: paths
              .filter((path) => !originalPaths.has(path) && expected.get(path) !== null)
              .map((path) => ({ path, content: expected.get(path) })),
          };
        },
      ),
      tool(
        "commit_profile",
        "Verify and commit your current profile edits locally using existing Git identity and hooks. Supply the description after docs(profile):. No push; unrelated changes are preserved.",
        z.object({ summary: z.string().trim().min(1) }),
        ({ summary }) => {
          verify();
          profile.commit(summary);
          for (const path of expected.keys()) profile.checkWritable(path);
          return { commit: git("rev-parse", "HEAD") };
        },
      ),
    ];
    try {
      for (const [name, artifact] of Object.entries(suppliedArtifacts))
        writeFileSync(artifactPaths[name], artifact.content);
      const summary = await agent({ profileRoot: root, artifactPaths }, tools);
      verify();
      if (profile.pendingPaths().length)
        throw new ProfileCommitError(
          "Profile editing left uncommitted changes. Review and commit the saved files before retrying.",
        );
      return {
        summary,
        artifacts: Object.fromEntries(
          Object.entries(artifactPaths).map(([name, file]) => [name, readFileSync(file, "utf8")]),
        ),
      };
    } finally {
      rmSync(artifacts, { recursive: true, force: true });
    }
  });
}
