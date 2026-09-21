import { parse } from "yaml";
import { z } from "zod";
import type { ProfileDocument } from "../../shared/schema.js";

export function profilePeople(documents: ProfileDocument[]) {
  return documents
    .filter((document) => document.type === "Person")
    .map((document) => {
      const frontmatter = document.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const metadata = frontmatter ? parse(frontmatter[1]) : {};
      const email = z
        .string()
        .trim()
        .email()
        .transform((value) => value.toLowerCase())
        .safeParse(metadata?.email);
      return {
        name: document.title,
        email: email.success ? email.data : null,
        target: email.success ? email.data : document.path,
        source: document.path,
      };
    });
}
