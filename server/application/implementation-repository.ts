import type { Item, ProfileDocument } from "../../shared/schema.js";

export type ImplementationRepository = {
  id: string;
  name: string;
  path: string;
  document: string | null;
};

export function resolveImplementationRepository(
  item: Pick<Item, "project" | "references" | "noProject">,
  repositories: ImplementationRepository[],
  documents: ProfileDocument[],
) {
  if (item.noProject) return null;
  const targets = new Set(
    item.references.filter((ref) => ref.kind !== "person").map((ref) => ref.target),
  );
  const referenced = repositories.filter((repo) => repo.document && targets.has(repo.document));
  const project = item.project.trim().toLowerCase();
  const named = project
    ? repositories.filter(
        (repo) =>
          [repo.name, documents.find((doc) => doc.path === repo.document)?.title].some(
            (name) => name?.toLowerCase() === project,
          ) ||
          repo.path === item.project.trim() ||
          repo.document === item.project.trim(),
      )
    : [];
  const matches = project ? named : referenced;
  return matches.length === 1 ? matches[0].id : null;
}
