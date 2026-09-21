import type { EntityReference, ProfileDocument } from "../../shared/schema.js";
import { aliasCandidates } from "./aliases.js";
import { peopleRelationships } from "./people-relationships.js";
import { personCandidates, personMentions } from "./person-references.js";
import type { ContextQueries } from "./ports.js";
import { profileContext } from "./profile-context.js";
import { profilePeople } from "./profile-people.js";
export function createContext({
  store,
  getProfile,
  directory,
  today,
}: {
  store: ContextQueries;
  getProfile: () => { root: string; documents(): ProfileDocument[] };
  directory: () => { myEmail: string; tenantId: string } | undefined;
  today: () => string;
}) {
  return (query: string, history: string[] = [], references: EntityReference[] = []) => {
    const entra = directory();
    const profile = getProfile();
    const documents = profile.documents();
    const aliases = aliasCandidates(
      query,
      documents,
      store,
      profile.root,
      entra ?? null,
      references,
    );
    const targets = [...aliases.filter((alias) => alias.available), ...references];
    const expanded = `${query} ${targets.map((target) => `${target.target} ${target.label}`).join(" ")}`;
    let people = entra
      ? store.peopleContext(profile.root, expanded, entra.myEmail, entra.tenantId)
      : null;
    if (entra && people && !people.totalMatches) {
      for (const previous of history.toReversed()) {
        const matches = store.peopleContext(profile.root, previous, entra.myEmail, entra.tenantId);
        if (matches?.totalMatches) {
          people = matches;
          break;
        }
      }
    }
    const candidates = [
      ...aliases,
      ...personCandidates(query, people, aliases, references, documents),
    ];
    const personTargets = [...candidates, ...references].filter(
      (target) => target.kind === "person",
    );
    if (entra && people) {
      for (const target of personTargets) {
        if (people.candidates.some((person) => person.email === target.target)) continue;
        const person = store.person(profile.root, entra.tenantId, target.target);
        if (person) people.candidates.push(person);
      }
      people.relationships = peopleRelationships(people.self, people.candidates);
    }
    const contacts = profilePeople(documents).filter((contact) =>
      personTargets.some(
        (target) => target.target === contact.target || target.target === contact.source,
      ),
    );
    const personNames = [
      ...(people?.candidates ?? []).flatMap((person) => [
        person.email,
        `${person.prename} ${person.lastname}`,
      ]),
      ...contacts.flatMap((contact) => [contact.name, ...(contact.email ? [contact.email] : [])]),
    ];
    const personDocuments = documents.filter(
      (document) =>
        contacts.some((contact) => contact.source === document.path) ||
        (!["Aliases", "Index", "Project", "Repository"].includes(document.type) &&
          personNames.some((name) => personMentions(document.content, name).length > 0)),
    );
    const search = `${expanded} ${personTargets.map((target) => `${target.target} ${target.label}`).join(" ")}`;
    return {
      today: today(),
      candidates,
      references,
      profile: profileContext(documents, search, [
        ...targets.filter((target) => target.kind !== "person").map((target) => target.target),
        ...personDocuments.map((document) => document.path),
      ]),
      related: store.search(search),
      commitments: store.today(today()),
      people,
    };
  };
}
