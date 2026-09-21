import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prompts, renderPrompt } from "../server/prompts.js";

it("inserts dynamic values literally without interpreting placeholders inside them", () => {
  const calls = '{{minutes}}/$&/"quoted"';
  const result = renderPrompt("project-exploration", { calls, minutes: "10" });
  expect(result).toContain(`${calls} tool calls and 10 minutes`);
});

it("renders research limits and optional finalization instructions", () => {
  const issues = "Unavailable {{calls}} source with $& in its name.";
  const limitations = renderPrompt("research-limitations", { issues });
  const result = renderPrompt("research", {
    calls: "100",
    minutes: "15",
    limitations,
    finalization: prompts["research-finalization"],
  });
  expect(result).toContain("100 tool calls");
  expect(result).toContain("15 minutes");
  expect(result).toContain(issues);
  expect(result).toContain(prompts["research-finalization"]);
  const researching = renderPrompt("research", {
    calls: "100",
    minutes: "15",
    limitations: "",
    finalization: "",
  });
  expect(researching).not.toContain("{{");
  expect(researching).not.toContain(prompts["research-finalization"]);
});

it("identifies the file and missing variable when a template cannot be rendered", () => {
  expect(() => renderPrompt("project-exploration", { calls: "100" })).toThrow(
    "Missing prompt variable minutes in prompts/project-exploration.md",
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
