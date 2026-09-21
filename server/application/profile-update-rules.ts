import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import type { ProfileDocument } from "../../shared/schema.js";
import type { ProfileUpdate } from "./profile-update-model.js";
export function validateUpdatePath(path: string, seen: Set<string>) {
  const parts = path.split("/");
  if (
    !path.endsWith(".md") ||
    parts.some((part) => !part || part.startsWith(".") || part.includes("\\")) ||
    seen.has(path)
  )
    throw new Error("Profile update contains an invalid or repeated document path.");
}
export function validateProtectedContent(
  previous: ProfileDocument,
  change: { path: string; content: string },
) {
  const metadata = (content: string) => {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    return match ? parse(match[1]) : {};
  };
  const before = metadata(previous.content);
  const after = metadata(change.content);
  for (const [key, value] of Object.entries(before ?? {})) {
    if (!isDeepStrictEqual(value, after?.[key]))
      throw new Error(`Profile update changed protected metadata in ${change.path}.`);
  }
  for (const section of previous.content.matchAll(
    /<!-- (projects|aliases|alias-targets|project-summary):start -->[\s\S]*?<!-- \1:end -->/g,
  )) {
    if (!change.content.includes(section[0]))
      throw new Error(`Profile update changed a managed section in ${change.path}.`);
  }
}
export function validateUpdateTargets(update: ProfileUpdate, documents: ProfileDocument[]) {
  if (
    !update.paths.length ||
    update.paths.some((path) => !documents.some((doc) => doc.path === path && doc.type !== "Index"))
  )
    throw new Error("Profile update did not identify the concepts containing the note.");
}
export function validateSnapshot(snapshot: ProfileDocument[], current: ProfileDocument[]) {
  if (
    current.length !== snapshot.length ||
    snapshot.some(
      (doc) => !current.some((next) => next.path === doc.path && next.hash === doc.hash),
    )
  )
    throw new Error("Profile changed during the update. Retry with the latest documents.");
}
