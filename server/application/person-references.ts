import type { PeopleContext } from "../../shared/people.js";
import type { EntityReference, ProfileDocument } from "../../shared/schema.js";
import type { ReferenceCandidate } from "./aliases.js";
import { profilePeople } from "./profile-people.js";

const normalize = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const words = (value: string) => [
  ...value.matchAll(/[\p{L}\p{M}\p{N}_]+(?:[@.+/'’-][\p{L}\p{M}\p{N}_]+)*/gu),
];

export function personMentions(text: string, name: string) {
  const tokens = words(text);
  const count = words(name).length;
  if (!count) return [];
  return tokens.flatMap((token, index) => {
    const last = tokens[index + count - 1];
    if (!last) return [];
    const start = token.index;
    const end = last.index + last[0].length;
    const mention = text.slice(start, end);
    return normalize(mention) === normalize(name) ? [{ start, end, mention }] : [];
  });
}

export function personCandidates(
  text: string,
  people: PeopleContext | null,
  aliases: ReferenceCandidate[],
  retained: EntityReference[],
  documents: ProfileDocument[],
): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  const identities = [
    ...(people?.candidates ?? []).map((person) => ({
      ...person,
      name: `${person.prename} ${person.lastname}`,
      target: person.email,
      source: "people",
      complete: !!people && !people.searchTruncated,
    })),
    ...profilePeople(documents).map((contact) => ({
      ...contact,
      prename: contact.name.split(/\s+/u)[0],
      lastname: contact.name.split(/\s+/u).at(-1) ?? "",
      complete: !people?.searchTruncated,
    })),
  ];
  for (const person of identities) {
    const names = [
      [person.email ?? "", "email"],
      [person.name, words(person.name).length > 1 ? "full-name" : "given-name"],
      [person.prename, "given-name"],
      [person.lastname, "surname"],
    ] as const;
    for (const [name, match] of names) {
      for (const occurrence of personMentions(text, name)) {
        const overlaps = (reference: EntityReference) =>
          occurrence.start < reference.end && occurrence.end > reference.start;
        if (
          retained.some(overlaps) ||
          aliases.some((alias) => alias.match === "exact" && overlaps(alias))
        )
          continue;
        if (
          candidates.some(
            (candidate) =>
              candidate.target === person.target &&
              candidate.start <= occurrence.start &&
              candidate.end >= occurrence.end,
          )
        )
          continue;
        candidates.push({
          ...occurrence,
          id: "",
          kind: "person",
          target: person.target,
          label: person.email ? `${person.name} (${person.email})` : person.name,
          source: person.source,
          match,
          available: match === "email" || (match === "full-name" && person.complete),
        });
      }
    }
  }
  const strongest = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other.start <= candidate.start &&
          other.end >= candidate.end &&
          other.end - other.start > candidate.end - candidate.start,
      ),
  );
  return strongest
    .sort((a, b) => a.start - b.start)
    .map((candidate, index) => ({
      ...candidate,
      id: `person:${index}`,
      available:
        candidate.available &&
        !strongest.some(
          (other) =>
            other.start === candidate.start &&
            other.end === candidate.end &&
            other.target !== candidate.target,
        ),
    }));
}
