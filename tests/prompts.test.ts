import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prompts, renderPrompt } from "../server/prompts.js";

it("inserts dynamic enrichment values literally", () => {
  const root = '{{documents}}/$&/"quoted"';
  const result = renderPrompt("profile-enrichment", { root, documents: "Document directory" });
  expect(result).toContain(root);
  expect(result).toContain("Document directory");
});

it("reports missing prompt variables", () => {
  expect(() => renderPrompt("profile-enrichment", { root: "/profile" })).toThrow(
    "Missing prompt variable documents in prompts/profile-enrichment.md",
  );
});

it("keeps loaded prompts until restart and reads edits in a new process", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-prompts-"));
  cpSync(new URL("../prompts", import.meta.url), join(root, "prompts"), { recursive: true });
  const moduleURL = new URL("../server/prompts.ts", import.meta.url).href;
  const read = `import { prompts } from ${JSON.stringify(moduleURL)};`;
  try {
    const beforeRestart = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `${read}
        import { writeFileSync } from 'node:fs';
        const before = prompts.conversation;
        writeFileSync('prompts/conversation.md', 'Edited conversation prompt.\\n');
        console.log(JSON.stringify({ before, after: prompts.conversation }));`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(beforeRestart)).toEqual({
      before: prompts.conversation,
      after: prompts.conversation,
    });
    const afterRestart = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `${read} console.log(prompts.conversation);`],
      { cwd: root, encoding: "utf8" },
    );
    expect(afterRestart.trim()).toBe("Edited conversation prompt.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
