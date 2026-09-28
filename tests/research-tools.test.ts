import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readSessionEvent, searchSessionEvidence } from "../server/ctx.js";
import { createResearch } from "../server/research-tools.js";

vi.mock("../server/ctx.js", () => ({
  readSessionEvent: vi.fn(async () => "Historical evidence"),
  searchSessionEvidence: vi.fn(async () => ({ results: [] })),
}));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pa-research-"));
  const profile = join(root, "profile");
  const project = join(root, "project");
  mkdirSync(profile);
  mkdirSync(project);
  const research = createResearch([
    { id: "profile", name: "Profile", root: profile },
    { id: "project:one", name: "Project One", root: project, profileDocument: "project.md" },
  ]);
  const signal = new AbortController().signal;
  const call = (name: string, input: unknown) => {
    const tool = research.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error("Missing test tool");
    return tool.execute(input, signal);
  };
  return { root, profile, project, research, signal, call };
}

it("discovers nested context, searches across scopes and continues full file reads", async () => {
  const f = fixture();
  mkdirSync(join(f.profile, "rules"));
  writeFileSync(
    join(f.profile, "rules", "review.md"),
    `${"x".repeat(12000)}Require browser verification.`,
  );
  writeFileSync(join(f.project, "README.md"), "This project depends on Activation.");
  expect(f.research.scopes).toEqual([
    { id: "profile", name: "Profile" },
    { id: "project:one", name: "Project One", profileDocument: "project.md" },
  ]);
  expect(await f.call("list_files", { scope: "profile", path: "", offset: 0 })).toMatchObject({
    data: { entries: [{ path: "rules", directory: true }], nextOffset: null },
    sources: [],
  });
  expect(
    await f.call("search_files", { scope: "profile", path: "", query: "browser", offset: 0 }),
  ).toMatchObject({
    data: { matches: [{ path: "rules/review.md", source: "rules/review.md" }], nextOffset: null },
    sources: ["rules/review.md"],
  });
  expect(
    await f.call("read_file", { scope: "profile", path: "rules/review.md", offset: 0 }),
  ).toMatchObject({ data: { nextOffset: 12000 } });
  expect(
    await f.call("read_file", { scope: "profile", path: "rules/review.md", offset: 12000 }),
  ).toMatchObject({ data: { content: "Require browser verification.", nextOffset: null } });
  expect(
    await f.call("read_file", { scope: "project:one", path: "README.md", offset: 0 }),
  ).toMatchObject({ sources: ["project:one/README.md"] });
});

it("blocks escaped roots, symlinks, credential files, binary data and unknown scopes", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "outside.md"), "Private");
  writeFileSync(join(f.profile, ".env.local"), "SECRET=value");
  writeFileSync(join(f.profile, "access-token.txt"), "private-token");
  writeFileSync(join(f.profile, ".npmrc"), "//registry.example/:_authToken=private");
  writeFileSync(join(f.profile, "data.bin"), Buffer.from([0, 1, 2]));
  symlinkSync(f.root, join(f.profile, "escape"));
  for (const path of [
    "../outside.md",
    join(f.root, "outside.md"),
    "escape/outside.md",
    ".env.local",
    "access-token.txt",
    ".npmrc",
    "data.bin",
  ]) {
    await expect(f.call("read_file", { scope: "profile", path, offset: 0 })).rejects.toThrow();
  }
  await expect(f.call("list_files", { scope: "invented", path: "", offset: 0 })).rejects.toThrow(
    "scope",
  );
  const listing = await f.call("list_files", { scope: "profile", path: "", offset: 0 });
  expect(JSON.stringify(listing)).not.toContain("escape");
  expect(JSON.stringify(listing)).not.toContain(".env");
  expect(JSON.stringify(listing)).not.toContain(".npmrc");
});

it("paginates search results without losing files and reports unreadable files", async () => {
  const f = fixture();
  for (let i = 0; i < 35; i++)
    writeFileSync(join(f.profile, `${String(i).padStart(2, "0")}.md`), "needle");
  writeFileSync(join(f.profile, "binary"), Buffer.from([0]));
  const first = await f.call("search_files", {
    scope: "profile",
    path: "",
    query: "needle",
    offset: 0,
  });
  expect(first.sources).toHaveLength(30);
  expect(first.data).toMatchObject({ nextOffset: 30 });
  const next = await f.call("search_files", {
    scope: "profile",
    path: "",
    query: "needle",
    offset: 30,
  });
  expect(next.sources).toHaveLength(5);
  expect(next.data).toMatchObject({ nextOffset: null, skipped: 1 });
  expect(new Set([...first.sources, ...next.sources]).size).toBe(35);
});

it("uses scoped CTX queries, exposes event evidence and rejects command-shaped identifiers", async () => {
  const f = fixture();
  await f.call("search_history", { query: "onboarding", project: "project:one", since: "30d" });
  expect(searchSessionEvidence).toHaveBeenLastCalledWith("onboarding", f.project, "30d", f.signal);
  await f.call("search_history", { query: "shared dependency", project: null, since: null });
  expect(searchSessionEvidence).toHaveBeenLastCalledWith(
    "shared dependency",
    undefined,
    undefined,
    f.signal,
  );
  await expect(f.call("read_history", { eventId: "--help", offset: 0 })).rejects.toThrow();
  expect(await f.call("read_history", { eventId: "abcdef12", offset: 0 })).toMatchObject({
    data: { content: "Historical evidence" },
    sources: ["ctx:abcdef12"],
  });
  expect(readSessionEvent).toHaveBeenLastCalledWith("abcdef12", f.signal);
  vi.mocked(searchSessionEvidence).mockRejectedValueOnce(new Error("CTX unavailable"));
  await expect(
    f.call("search_history", { query: "missing", project: null, since: null }),
  ).rejects.toThrow("CTX unavailable");
});

it.each(["yesterday", "2026-02-30", "2026-09-28 EOB"])(
  "rejects an invalid history time filter %s before invoking CTX",
  async (since) => {
    const f = fixture();
    const calls = vi.mocked(searchSessionEvidence).mock.calls.length;
    await expect(
      f.call("search_history", { query: "onboarding", project: null, since }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(searchSessionEvidence).toHaveBeenCalledTimes(calls);
  },
);
