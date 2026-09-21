import { expect, it } from "vitest";
import { type HierarchyLevel, organizationHierarchy } from "../server/application/organization.js";

const types = new Map<string, Set<HierarchyLevel>>([
  ["developer experience", new Set(["team"])],
  ["digital shared services", new Set(["unit"])],
  ["tech", new Set(["subdivision"])],
  ["product & tech organisation", new Set(["division"])],
]);

it.each([
  [
    "OU=Developer Experience,OU=Tech,OU=Product & Tech Organisation",
    {
      team: "Developer Experience",
      unit: "",
      subdivision: "Tech",
      division: "Product & Tech Organisation",
    },
  ],
  [
    "OU=Developer Experience,OU=Product & Tech Organisation",
    {
      team: "Developer Experience",
      unit: "",
      subdivision: "",
      division: "Product & Tech Organisation",
    },
  ],
  [
    "OU=Developer Experience,OU=Digital Shared Services,OU=Tech,OU=Product & Tech Organisation",
    {
      team: "Developer Experience",
      unit: "Digital Shared Services",
      subdivision: "Tech",
      division: "Product & Tech Organisation",
    },
  ],
  [
    "OU=Digital Shared Services,OU=Product & Tech Organisation",
    {
      team: "",
      unit: "Digital Shared Services",
      subdivision: "",
      division: "Product & Tech Organisation",
    },
  ],
  [
    "OU=Product & Tech Organisation",
    { team: "", unit: "", subdivision: "", division: "Product & Tech Organisation" },
  ],
])("classifies %s without assuming a fixed depth", (path, expected) => {
  expect(
    organizationHierarchy(`CN=Example,${path},OU=JR,OU=Organisation,DC=example,DC=com`, types),
  ).toEqual({ hierarchy: expected, warnings: [] });
});

it("decodes escaped commas, backslashes and UTF-8 names before looking up node types", () => {
  const escapedTypes = new Map<string, Set<HierarchyLevel>>([
    ["résumé, platform", new Set(["team"])],
    ["path\\tools", new Set(["subdivision"])],
  ]);
  const result = organizationHierarchy(
    String.raw`CN=Last\, First,OU=R\c3\a9sum\c3\a9\, Platform,OU=Path\\Tools,OU=JR,OU=Organisation,DC=example,DC=com`,
    escapedTypes,
  );
  expect(result.hierarchy).toEqual({
    team: "Résumé, Platform",
    unit: "",
    subdivision: "Path\\Tools",
    division: "",
  });
  expect(result.warnings).toEqual([]);
});

it("reports unknown or conflicting types without guessing from position or filling skipped levels", () => {
  const ambiguous = new Map(types);
  ambiguous.set("tech", new Set(["unit", "subdivision"]));
  const result = organizationHierarchy(
    "CN=Example,OU=Developer Experience,OU=Unknown,OU=Tech,OU=Product & Tech Organisation,OU=JR,OU=Organisation,DC=example",
    ambiguous,
  );
  expect(result.hierarchy).toEqual({
    team: "Developer Experience",
    unit: "",
    subdivision: "",
    division: "Product & Tech Organisation",
  });
  expect(result.warnings).toHaveLength(2);
  expect(result.warnings.join(" ")).toContain("conflicting");
  expect(organizationHierarchy("", types).warnings).toHaveLength(1);
});

it("keeps a column empty when multiple nodes on the path claim the same level", () => {
  const repeated = new Map(types);
  repeated.set("another team", new Set(["team"]));
  const result = organizationHierarchy(
    "CN=Example,OU=Developer Experience,OU=Another Team,OU=Tech,OU=JR,OU=Organisation,DC=example",
    repeated,
  );
  expect(result.hierarchy.team).toBe("");
  expect(result.hierarchy.subdivision).toBe("Tech");
  expect(result.warnings[0]).toContain("Multiple team");
});
