import type { ProfileDocument } from "../../shared/schema.js";

export function profileContext(
  documents: ProfileDocument[],
  query: string,
  targets: string[] = [],
) {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const docs = documents.filter((doc) => doc.path !== "people.md");
  const core = docs.filter((doc) => ["Profile", "Working rules"].includes(doc.type)).slice(0, 2);
  const pinned = docs.filter((doc) => targets.includes(doc.path) && !core.includes(doc));
  const related = docs
    .filter((doc) => !core.includes(doc) && !pinned.includes(doc))
    .map((doc) => ({
      doc,
      score: terms.reduce((n, term) => n + Number(doc.content.toLowerCase().includes(term)), 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ doc }) => doc);
  return {
    directory: [
      ...core,
      ...pinned,
      ...related,
      ...docs.filter(
        (doc) => !core.includes(doc) && !pinned.includes(doc) && !related.includes(doc),
      ),
    ]
      .slice(0, 80)
      .map(({ path, title, type, description }) => ({
        path,
        title,
        type,
        description,
      })),
    documents: [...core, ...pinned, ...related].map((doc) => ({
      path: doc.path,
      content: doc.content.slice(0, 8000),
    })),
  };
}
