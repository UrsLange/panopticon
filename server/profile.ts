import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse, stringify } from "yaml";
import type { ProfileDocument } from "../shared/schema.js";
import { readAliases } from "./application/aliases.js";
import { ProfileCommitError } from "./application/errors.js";
import { profileContext } from "./application/profile-context.js";
import { parseConcept } from "./application/profile-document.js";
import { renderPrompt } from "./prompts.js";

function processStart(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer | string };
    if (failure.status === 1 && !failure.stdout?.toString().trim()) return null;
    throw error;
  }
}

function acquireProfileLock(lock: string) {
  const candidate = mkdtempSync(`${lock}.`);
  const owner = `owner-${randomUUID()}.json`;
  try {
    writeFileSync(
      join(candidate, owner),
      JSON.stringify({ pid: process.pid, startedAt: processStart(process.pid) }),
      { flag: "wx", mode: 0o600 },
    );
    while (true) {
      try {
        // Publishing a populated directory avoids a crash between claiming the lock and recording its owner.
        renameSync(candidate, lock);
        return () => {
          unlinkSync(join(lock, owner));
          try {
            rmdirSync(lock);
          } catch (error) {
            if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
              throw error;
          }
        };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      try {
        const owners = readdirSync(lock);
        if (!owners.length) continue;
        if (owners.length !== 1 || !/^owner-[\da-f-]+\.json$/.test(owners[0]))
          throw new ProfileCommitError(`Profile lock cannot be identified. Inspect ${lock}.`);
        const previous = JSON.parse(readFileSync(join(lock, owners[0]), "utf8"));
        if (
          !Number.isInteger(previous.pid) ||
          previous.pid <= 0 ||
          typeof previous.startedAt !== "string" ||
          !previous.startedAt
        )
          throw new ProfileCommitError(`Profile lock cannot be identified. Inspect ${lock}.`);
        if (processStart(previous.pid) === previous.startedAt)
          throw new ProfileCommitError(
            "Profile is being updated. Wait for it to finish, then retry.",
          );
        // The unique filename prevents competing recovery attempts from removing a new owner's lock.
        unlinkSync(join(lock, owners[0]));
        rmdirSync(lock);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
    }
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}

function managedSection(original: string, path: string, name: string, body: string) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const a = original.indexOf(start);
  const b = original.indexOf(end);
  if (
    a < 0 !== b < 0 ||
    (a >= 0 &&
      (b < a ||
        original.indexOf(start, a + start.length) >= 0 ||
        original.indexOf(end, b + end.length) >= 0))
  )
    throw new Error(`Restore the ${path} managed-list markers before retrying.`);
  const block = `${start}\n${body}\n${end}`;
  return a < 0
    ? `${original}${original.endsWith("\n") ? "\n" : "\n\n"}${block}\n`
    : `${original.slice(0, a)}${block}${original.slice(b + end.length)}`;
}

function markdownText(value: string) {
  return value.replace(/\s+/g, " ").replace(/[\\`*_{}[\]<>!]/g, "\\$&");
}

function documentLink(doc: ProfileDocument, from = "index.md") {
  const label = markdownText(doc.title);
  const target = relative(dirname(from), doc.path)
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/[()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[${label}](${target})`;
}

export function parseDocument(content: string, path: string): ProfileDocument {
  return {
    ...parseConcept(content, path),
    hash: createHash("sha256").update(content).digest("hex"),
  };
}

export class Profile {
  private writes: Map<string, string | null> | null = null;
  constructor(readonly root: string) {}

  change<T>(summary: string, action: () => T): T {
    return this.session(action, () => this.commit(summary));
  }

  runAgent<T>(action: () => T): T {
    return this.session(action, () => {});
  }

  private session<T>(action: () => T, finish: () => void): T {
    if (this.writes)
      throw new ProfileCommitError("Profile is being updated. Wait for it to finish, then retry.");
    const lock = this.git([
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "pa-profile.lock",
    ]).trim();
    const unlock = acquireProfileLock(lock);
    const writes = new Map<string, string | null>();
    this.writes = writes;
    const release = () => {
      this.writes = null;
      unlock();
    };
    try {
      const result = action();
      if (result instanceof Promise)
        return result
          .then((value) => {
            finish();
            return value;
          })
          .finally(release) as T;
      finish();
      release();
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  pendingPaths() {
    return [...(this.writes ?? [])]
      .filter(([path, before]) => {
        const file = join(this.root, path);
        return (existsSync(file) ? readFileSync(file, "utf8") : null) !== before;
      })
      .map(([path]) => path);
  }

  resumeWrites(entries: [string, string | null][]) {
    for (const [path, before] of entries) this.writes?.set(path, before);
  }

  commit(summary: string, body = "") {
    const paths = this.pendingPaths();
    if (!paths.length) return;
    try {
      this.git(["add", "--all", "--", ...paths]);
      const description = summary.replace(/^(?:docs\(profile\):\s*)+/i, "").trim();
      const firstLine = description.split(/\r?\n/)[0];
      const subject =
        firstLine.length > 57
          ? firstLine
              .slice(0, 57)
              .replace(/\s+\S*$/, "")
              .trimEnd()
          : firstLine;
      const detail = [
        description !== subject ? description : "",
        body.trim(),
        `Updated profile documents:\n${paths.map((path) => `- ${path}`).join("\n")}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      this.git([
        "commit",
        "--only",
        "-m",
        `docs(profile): ${subject || "update knowledge"}`,
        "-m",
        detail,
        "--",
        ...paths,
      ]);
      this.writes?.clear();
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
      throw new ProfileCommitError(
        `Profile saved, but not committed. ${stderr || "Check Git identity, hooks, and repository access."}`,
      );
    }
  }

  checkWritable(path: string) {
    if (!this.writes || this.writes.has(path)) return;
    if (this.git(["status", "--porcelain", "--untracked-files=all", "--", path]).trim())
      throw new ProfileCommitError(
        `Profile has uncommitted changes in ${path}. Commit or move those edits before retrying.`,
      );
  }

  prepareWrite(path: string) {
    if (!this.writes || this.writes.has(path)) return;
    this.checkWritable(path);
    const file = join(this.root, path);
    this.writes.set(path, existsSync(file) ? readFileSync(file, "utf8") : null);
  }

  private git(args: string[]) {
    return execFileSync("git", ["--literal-pathspecs", "-C", this.root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  initialize(populate: () => void = () => {}) {
    if (existsSync(this.root) && readdirSync(this.root).length > 0)
      throw new Error(
        "Choose an empty directory for a new profile, or connect the existing repository.",
      );
    mkdirSync(this.root, { recursive: true });
    execFileSync("git", ["init", "-b", "main", this.root], { stdio: "ignore" });
    this.change("initialize personal context", () => {
      this.prepareWrite("index.md");
      writeFileSync(
        join(this.root, "index.md"),
        '---\nokf_version: "0.2"\n---\n\n# Personal context\n\nThis repository contains personal context in Markdown. Add documents and folders as needed.\n',
        { flag: "wx" },
      );
      populate();
      this.reconcileIndex();
    });
  }

  enrichmentPrompt() {
    const documents = this.documents();
    return renderPrompt("profile-enrichment", {
      root: JSON.stringify(this.root),
      documents: JSON.stringify(
        documents.map(({ path, title, type }) => ({ path, title, type })),
        null,
        2,
      ),
    });
  }

  documents(): ProfileDocument[] {
    if (!existsSync(this.root)) return [];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
      }
    };
    walk(this.root);
    return files
      .sort()
      .map((path) => parseDocument(readFileSync(path, "utf8"), relative(this.root, path)))
      .filter(
        (doc) =>
          !(
            doc.path === "people.md" &&
            doc.content.includes("generated_by: personal-assistant-entra")
          ),
      );
  }

  isGit() {
    try {
      return (
        realpathSync(
          execFileSync("git", ["-C", this.root, "rev-parse", "--show-toplevel"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim(),
        ) === realpathSync(this.root)
      );
    } catch {
      return false;
    }
  }

  reconcileIndex() {
    try {
      const documents = this.documents();
      const index = documents.find((doc) => doc.path === "index.md");
      const projects = documents
        .filter((doc) => doc.type === "Project" && doc.path !== "projects.md")
        .sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
      const lines = projects.map((doc) => {
        const frontmatter = doc.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        const data = frontmatter ? parse(frontmatter[1]) : {};
        return `- ${documentLink(doc)}${data.availability === "missing" ? " — unavailable" : ""}`;
      });
      const original = index?.content ?? '---\nokf_version: "0.2"\n---\n\n# Personal context\n';
      const aliases = documents
        .filter((doc) => doc.type === "Aliases")
        .sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
      const content = managedSection(
        managedSection(
          original,
          "index.md",
          "projects",
          `## Projects\n\n${lines.length ? lines.join("\n") : "No projects recorded."}`,
        ),
        "index.md",
        "aliases",
        `## Aliases\n\n${aliases.length ? aliases.map((doc) => `- ${documentLink(doc)}`).join("\n") : "No aliases recorded."}`,
      );
      const legacy = documents.find(
        (doc) => doc.path === "projects.md" && /<!-- projects:(start|end) -->/.test(doc.content),
      );
      const updates = new Map<string, string>();
      if (legacy)
        updates.set(
          legacy.path,
          managedSection(
            legacy.content,
            legacy.path,
            "projects",
            "See [Projects](index.md#projects).",
          ),
        );
      for (const registry of aliases) {
        const targets = [
          ...new Set(
            readAliases(registry.content)
              .filter((entry) => entry.kind !== "person")
              .map((entry) => entry.target),
          ),
        ];
        const links = targets.map((target) => {
          const document = documents.find(
            (doc) => doc.path === target && ["Project", "Repository"].includes(doc.type),
          );
          return document
            ? `- ${documentLink(document, registry.path)}`
            : `- ${markdownText(target)} — unresolved target`;
        });
        updates.set(
          registry.path,
          managedSection(
            updates.get(registry.path) ?? registry.content,
            registry.path,
            "alias-targets",
            `## Referenced concepts\n\n${links.length ? links.join("\n") : "No project or repository references."}`,
          ),
        );
      }
      const changed = documents.flatMap((doc) => {
        const content = updates.get(doc.path);
        return content === undefined || content === doc.content ? [] : [{ doc, content }];
      });
      if (content === index?.content && !changed.length) return;
      const current = this.documents();
      if (content !== index?.content) this.prepareWrite("index.md");
      for (const { doc } of changed) this.prepareWrite(doc.path);
      if (
        current.length !== documents.length ||
        documents.some(
          (doc) => !current.some((next) => next.path === doc.path && next.hash === doc.hash),
        )
      )
        throw new Error("Profile documents changed during reconciliation. Retry the update.");
      if (index) {
        if (content !== index.content) this.save(index.path, content, index.hash);
      } else {
        const temporary = join(this.root, `.pa-${randomUUID()}.tmp`);
        writeFileSync(temporary, content, { flag: "wx" });
        try {
          linkSync(temporary, join(this.root, "index.md"));
        } finally {
          unlinkSync(temporary);
        }
      }
      for (const { doc, content } of changed) this.save(doc.path, content, doc.hash);
    } catch (error) {
      throw new Error(`Profile index reconciliation failed: ${(error as Error).message}`);
    }
  }

  save(path: string, content: string, hash: string) {
    const current = this.documents().find((doc) => doc.path === path);
    if (!current) throw new Error("Profile document not found");
    if (current.hash !== hash)
      throw new Error("This file changed outside the app. Reload before saving.");
    const next = parseDocument(content, path);
    if (content === current.content) return next;
    this.prepareWrite(path);
    const temporary = join(dirname(join(this.root, path)), `.pa-${randomUUID()}.tmp`);
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, join(this.root, path));
    return next;
  }

  create(title: string, type: string, body: string) {
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "concept";
    const path = `${slug}-${randomUUID().slice(0, 8)}.md`;
    const metadata =
      type === "Aliases"
        ? { type, title, description: "Explicit names for people, projects, and repositories." }
        : { type, title };
    const content = `---\n${stringify(metadata)}---\n\n${body}\n`;
    this.prepareWrite(path);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, path), content, { flag: "wx" });
    return parseDocument(content, path);
  }

  context(query: string, targets: string[] = []) {
    return profileContext(this.documents(), query, targets);
  }
}
