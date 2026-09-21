import { parse } from "yaml";
import type { ProfileDocument } from "../../shared/schema.js";
import { readAliases } from "./aliases.js";

export function parseConcept(content: string, path: string): Omit<ProfileDocument, "hash"> {
  const name = path.split("/").at(-1) ?? path;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const data = match ? parse(match[1]) : {};
  const reserved = ["index.md", "log.md"].includes(name);
  if (!reserved && (!data || typeof data.type !== "string" || !data.type.trim())) {
    throw new Error(`${path}: OKF concepts need YAML frontmatter with a non-empty type.`);
  }
  if (data?.type === "Aliases") readAliases(content);
  return {
    path,
    title: typeof data?.title === "string" ? data.title : name.replace(/\.md$/, ""),
    type: reserved ? "Index" : data.type,
    description: typeof data?.description === "string" ? data.description : "",
    content,
  };
}
