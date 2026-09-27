import { mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  aliasCandidates,
  readAliases,
  resolveReferences,
  retainReferences,
} from "../server/application/aliases.js";
import { Profile, parseDocument } from "../server/profile.js";
import { Store } from "../server/store.js";
import { annotatedText } from "../shared/schema.js";

const project = parseDocument(
  "---\ntype: Project\ntitle: GitHub Access Management\n---\nAccess controls",
  "projects/access.md",
);
let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => {
  store.db.close();
});
const registry = (rows: string) =>
  parseDocument(
    `---\ntype: Aliases\n---\n| Alias | Kind | Target |\n| --- | --- | --- |\n${rows}`,
    "aliases.md",
  );
const aliases = registry(
  "| gham | project | projects/access.md |\n| access work | repository | projects/access.md |",
);

it("matches normalized aliases and conservative typos without matching substrings", () => {
  const text = "GHAM, ghma, ghaam, ghamx and access   work. Nottingham and gh.";
  const candidates = aliasCandidates(text, [project, aliases], store, "", null);
  expect(candidates.map(({ mention, match }) => [mention, match])).toEqual([
    ["GHAM", "exact"],
    ["ghma", "approximate"],
    ["ghaam", "approximate"],
    ["ghamx", "approximate"],
    ["access   work", "exact"],
  ]);
  const references = resolveReferences(
    candidates.map((candidate) => candidate.id),
    candidates,
    [],
  );
  expect(annotatedText(text, references)).toContain(
    "GHAM [GitHub Access Management], ghma [GitHub Access Management]",
  );
});

it("resolves every casing of one alias to the same target while retaining the original mention", () => {
  const documents = [project, registry("| Marcus | project | projects/access.md |")];
  expect(readAliases(documents[1].content)).toHaveLength(1);
  for (const mention of ["Marcus", "MARCUS", "marcus"]) {
    const text = `Ask ${mention}`;
    const candidates = aliasCandidates(text, documents, store, "", null);
    expect(candidates).toMatchObject([
      {
        alias: "Marcus",
        mention,
        match: "exact",
        target: project.path,
        available: true,
      },
    ]);
    expect(resolveReferences([candidates[0].id], candidates, [])).toMatchObject([
      { mention, start: 4, end: text.length, target: project.path },
    ]);
  }
});

it("keeps explicit given-name aliases bound to their contact when another person joins", () => {
  const root = "/profile";
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const person = {
    prename: "Tobias",
    lastname: "First",
    email: "first@example.com",
    role: "",
    team: "",
    unit: "",
    subdivision: "",
    division: "",
    company: "",
  };
  const documents = [
    registry("| Tobias | person | first@example.com |\n| Tobi | person | first@example.com |"),
  ];
  const entra = { tenantId, myEmail: "me@example.com" };
  store.replacePeople(root, tenantId, [person], "2026-09-18");
  const before = aliasCandidates("Tobias and Tobii", documents, store, root, entra);
  store.replacePeople(
    root,
    tenantId,
    [person, { ...person, lastname: "Second", email: "second@example.com" }],
    "2026-09-19",
  );
  expect(aliasCandidates("Tobias and Tobii", documents, store, root, entra)).toEqual(before);
  expect(before.map((candidate) => candidate.target)).toEqual([person.email, person.email]);
});

it("lets the model select occurrences and rejects invented, missing or overlapping targets", () => {
  const documents = [
    project,
    registry("| May | project | projects/access.md |\n| lost | project | missing.md |"),
  ];
  const candidates = aliasCandidates("Ask May in May about lost", documents, store, "", null);
  const references = resolveReferences([candidates[0].id], candidates, []);
  expect(annotatedText("Ask May in May about lost", references)).toBe(
    "Ask May [GitHub Access Management] in May about lost",
  );
  expect(() => resolveReferences(["invented"], candidates, [])).toThrow("Invalid reference");
  expect(() => resolveReferences([candidates[2].id], candidates, [])).toThrow("Invalid reference");
  expect(() => resolveReferences([candidates[0].id], candidates, references)).toThrow(
    "Conflicting",
  );
});

it("retains untouched mentions while removing changed mentions and updating offsets", () => {
  const text = "Ask gham today";
  const candidates = aliasCandidates(text, [project, aliases], store, "", null);
  const references = resolveReferences([candidates[0].id], candidates, []);
  expect(retainReferences(text, "Please ask gham today", references)[0].start).toBe(11);
  expect(retainReferences(text, "Ask gham tomorrow", references)).toEqual(references);
  expect(retainReferences(text, "Ask other today", references)).toEqual([]);
  expect(retainReferences(text, "Ask ghamster today", references)).toEqual([]);
  expect(aliasCandidates(text, [project, aliases], store, "", null, references)).toEqual([]);
});

it("validates alias rows when saving profile documents", () => {
  expect(() => registry("| Tobi | person | | ")).toThrow();
  expect(() => registry("| Tobi | unknown | somebody |")).toThrow();
});

it("maintains nested concept links without changing alias mappings or handwritten content", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-alias-links-"));
  const profile = new Profile(root);
  profile.initialize();
  mkdirSync(join(root, "names"));
  mkdirSync(join(root, "projects"));
  const target = "projects/access #1 (main).md";
  writeFileSync(join(root, target), '---\ntype: Repository\ntitle: "Access [main]"\n---\n');
  const prefix = `---\ntype: Aliases\ntitle: Names\ncustom: kept\n---\n\nMy names.\n\n| Alias | Kind | Target |\n| --- | --- | --- |\n| gham | project | ${target} |\n| access | repository | ${target} |\n| Tobi | person | tobi@example.com |\n| lost | project | missing.md |\n\n`;
  const suffix = "\n\n## Notes\nKeep these notes.\n";
  const path = join(root, "names", "team.md");
  writeFileSync(
    path,
    `${prefix}<!-- alias-targets:start -->\nOld links\n<!-- alias-targets:end -->${suffix}`,
  );
  const entries = readAliases(readFileSync(path, "utf8"));
  profile.reconcileIndex();
  const content = readFileSync(path, "utf8");
  expect(content.startsWith(prefix)).toBe(true);
  expect(content.endsWith(suffix)).toBe(true);
  expect(content).toContain("[Access \\[main\\]](../projects/access%20%231%20%28main%29.md)");
  expect(content.match(/\.\.\/projects\//g)).toHaveLength(1);
  expect(content).toContain("missing.md — unresolved target");
  expect(content).not.toContain("Old links");
  expect(content).not.toContain("tobi@example.com)");
  expect(readAliases(content)).toEqual(entries);
  expect(aliasCandidates("gham", profile.documents(), store, root, null)[0]).toMatchObject({
    target,
    available: true,
    source: "names/team.md",
  });
  const inode = statSync(path).ino;
  profile.reconcileIndex();
  expect(statSync(path).ino).toBe(inode);
  renameSync(join(root, target), join(root, "renamed.md"));
  profile.reconcileIndex();
  expect(readFileSync(path, "utf8")).toContain(`${target} — unresolved target`);
  expect(readFileSync(path, "utf8")).not.toContain("(../projects/");
  expect(readAliases(readFileSync(path, "utf8"))).toEqual(entries);
  writeFileSync(join(root, "missing.md"), "---\ntype: Project\ntitle: Recovered\n---\n");
  profile.reconcileIndex();
  expect(readFileSync(path, "utf8")).toContain("[Recovered](../missing.md)");
  expect(readFileSync(path, "utf8")).not.toContain("missing.md — unresolved target");
});

it("rejects malformed target sections before changing navigation", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-alias-markers-"));
  const profile = new Profile(root);
  profile.initialize();
  const doc = profile.create(
    "Names",
    "Aliases",
    "| Alias | Kind | Target |\n| --- | --- | --- |\n\n<!-- alias-targets:start -->\n",
  );
  const before = readFileSync(join(root, "index.md"), "utf8");
  expect(() => profile.reconcileIndex()).toThrow("managed-list markers");
  expect(readFileSync(join(root, "index.md"), "utf8")).toBe(before);
  expect(readFileSync(join(root, doc.path), "utf8")).toBe(doc.content);
});

it("preserves concurrent alias edits and repairs generated links on retry", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-alias-race-"));
  const profile = new Profile(root);
  profile.initialize();
  const doc = profile.create("Names", "Aliases", "| Alias | Kind | Target |\n| --- | --- | --- |");
  const save = profile.save.bind(profile);
  const spy = vi.spyOn(profile, "save").mockImplementation((path, content, hash) => {
    if (path === doc.path) writeFileSync(join(root, path), `${doc.content}\nConcurrent notes.\n`);
    return save(path, content, hash);
  });
  expect(() => profile.reconcileIndex()).toThrow("changed outside");
  expect(readFileSync(join(root, doc.path), "utf8")).toContain("Concurrent notes.");
  spy.mockRestore();
  profile.reconcileIndex();
  expect(readFileSync(join(root, doc.path), "utf8")).toContain("Concurrent notes.");
  expect(readFileSync(join(root, doc.path), "utf8")).toContain(
    "No project or repository references.",
  );
});
