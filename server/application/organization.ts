export type HierarchyLevel = "team" | "unit" | "subdivision" | "division";

export const organizationName = (name: string) => name.normalize("NFKC").trim().toLowerCase();

export function organizationHierarchy(dn: string, types: Map<string, Set<HierarchyLevel>>) {
  const hierarchy = { team: "", unit: "", subdivision: "", division: "" };
  const warnings: string[] = [];
  const nodes = (dn.match(/(?:\\.|[^\\,])+/gu) ?? []).flatMap((part) => {
    const match = part.trim().match(/^OU=(.*)$/i);
    if (!match) return [];
    return [
      match[1]
        .replace(
          /((?:\\[0-9a-f]{2})+)|\\(.)/gi,
          (_match, hex: string | undefined, escaped: string) =>
            hex ? Buffer.from(hex.replaceAll("\\", ""), "hex").toString("utf8") : escaped,
        )
        .trim(),
    ];
  });
  if (!nodes.length)
    return {
      hierarchy,
      warnings: [
        "Some people have no organizational directory path; their hierarchy remains empty.",
      ],
    };
  const root = nodes.findIndex((node) => organizationName(node) === "organisation");
  // The company container immediately precedes the shared Organisation container.
  const path = root > 0 ? nodes.slice(0, root - 1) : nodes;
  const classified = new Map<HierarchyLevel, string[]>();
  for (const node of path) {
    const levels = types.get(organizationName(node));
    if (levels?.size !== 1) {
      warnings.push(
        `Organizational node “${node}” has ${levels ? "conflicting" : "no"} group type information; it was left unclassified.`,
      );
      continue;
    }
    const level = [...levels][0];
    classified.set(level, [...(classified.get(level) ?? []), node]);
  }
  for (const [level, names] of classified) {
    if (names.length === 1) hierarchy[level] = names[0];
    else
      warnings.push(
        `Multiple ${level} nodes in one directory path (${names.join(", ")}); that column remains empty.`,
      );
  }
  return { hierarchy, warnings };
}
