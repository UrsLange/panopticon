import type { OrganizationLevel, Person, PersonRelationship } from "../../shared/people.js";
import { organizationName } from "./organization.js";

const levels: OrganizationLevel[] = ["company", "division", "subdivision", "unit", "team"];

function leadership(person: Person): OrganizationLevel[] {
  const roles = new Set(person.role.split(",").map(organizationName));
  const titles = {
    division: "division lead",
    subdivision: "subdivision lead",
    unit: "unit lead",
    team: "team lead",
  };
  const led = (Object.keys(titles) as (keyof typeof titles)[]).filter(
    (level) => person[level] && roles.has(titles[level]),
  );
  if (
    roles.has("head of") &&
    person.subdivision &&
    !person.unit &&
    !person.team &&
    !led.includes("subdivision")
  ) {
    led.push("subdivision");
  }
  return led;
}

export function peopleRelationships(self: Person | null, people: Person[]): PersonRelationship[] {
  return people.map((person) => {
    let differentParent = false;
    let incompleteParent = false;
    const shared = Object.fromEntries(
      levels.map((level) => {
        const own = organizationName(self?.[level] ?? "");
        const other = organizationName(person[level]);
        if (own && other && own !== other) differentParent = true;
        const value = differentParent ? false : !own || !other || incompleteParent ? null : true;
        if (!own !== !other || (level === "company" && !own)) incompleteParent = true;
        return [level, value];
      }),
    ) as PersonRelationship["shared"];
    const isSelf = self?.email === person.email;
    return {
      email: person.email,
      isSelf,
      shared,
      closestShared: levels.findLast((level) => shared[level] === true) ?? null,
      leadsUserAt:
        !self || isSelf ? [] : leadership(person).filter((level) => shared[level] === true),
      userLeadsAt:
        !self || isSelf ? [] : leadership(self).filter((level) => shared[level] === true),
    };
  });
}
