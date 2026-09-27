import { afterAll, afterEach, expect, it } from "vitest";
import { resolveReferences } from "../server/application/aliases.js";
import { createContext } from "../server/application/context.js";
import { parseDocument } from "../server/profile.js";
import { Store } from "../server/store.js";
import type { Person } from "../shared/people.js";
import type { EntityReference, ProfileDocument } from "../shared/schema.js";

const store = new Store(":memory:");
afterAll(() => store.db.close());
afterEach(() => store.replacePeople("/profile", "tenant", [], "2026-09-21"));
const person = (prename: string, lastname: string, email: string): Person => ({
  prename,
  lastname,
  email,
  role: "Member",
  company: "Example",
  division: "Product",
  subdivision: "Tech",
  unit: "",
  team: "Tools",
});
const first = person("Michael", "First", "first@example.com");
const second = person("Michael", "Second", "second@example.com");
function context(
  text: string,
  documents: ProfileDocument[] = [],
  references: EntityReference[] = [],
) {
  return createContext({
    store,
    getProfile: () => ({ root: "/profile", documents: () => documents }),
    directory: () => ({ tenantId: "tenant", myEmail: "self@example.com" }),
    today: () => "2026-09-21",
  })(text, [], references);
}

it("keeps ambiguous given names unresolved and never treats proximity as identity", () => {
  store.replacePeople("/profile", "tenant", [first, { ...second, team: "Other" }], "2026-09-21");
  const candidates = context("Ask Michael").candidates;
  expect(candidates).toHaveLength(2);
  expect(candidates.every((candidate) => !candidate.available)).toBe(true);
  expect(() => resolveReferences([candidates[0].id], candidates, [])).toThrow("Invalid reference");
  store.replacePeople("/profile", "tenant", [first], "2026-09-21");
  expect(context("Ask Michael").candidates[0].available).toBe(false);
});

it("resolves full names and emails into durable references with original offsets", () => {
  store.replacePeople("/profile", "tenant", [first, second], "2026-09-21");
  const text = "Ask Michael First and SECOND@example.com.";
  const candidates = context(text).candidates;
  expect(candidates.map(({ target, available }) => [target, available])).toEqual([
    [first.email, true],
    [second.email, true],
  ]);
  const references = resolveReferences(
    candidates.map((candidate) => candidate.id),
    candidates,
    [],
  );
  expect(references.map((reference) => text.slice(reference.start, reference.end))).toEqual([
    "Michael First",
    "SECOND@example.com",
  ]);
  expect(context(text, [], references).candidates).toEqual([]);
});

it("preserves exact aliases over directory matches, including missing targets", () => {
  store.replacePeople("/profile", "tenant", [first, second], "2026-09-21");
  const aliases = parseDocument(
    "---\ntype: Aliases\n---\n| Alias | Kind | Target |\n| --- | --- | --- |\n| Michael | person | second@example.com |",
    "aliases.md",
  );
  expect(context("Ask Michael", [aliases]).candidates).toMatchObject([
    { alias: "Michael", target: second.email, available: true },
  ]);
  const missing = {
    ...aliases,
    content: aliases.content.replace(second.email, "missing@example.com"),
  };
  expect(context("Ask Michael", [missing]).candidates).toMatchObject([
    { target: "missing@example.com", available: false },
  ]);
});

it("binds case variants of an explicit alias without making other given names unambiguous", () => {
  const marcus = person("Marcus", "Chosen", "chosen@example.com");
  const other = person("Marcus", "Other", "other@example.com");
  store.replacePeople("/profile", "tenant", [marcus, other], "2026-09-21");
  const aliases = parseDocument(
    "---\ntype: Aliases\n---\n| Alias | Kind | Target |\n| --- | --- | --- |\n| Marcus | person | chosen@example.com |",
    "aliases.md",
  );
  for (const mention of ["Marcus", "MARCUS", "marcus"]) {
    const candidates = context(`Ask ${mention}`, [aliases]).candidates;
    expect(candidates).toMatchObject([
      { mention, alias: "Marcus", match: "exact", target: marcus.email, available: true },
    ]);
    expect(resolveReferences([candidates[0].id], candidates, [])[0].target).toBe(marcus.email);
    const withoutAlias = context(`Ask ${mention}`).candidates;
    expect(withoutAlias).toHaveLength(2);
    expect(withoutAlias.every((candidate) => !candidate.available)).toBe(true);
  }
});

it("does not resolve duplicate full names and respects truncated directory results", () => {
  const people = Array.from({ length: 12 }, (_, index) => ({
    ...first,
    email: `person${index}@example.com`,
  }));
  store.replacePeople("/profile", "tenant", people, "2026-09-21");
  const result = context("Ask Michael First");
  expect(result.people?.totalMatches).toBe(12);
  expect(result.candidates).toHaveLength(10);
  expect(result.candidates.every((candidate) => !candidate.available)).toBe(true);
  expect(context("Ask person11@example.com").candidates).toMatchObject([
    { target: "person11@example.com", available: true },
  ]);
});

it("handles Unicode and punctuated names without matching substrings or embedded email names", () => {
  const anna = person("Anna", "Müller", "anna@example.com");
  const other = person("O'Neil", "A+B", "oneil@example.com");
  store.replacePeople("/profile", "tenant", [anna, other], "2026-09-21");
  const text = "Ask ＡＮＮＡ Mu\u0308ller and O'Neil A+B, notanna@example.com and Annapolis.";
  const result = context(text);
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates.map((candidate) => text.slice(candidate.start, candidate.end))).toEqual([
    "ＡＮＮＡ Mu\u0308ller",
    "O'Neil A+B",
  ]);
});

it("resolves profile-only contacts and their aliases without a directory connection", () => {
  const contact = parseDocument(
    "---\ntype: Person\ntitle: Morgan Smith\n---\nMy mentor.",
    "people/morgan.md",
  );
  const aliases = parseDocument(
    "---\ntype: Aliases\n---\n| Alias | Kind | Target |\n| --- | --- | --- |\n| Mo | person | people/morgan.md |",
    "aliases.md",
  );
  const build = createContext({
    store,
    getProfile: () => ({ root: "/profile", documents: () => [contact, aliases] }),
    directory: () => undefined,
    today: () => "2026-09-21",
  });
  for (const text of ["Ask Morgan Smith", "Ask Mo"]) {
    const result = build(text);
    expect(result.people).toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ target: contact.path, available: true });
    expect(result.profile.documents).toContainEqual({
      path: contact.path,
      content: contact.content,
    });
    const references = resolveReferences([result.candidates[0].id], result.candidates, []);
    expect(build(text, [], references).candidates).toEqual([]);
    expect(build(text, [], references).profile.documents).toContainEqual({
      path: contact.path,
      content: contact.content,
    });
  }
  expect(build("Ask Morgan").candidates[0].available).toBe(false);
});

it("joins profile contacts to directory identities by explicit email and refreshes relationship context", () => {
  store.replacePeople(
    "/profile",
    "tenant",
    [
      first,
      { ...first, prename: "Sam", lastname: "Self", email: "self@example.com", role: "Team Lead" },
    ],
    "2026-09-21",
  );
  const contact = parseDocument(
    "---\ntype: Person\ntitle: Mike First\nemail: FIRST@example.com\n---\nMy trusted collaborator.",
    "people/mike.md",
  );
  const result = context("Ask Mike First", [contact]);
  expect(result.candidates).toMatchObject([
    { target: first.email, source: contact.path, available: true },
  ]);
  expect(result.people?.candidates).toContainEqual(first);
  expect(result.people?.relationships).toMatchObject([
    { email: first.email, userLeadsAt: ["team"] },
  ]);
  const byEmail = context("Ask first@example.com", [contact]);
  expect(byEmail.candidates).toHaveLength(1);
  expect(byEmail.profile.documents).toContainEqual({
    path: contact.path,
    content: contact.content,
  });
});

it("pins personal context by resolved identity beyond ordinary search results and preserves conflicting evidence", () => {
  store.replacePeople("/profile", "tenant", [first], "2026-09-21");
  const aliases = parseDocument(
    "---\ntype: Aliases\n---\n| Alias | Kind | Target |\n| --- | --- | --- |\n| Mike | person | first@example.com |",
    "aliases.md",
  );
  const distractors = Array.from({ length: 8 }, (_, index) =>
    parseDocument("---\ntype: Project\n---\nDiscuss rollout Mike", `project${index}.md`),
  );
  const notes = parseDocument(
    "---\ntype: Relationships\n---\nMichael First is my mentor. He now works in Other, not Tools.",
    "relationships.md",
  );
  const result = context("Discuss rollout with Mike", [aliases, ...distractors, notes]);
  expect(result.profile.documents).toContainEqual({ path: notes.path, content: notes.content });
  expect(result.people?.candidates[0].team).toBe("Tools");
});

it("does not merge a profile contact and directory person solely because their names match", () => {
  store.replacePeople("/profile", "tenant", [first], "2026-09-21");
  const contact = parseDocument(
    "---\ntype: Person\ntitle: Michael First\n---\nExternal collaborator.",
    "external.md",
  );
  const result = context("Ask Michael First", [contact]);
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates.every((candidate) => !candidate.available)).toBe(true);
});

it("preserves search truncation when explicit profile identities add directory rows", () => {
  const repeated = Array.from({ length: 12 }, (_, index) => ({
    ...first,
    email: `person${index}@example.com`,
  }));
  store.replacePeople(
    "/profile",
    "tenant",
    [
      ...repeated,
      person("Zoe", "External", "zoe@example.com"),
      person("Alex", "External", "alex@example.com"),
    ],
    "2026-09-21",
  );
  const documents = [
    parseDocument(
      "---\ntype: Person\ntitle: Morgan Profile\nemail: zoe@example.com\n---\n",
      "zoe.md",
    ),
    parseDocument(
      "---\ntype: Person\ntitle: Taylor Profile\nemail: alex@example.com\n---\n",
      "alex.md",
    ),
  ];
  const result = context("Michael and Morgan Profile and Taylor Profile", documents);
  expect(result.people?.candidates).toHaveLength(12);
  expect(result.people?.totalMatches).toBe(12);
  expect(result.people?.searchTruncated).toBe(true);
});
