import { readFileSync } from "node:fs";
import { join } from "node:path";

const names = [
  "shared",
  "capture",
  "conversation",
  "profile-update",
  "profile-consolidation",
  "research",
  "research-limitations",
  "research-finalization",
  "project-exploration",
  "profile-enrichment",
  "connection-validation",
] as const;

type PromptName = (typeof names)[number];

export const prompts = Object.fromEntries(
  names.map((name) => [
    name,
    readFileSync(join("prompts", `${name}.md`), "utf8").replace(/\r?\n$/, ""),
  ]),
) as Record<PromptName, string>;

export function renderPrompt(name: PromptName, values: Record<string, string>) {
  return prompts[name].replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key))
      throw new Error(`Missing prompt variable ${key} in prompts/${name}.md`);
    return values[key];
  });
}
