import { expect, it, vi } from "vitest";
import { repositoryInsights } from "../server/repository-insights.js";

function fixture() {
  const runs = new Map<
    number,
    { status: string; conclusion: string | null; head_branch?: string; html_url?: string } | null
  >([
    [1, { status: "completed", conclusion: "success" }],
    [2, { status: "completed", conclusion: "failure" }],
    [3, { status: "completed", conclusion: "timed_out" }],
    [4, { status: "in_progress", conclusion: null }],
    [5, { status: "completed", conclusion: "cancelled" }],
    [6, null],
  ]);
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === "pr") return "[]";
    const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (endpoint.includes("/dependabot/")) return "";
    if (endpoint === "repos/acme/app") return JSON.stringify({ default_branch: "release/main" });
    if (endpoint.includes("workflows?"))
      return [...runs.keys(), 7]
        .map((id) =>
          JSON.stringify({
            id,
            name: `Workflow ${id}`,
            state: id === 7 ? "disabled_manually" : "active",
          }),
        )
        .join("\n");
    const id = Number(endpoint.match(/workflows\/(\d+)\/runs/)?.[1]);
    if (!runs.has(id)) throw new Error("Unexpected workflow");
    const latest = runs.get(id);
    return JSON.stringify(
      latest
        ? [
            {
              id: id * 10,
              html_url: `https://github.com/acme/app/actions/runs/${id * 10}`,
              head_branch: "release/main",
              ...latest,
            },
          ]
        : [],
    );
  });
  return { runs, run };
}

it("checks every active workflow's latest run on the remote default branch", async () => {
  const { run } = fixture();
  const result = await repositoryInsights("https://github.com/acme/app", run);
  expect(result.pipelines).toMatchObject({
    branch: "release/main",
    checked: 6,
    pending: 1,
    error: null,
  });
  expect(result.pipelines?.failures.map((item) => item.title)).toEqual([
    "Workflow 2",
    "Workflow 3",
  ]);
  const queries = run.mock.calls.filter(([args]) => args.some((arg) => arg.includes("/runs?")));
  expect(queries).toHaveLength(6);
  for (const [args] of queries) {
    expect(args[1]).toContain("branch=release%2Fmain&per_page=1");
    expect(args[1]).not.toContain("status=");
  }
  expect(
    run.mock.calls.some(
      ([args]) => args.includes("--paginate") && args.some((arg) => arg.includes("workflows?")),
    ),
  ).toBe(true);
});

it("clears failures after recovery and does not flag reruns, unrelated branches, or invalid links", async () => {
  const { run, runs } = fixture();
  expect(
    (await repositoryInsights("https://github.com/acme/app", run)).pipelines?.failures,
  ).toHaveLength(2);
  runs.set(2, { status: "completed", conclusion: "success" });
  runs.set(3, { status: "in_progress", conclusion: "timed_out" });
  runs.set(5, { status: "completed", conclusion: "failure", head_branch: "feature" });
  runs.set(6, { status: "completed", conclusion: "failure", html_url: "https://evil.test/run" });
  expect(
    (await repositoryInsights("https://github.com/acme/app", run)).pipelines?.failures,
  ).toEqual([]);
});

it("retains known failures when another workflow is unavailable", async () => {
  const { run } = fixture();
  const result = await repositoryInsights("https://github.com/acme/app", async (args) => {
    if (args.some((arg) => arg.includes("workflows/1/runs"))) throw new Error("Forbidden");
    return run(args);
  });
  expect(result.pipelines?.failures).toHaveLength(2);
  expect(result.pipelines?.error).toContain("Some pipeline checks are unavailable");
});

it("reports inaccessible pipeline status without inventing failures", async () => {
  const result = await repositoryInsights("https://github.com/acme/app", async () => {
    throw new Error("Forbidden");
  });
  expect(result.pipelines?.error).toContain("Cannot check pipelines");
  expect(result.pipelines?.failures).toEqual([]);
});
