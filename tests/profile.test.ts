import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Profile, parseDocument } from "../server/profile.js";

describe("portable profile", () => {
  it("reconciles all project links while preserving index metadata and personal prose", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-project-index-"));
    const profile = new Profile(root);
    const indexPath = join(root, "index.md");
    const prefix = "---\ntype: Collection\ncustom: kept\n---\n\nMy project notes.\n\n";
    const suffix = "\n\n## Priorities\nKeep these notes.\n";
    writeFileSync(
      indexPath,
      `${prefix}<!-- aliases:start -->\nNo aliases\n<!-- aliases:end -->\n<!-- projects:start -->\nStale list\n<!-- projects:end -->${suffix}`,
    );
    mkdirSync(join(root, "nested"));
    const nested = join(root, "nested", "project #1 (old).md");
    writeFileSync(nested, '---\ntype: Project\ntitle: "Alpha [one]"\navailability: missing\n---\n');
    const manual = profile.create("Zebra", "Project", "Manual project");
    profile.create("Other concept", "Team", "");
    profile.reconcileIndex();
    const index = readFileSync(indexPath, "utf8");
    expect(index.startsWith(prefix)).toBe(true);
    expect(index.endsWith(suffix)).toBe(true);
    expect(index).toContain(
      "- [Alpha \\[one\\]](nested/project%20%231%20%28old%29.md) — unavailable",
    );
    expect(index).toContain(`- [Zebra](${manual.path})`);
    expect(index).not.toContain("Other concept");
    expect(index).not.toContain("Stale list");
    expect(index.indexOf("Alpha")).toBeLessThan(index.indexOf("Zebra"));
    const inode = statSync(indexPath).ino;
    profile.reconcileIndex();
    expect(statSync(indexPath).ino).toBe(inode);
    renameSync(nested, join(root, "renamed.md"));
    renameSync(join(root, manual.path), join(root, "removed.txt"));
    profile.reconcileIndex();
    const updated = readFileSync(indexPath, "utf8");
    expect(updated).toContain("(renamed.md)");
    expect(updated).not.toContain("nested/");
    expect(updated).not.toContain("Zebra");
  });

  it("appends a managed list to an existing index without changing its content", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-project-index-"));
    const original = "---\ntype: Projects\n---\nMy notes";
    writeFileSync(join(root, "index.md"), original);
    const profile = new Profile(root);
    profile.reconcileIndex();
    expect(readFileSync(join(root, "index.md"), "utf8")).toBe(
      `${original}\n\n<!-- projects:start -->\n## Projects\n\nNo projects recorded.\n<!-- projects:end -->\n\n<!-- aliases:start -->\n## Aliases\n\nNo aliases recorded.\n<!-- aliases:end -->\n`,
    );
    expect(existsSync(join(root, "projects.md"))).toBe(false);
  });

  it("retires the old generated project list without losing notes or incoming links", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-index-migration-"));
    const profile = new Profile(root);
    profile.initialize();
    const project = profile.create("Example", "Project", "");
    const prefix = "---\ntype: Project index\ntitle: Projects\ncustom: kept\n---\n\n# Projects\n\n";
    const suffix = "\n\n## Priorities\nKeep these notes.\n";
    writeFileSync(
      join(root, "projects.md"),
      `${prefix}<!-- projects:start -->\nStale links\n<!-- projects:end -->${suffix}`,
    );
    const indexPath = join(root, "index.md");
    writeFileSync(
      indexPath,
      `${readFileSync(indexPath, "utf8")}\n[My project notes](projects.md)\n`,
    );
    profile.reconcileIndex();
    expect(readFileSync(join(root, "projects.md"), "utf8")).toBe(
      `${prefix}<!-- projects:start -->\nSee [Projects](index.md#projects).\n<!-- projects:end -->${suffix}`,
    );
    expect(readFileSync(indexPath, "utf8")).toContain(`[Example](${project.path})`);
    expect(readFileSync(indexPath, "utf8")).toContain("[My project notes](projects.md)");
    const inode = statSync(join(root, "projects.md")).ino;
    profile.reconcileIndex();
    expect(statSync(join(root, "projects.md")).ino).toBe(inode);
  });

  it("indexes alias registries by type and refreshes renamed, removed, and retyped documents", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-alias-index-"));
    const profile = new Profile(root);
    profile.initialize();
    mkdirSync(join(root, "nested"));
    const content =
      '---\ntype: Aliases\ntitle: "Team [names]"\n---\n| Alias | Kind | Target |\n| --- | --- | --- |\n| Tobi | person | tobi@example.com |\n';
    writeFileSync(join(root, "nested", "names #1.md"), content);
    const other = profile.create(
      "Other names",
      "Aliases",
      "| Alias | Kind | Target |\n| --- | --- | --- |",
    );
    profile.reconcileIndex();
    const indexPath = join(root, "index.md");
    const index = readFileSync(indexPath, "utf8");
    expect(index).toContain("[Team \\[names\\]](nested/names%20%231.md)");
    expect(index).toContain(`[Other names](${other.path})`);
    expect(index.indexOf("Other names")).toBeLessThan(index.indexOf("Team"));
    renameSync(join(root, "nested", "names #1.md"), join(root, "renamed.md"));
    writeFileSync(join(root, other.path), other.content.replace("type: Aliases", "type: Notes"));
    profile.reconcileIndex();
    expect(readFileSync(indexPath, "utf8")).toContain("(renamed.md)");
    expect(readFileSync(indexPath, "utf8")).not.toContain("Other names");
    renameSync(join(root, "renamed.md"), join(root, "removed.txt"));
    profile.reconcileIndex();
    expect(readFileSync(indexPath, "utf8")).toContain("No aliases recorded.");
  });

  it.each(["index.md", "projects.md"])(
    "refuses malformed alias or legacy sections in %s before writing",
    (path) => {
      const root = mkdtempSync(join(tmpdir(), "pa-index-markers-"));
      const profile = new Profile(root);
      profile.initialize();
      const content =
        path === "index.md"
          ? "# Context\n<!-- aliases:start -->\n<!-- aliases:start -->\n<!-- aliases:end -->\n"
          : "---\ntype: Project index\n---\n<!-- projects:end -->\n";
      writeFileSync(join(root, path), content);
      const original = readFileSync(join(root, "index.md"), "utf8");
      expect(() => profile.reconcileIndex()).toThrow("managed-list markers");
      expect(readFileSync(join(root, path), "utf8")).toBe(content);
      expect(readFileSync(join(root, "index.md"), "utf8")).toBe(original);
    },
  );

  it("refuses malformed markers and a symlinked index without overwriting either", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-project-index-"));
    const profile = new Profile(root);
    const index = join(root, "index.md");
    const content = "---\ntype: Collection\n---\n<!-- projects:start -->\nMy notes";
    writeFileSync(index, content);
    expect(() => profile.reconcileIndex()).toThrow("managed-list markers");
    expect(readFileSync(index, "utf8")).toBe(content);
    renameSync(index, join(root, "original.txt"));
    symlinkSync(join(root, "original.txt"), index);
    expect(() => profile.reconcileIndex()).toThrow("reconciliation failed");
    expect(readFileSync(index, "utf8")).toBe(content);
  });

  it("detects changed project documents and concurrent index edits", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-project-index-"));
    const profile = new Profile(root);
    const project = profile.create("Example", "Project", "");
    profile.reconcileIndex();
    const index = join(root, "index.md");
    const before = readFileSync(index, "utf8");
    profile.create("Added", "Project", "");
    const documents = profile.documents.bind(profile);
    const reads = vi.spyOn(profile, "documents");
    reads.mockImplementationOnce(documents).mockImplementationOnce(() => {
      renameSync(join(root, project.path), join(root, "moved.md"));
      return documents();
    });
    expect(() => profile.reconcileIndex()).toThrow("documents changed");
    expect(readFileSync(index, "utf8")).toBe(before);
    reads.mockRestore();
    const save = profile.save.bind(profile);
    vi.spyOn(profile, "save").mockImplementationOnce((path, content, hash) => {
      writeFileSync(index, `${before}\nConcurrent notes.\n`);
      return save(path, content, hash);
    });
    expect(() => profile.reconcileIndex()).toThrow("changed outside");
    expect(readFileSync(index, "utf8")).toContain("Concurrent notes.");
  });

  it("discovers nested external concepts and bounds retrieved context", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-dynamic-"));
    mkdirSync(join(root, "teams"));
    const profile = new Profile(root);
    expect(profile.documents()).toEqual([]);
    writeFileSync(
      join(root, "teams", "research.md"),
      "---\ntype: Research area\ntitle: Aurora\n---\nAurora experiments",
    );
    expect(profile.context("Aurora").documents[0].path).toBe("teams/research.md");
    writeFileSync(
      join(root, "teams", "research.md"),
      "---\ntype: Research area\ntitle: Aurora\n---\nUpdated evidence",
    );
    expect(profile.documents()[0].content).toContain("Updated evidence");
    for (let i = 0; i < 10; i++)
      profile.create(`Person ${i}`, "Profile", "Long context ".repeat(2000));
    expect(profile.context("Aurora").documents.length).toBeLessThanOrEqual(6);
    expect(profile.context("Aurora").documents.every((doc) => doc.content.length <= 8000)).toBe(
      true,
    );
  });
  it("recognizes a Git repository through a filesystem alias", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-git-"));
    execFileSync("git", ["init", root], { stdio: "ignore" });
    const aliases = mkdtempSync(join(tmpdir(), "pa-alias-"));
    symlinkSync(root, join(aliases, "profile"));
    expect(new Profile(join(aliases, "profile")).isGit()).toBe(true);
  });
  it("accepts custom OKF types and preserves unknown metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-profile-"));
    const content = "---\ntype: Custom context\ncustom: kept\n---\nOld body";
    writeFileSync(join(root, "context.md"), content);
    const profile = new Profile(root);
    const doc = profile.documents()[0];
    profile.save(doc.path, content.replace("Old body", "New body"), doc.hash);
    expect(readFileSync(join(root, "context.md"), "utf8")).toContain("custom: kept");
    expect(() => profile.save(doc.path, content, doc.hash)).toThrow("changed outside");
  });

  it("does not follow symlinks or accept arbitrary paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-profile-"));
    const outside = mkdtempSync(join(tmpdir(), "pa-outside-"));
    writeFileSync(join(outside, "secret.md"), "---\ntype: Private\n---\nsecret");
    symlinkSync(outside, join(root, "escape"));
    const profile = new Profile(root);
    expect(profile.documents()).toEqual([]);
    expect(() => profile.save("../secret.md", "bad", "hash")).toThrow("not found");
  });

  it("requires a type on concepts but not index documents", () => {
    expect(() => parseDocument("plain text", "idea.md")).toThrow("type");
    expect(parseDocument("# My index", "index.md").type).toBe("Index");
  });
});
