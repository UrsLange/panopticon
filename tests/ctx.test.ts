import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { searchSessionEvidence } from "../server/ctx.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }),
    execFileSync: vi.fn(),
  };
});

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue({
    stdout: JSON.stringify({ results: [], result_window: { more_available: false } }),
  });
});

afterEach(() => vi.restoreAllMocks());

it.each([
  ["2026-09-28", "2026-09-28T00:00:00Z"],
  ["30d", "30d"],
  ["2026-09-28T10:30:00+02:00", "2026-09-28T10:30:00+02:00"],
  [undefined, undefined],
])("passes a supported CTX time filter for %s", async (since, expected) => {
  const signal = new AbortController().signal;
  const result = await searchSessionEvidence("onboarding", "/project", since, signal);
  expect(execute).toHaveBeenCalledWith(
    "ctx",
    [
      "search",
      "--term",
      "onboarding",
      "--limit",
      "10",
      "--refresh",
      "off",
      "--format",
      "json",
      "--workspace",
      "/project",
      ...(expected ? ["--since", expected] : []),
    ],
    expect.objectContaining({ signal }),
  );
  expect(result).toMatchObject({ results: [], moreAvailable: false });
});

it("records command failures without logging the command or query", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const failure = Object.assign(new Error("command with private query"), {
    code: 1,
    stderr: "Error: index unavailable",
  });
  execute.mockRejectedValueOnce(failure);
  await expect(
    searchSessionEvidence("private query", "/project", undefined, new AbortController().signal),
  ).rejects.toMatchObject({
    message: "CTX history search command failed.",
    cause: failure,
  });
  expect(warn).toHaveBeenCalledWith(
    "CTX history search failed",
    expect.objectContaining({
      stage: "command",
      code: 1,
      stderr: "Error: index unavailable",
      workspace: "/project",
    }),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private query");
});

it.each(["not JSON", JSON.stringify({ results: [] })])(
  "identifies invalid CTX output as a response failure",
  async (stdout) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    execute.mockResolvedValueOnce({ stdout });
    await expect(
      searchSessionEvidence("onboarding", undefined, undefined, new AbortController().signal),
    ).rejects.toThrow("CTX history search response failed.");
    expect(warn).toHaveBeenCalledWith(
      "CTX history search failed",
      expect.objectContaining({ stage: "response" }),
    );
  },
);
