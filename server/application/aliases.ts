import { z } from "zod";
import type { EntityReference, ProfileDocument } from "../../shared/schema.js";
import type { PeopleLookup } from "./ports.js";
import { profilePeople } from "./profile-people.js";

const aliasSchema = z.object({
  alias: z.string().trim().min(1).max(100),
  kind: z.enum(["person", "project", "repository"]),
  target: z.string().trim().min(1).max(500),
});

export function readAliases(content: string) {
  const rows = content
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  z.array(z.array(z.string()).length(3)).min(2).parse(rows);
  z.tuple([z.literal("alias"), z.literal("kind"), z.literal("target")]).parse(
    rows[0].map((cell) => cell.toLowerCase()),
  );
  return rows.slice(2).map(([alias, kind, target]) => {
    return aliasSchema.parse({ alias, kind, target });
  });
}

const normalize = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

function similar(left: string, right: string) {
  if (left.length < 4 || right.length < 4 || Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const differences = [...left]
      .map((letter, index) => (letter === right[index] ? -1 : index))
      .filter((index) => index >= 0);
    if (differences.length === 1) return true;
    const [a, b] = differences;
    return differences.length === 2 && b === a + 1 && left[a] === right[b] && left[b] === right[a];
  }
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let index = 0;
  while (shorter[index] === longer[index] && index < shorter.length) index++;
  return shorter.slice(index) === longer.slice(index + 1);
}

export type ReferenceCandidate = EntityReference & {
  id: string;
  alias?: string;
  match: "exact" | "approximate" | "email" | "full-name" | "given-name" | "surname";
  available: boolean;
};

export function aliasCandidates(
  text: string,
  documents: ProfileDocument[],
  store: PeopleLookup,
  root: string,
  entra: { myEmail: string; tenantId: string } | null,
  retained: EntityReference[] = [],
) {
  const candidates: ReferenceCandidate[] = [];
  const contacts = profilePeople(documents);
  const words = [...text.matchAll(/[\p{L}\p{N}_]+(?:[@.+/-][\p{L}\p{N}_]+)*/gu)];
  for (const document of documents.filter((doc) => doc.type === "Aliases")) {
    for (const entry of readAliases(document.content)) {
      const alias = normalize(entry.alias);
      const count = alias.split(" ").length;
      const person =
        entry.kind === "person" && entra
          ? store.person(root, entra.tenantId, entry.target)
          : undefined;
      const contact =
        entry.kind === "person"
          ? contacts.find(
              (contact) =>
                contact.source === entry.target || contact.email === entry.target.toLowerCase(),
            )
          : undefined;
      const project =
        entry.kind !== "person"
          ? documents.find(
              (doc) => doc.path === entry.target && ["Project", "Repository"].includes(doc.type),
            )
          : undefined;
      for (let index = 0; index + count <= words.length; index++) {
        const start = words[index].index;
        const last = words[index + count - 1];
        const end = last.index + last[0].length;
        const mention = text.slice(start, end);
        const normalized = normalize(mention);
        const exact = normalized === alias;
        if (!exact && !similar(normalized, alias)) continue;
        if (retained.some((reference) => start < reference.end && end > reference.start)) continue;
        candidates.push({
          id: String(candidates.length),
          start,
          end,
          mention,
          alias: entry.alias,
          kind: entry.kind,
          target: person?.email ?? contact?.target ?? entry.target,
          label: person?.email ?? contact?.name ?? project?.title ?? entry.target,
          source: document.path,
          match: exact ? "exact" : "approximate",
          available: !!(person || contact || project),
        });
      }
    }
  }
  return candidates;
}

export function resolveReferences(
  ids: string[],
  candidates: ReferenceCandidate[],
  retained: EntityReference[],
) {
  const references = [...retained];
  for (const id of new Set(ids)) {
    const candidate = candidates.find((entry) => entry.id === id);
    if (!candidate?.available) throw new Error("Invalid reference selected by the model.");
    const { start, end, mention, kind, target, label, source } = candidate;
    if (references.some((reference) => start < reference.end && end > reference.start)) {
      throw new Error("Conflicting references selected by the model.");
    }
    references.push({ start, end, mention, kind, target, label, source });
  }
  return references.sort((a, b) => a.start - b.start);
}

export function retainReferences(before: string, after: string, references: EntityReference[]) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  return references.flatMap((reference) => {
    let offset =
      reference.end <= prefix
        ? 0
        : reference.start >= before.length - suffix
          ? after.length - before.length
          : null;
    if (offset === null) {
      const start = after.indexOf(reference.mention);
      if (
        start < 0 ||
        after.indexOf(reference.mention, start + 1) >= 0 ||
        before.indexOf(reference.mention) !== reference.start ||
        before.indexOf(reference.mention, reference.end) >= 0
      )
        return [];
      offset = start - reference.start;
    }
    const start = reference.start + offset;
    const end = reference.end + offset;
    if (/[\p{L}\p{N}_]/u.test(after[start - 1] ?? "") || /[\p{L}\p{N}_]/u.test(after[end] ?? ""))
      return [];
    return [{ ...reference, start, end }];
  });
}
