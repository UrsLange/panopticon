import { expect, it } from "vitest";
import { peopleRelationships } from "../server/application/people-relationships.js";
import type { Person } from "../shared/people.js";

const self: Person = {
  prename: "Sam",
  lastname: "Self",
  email: "self@example.com",
  role: "Team Lead",
  company: "Example",
  division: "Product",
  subdivision: "Tech",
  unit: "",
  team: "Developer Experience",
};
const person = (fields: Partial<Person>): Person => ({
  ...self,
  email: "other@example.com",
  role: "Member",
  ...fields,
});

it("derives both leadership directions across skipped levels without inventing a unit", () => {
  const results = peopleRelationships(self, [
    person({}),
    person({ role: "Head of, Unit Lead, Head of, Team Lead", team: "" }),
    person({ role: "Division Lead", team: "", subdivision: "" }),
    self,
  ]);
  expect(results[0]).toMatchObject({
    closestShared: "team",
    userLeadsAt: ["team"],
    leadsUserAt: [],
    shared: { unit: null },
  });
  expect(results[1]).toMatchObject({
    closestShared: "subdivision",
    leadsUserAt: ["subdivision"],
    userLeadsAt: [],
  });
  expect(results[2]).toMatchObject({ closestShared: "division", leadsUserAt: ["division"] });
  expect(results[3]).toMatchObject({ isSelf: true, leadsUserAt: [], userLeadsAt: [] });
});

it("matches complete parent paths and distinguishes different from incomplete organizations", () => {
  const results = peopleRelationships(self, [
    person({ company: "Other" }),
    person({ division: "Other" }),
    person({ subdivision: "" }),
    person({ company: "", division: "" }),
    person({ team: " developer experience ", company: "ＥＸＡＭＰＬＥ" }),
  ]);
  expect(results[0]).toMatchObject({
    closestShared: null,
    shared: { company: false, team: false },
    userLeadsAt: [],
  });
  expect(results[1]).toMatchObject({
    closestShared: "company",
    shared: { division: false, team: false },
  });
  expect(results[2]).toMatchObject({
    closestShared: "division",
    shared: { subdivision: null, team: null },
    userLeadsAt: [],
  });
  expect(results[3]).toMatchObject({ closestShared: null, shared: { company: null, team: null } });
  expect(results[4]).toMatchObject({ closestShared: "team", userLeadsAt: ["team"] });
});

it("preserves multiple leaders, normalizes repeated titles and requires a corresponding scope", () => {
  const me = { ...self, unit: "Engineering" };
  const results = peopleRelationships(me, [
    person({ role: "Unit Lead, Unit Lead", unit: "Engineering", team: "" }),
    person({ role: "Mitarbeiter:in, Unit Lead", unit: "Engineering", team: "" }),
    person({ role: "Team Lead", team: "" }),
    person({ role: "Head of", subdivision: "", team: "" }),
    person({ role: "Chief" }),
  ]);
  expect(results.map((value) => value.leadsUserAt)).toEqual([["unit"], ["unit"], [], [], []]);
  expect(peopleRelationships(null, [person({})])[0]).toMatchObject({
    closestShared: null,
    leadsUserAt: [],
    userLeadsAt: [],
  });
});
