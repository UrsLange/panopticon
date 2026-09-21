import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { exploreProject } from "../server/opencode.js";

afterEach(() => vi.unstubAllEnvs());

function fixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "pa-opencode-test-"));
  writeFileSync(
    join(root, "opencode"),
    `#!${process.execPath}\n${readFileSync(new URL("./fake-opencode.mjs", import.meta.url), "utf8")}`,
    { mode: 0o700 },
  );
  const document = join(root, "project.md");
  writeFileSync(
    document,
    "<!-- project-summary:start -->\n<!-- project-summary:end -->\n\n## Personal notes\n\n",
  );
  writeFileSync(join(root, "README.md"), "Example repository");
  vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
  vi.stubEnv("PA_TEST_OPENCODE_MODE", mode);
  return { repository: root, document, model: "test-model" };
}

it("reports live reads and a session before the CLI completes", async () => {
  const request = fixture("stream");
  let read = () => {};
  const reading = new Promise<void>((resolve) => {
    read = resolve;
  });
  let finished = false;
  const progress: unknown[] = [];
  const run = exploreProject({
    ...request,
    onProgress: (value) => {
      progress.push(value);
      if (value.phase === "reading") read();
    },
  }).then(() => {
    finished = true;
  });
  await reading;
  expect(finished).toBe(false);
  await run;
  expect(progress).toContainEqual({ sessionId: "ses_test" });
  expect(progress).toContainEqual({ model: "test/test-model" });
  expect(progress).toContainEqual({ phase: "validating" });
});

it("retains HTTP status without exposing provider response bodies", async () => {
  const failure = await exploreProject(fixture("provider")).catch((error) => error);
  expect(failure.diagnostic).toMatchObject({ category: "provider", statusCode: 503 });
  expect(failure.message).toContain("HTTP 503");
  expect(JSON.stringify(failure)).not.toContain("sensitive-provider-body");
});

it.each([
  ["process", "process"],
  ["invalid", "invalid-output"],
  ["incomplete", "incomplete"],
])("distinguishes %s failures", async (mode, category) => {
  const failure = await exploreProject(fixture(mode)).catch((error) => error);
  expect(failure.diagnostic.category).toBe(category);
  if (mode === "process") expect(failure.diagnostic.exitCode).toBe(7);
});
