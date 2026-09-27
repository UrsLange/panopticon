import { afterEach, expect, it, vi } from "vitest";
import { createGitHubApi } from "../server/github-api.js";
import { repositoryInsights } from "../server/repository-insights.js";
import { Store } from "../server/store.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
});
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
  const missing = new Set<number>();
  const denied = new Set<number>();
  let time = 1800000000000;
  const latest = (id: number) => {
    const item = runs.get(id);
    return item
      ? {
          id: id * 10,
          workflow_id: id,
          html_url: `https://github.com/acme/app/actions/runs/${id * 10}`,
          head_branch: "release/main",
          ...item,
        }
      : null;
  };
  const reviews = [
    { number: 2, title: "Review me", html_url: "https://github.com/acme/app/pull/2" },
  ];
  const findings: {
    number: number;
    html_url: string;
    security_advisory: { summary: string; severity: string };
  }[] = [];
  const run = vi.fn(async (args: string[]) => {
    const endpoint = args[4];
    let body: unknown;
    if (endpoint.startsWith("search/"))
      body = { items: reviews, total_count: reviews.length, incomplete_results: false };
    else if (endpoint.includes("dependabot/")) body = findings;
    else if (endpoint === "repos/acme/app") body = { default_branch: "release/main" };
    else if (endpoint.includes("workflows?"))
      body = {
        workflows: [...runs.keys(), 7].map((id) => ({
          id,
          name: `Workflow ${id}`,
          state: id === 7 ? "disabled_manually" : "active",
        })),
      };
    else if (endpoint.includes("actions/runs?"))
      body = {
        workflow_runs: [...runs.keys()]
          .filter((id) => !missing.has(id))
          .map(latest)
          .filter(Boolean),
      };
    else {
      const id = Number(endpoint.match(/workflows\/(\d+)\/runs/)?.[1]);
      if (denied.has(id)) throw new Error("Forbidden");
      if (!runs.has(id)) throw new Error(`Unexpected endpoint ${endpoint}`);
      body = { workflow_runs: latest(id) ? [latest(id)] : [] };
    }
    return `HTTP/2.0 200\r\n\r\n${JSON.stringify(body)}`;
  });
  const store = new Store(":memory:");
  stores.push(store);
  const api = createGitHubApi(
    store,
    run,
    () => time,
    async () => {},
  );
  return {
    runs,
    run,
    api,
    missing,
    denied,
    reviews,
    findings,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

it("batches latest default-branch runs and falls back only for missing active workflows", async () => {
  const f = fixture();
  const result = await repositoryInsights("https://github.com/acme/app", f.api);
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
  const queries = f.run.mock.calls.filter(([args]) => args[4].includes("/runs?"));
  expect(queries).toHaveLength(2);
  expect(queries[0][0][4]).toBe("repos/acme/app/actions/runs?branch=release%2Fmain&per_page=100");
  expect(queries[1][0][4]).toContain("workflows/6/runs");
  expect(f.run).toHaveBeenCalledTimes(6);
});

it("checks pending runs sooner while reusing metadata, security, and shared reviews", async () => {
  const f = fixture();
  const previous = await repositoryInsights("https://github.com/acme/app", f.api);
  f.advance(31000);
  f.run.mockClear();
  f.runs.set(4, { status: "completed", conclusion: "success" });
  const next = await repositoryInsights("https://github.com/acme/app", f.api, { previous });
  expect(next.pipelines?.pending).toBe(0);
  expect(f.run.mock.calls.map(([args]) => args[4])).toEqual([
    "repos/acme/app/actions/runs?branch=release%2Fmain&per_page=100",
    "repos/acme/app/actions/workflows/6/runs?branch=release%2Fmain&per_page=1",
  ]);
  expect(next.securityCheckedAt).toBe(previous.securityCheckedAt);
});

it("clears recovered failures and does not flag pending reruns, unrelated branches, or invalid links", async () => {
  const f = fixture();
  const previous = await repositoryInsights("https://github.com/acme/app", f.api);
  f.runs.set(2, { status: "completed", conclusion: "success" });
  f.runs.set(3, { status: "in_progress", conclusion: "timed_out" });
  f.runs.set(5, { status: "completed", conclusion: "failure", head_branch: "feature" });
  f.runs.set(6, { status: "completed", conclusion: "failure", html_url: "https://evil.test/run" });
  f.advance(120001);
  expect(
    (await repositoryInsights("https://github.com/acme/app", f.api, { previous })).pipelines
      ?.failures,
  ).toEqual([]);
});

it("retains known failures when a missing workflow cannot be checked", async () => {
  const f = fixture();
  const previous = await repositoryInsights("https://github.com/acme/app", f.api);
  f.missing.add(2);
  f.denied.add(2);
  f.advance(120001);
  const result = await repositoryInsights("https://github.com/acme/app", f.api, { previous });
  expect(result.pipelines?.failures).toHaveLength(2);
  expect(result.pipelines?.error).toContain("Some pipeline checks are unavailable");
});

it("retains last known findings and reports errors when GitHub is unavailable", async () => {
  const f = fixture();
  const previous = await repositoryInsights("https://github.com/acme/app", f.api);
  f.advance(3600001);
  f.run.mockRejectedValue(new Error("Offline"));
  const result = await repositoryInsights("https://github.com/acme/app", f.api, { previous });
  expect(result.pipelines?.failures).toEqual(previous.pipelines?.failures);
  expect(result.pipelines?.error).toContain("Cannot check pipelines");
  expect(result.reviews).toEqual(previous.reviews);
  expect(result.reviewError).toContain("Offline");
  expect(result.securityErrors).toHaveLength(1);
});

it("shares review search across repositories and filters reviews and security links", async () => {
  const f = fixture();
  f.reviews.push({
    number: 3,
    title: "Another repo",
    html_url: "https://github.com/acme/other/pull/3",
  });
  f.findings.push(
    {
      number: 1,
      html_url: "https://github.com/acme/app/security/dependabot/1",
      security_advisory: { summary: "Update dependency", severity: "high" },
    },
    {
      number: 2,
      html_url: "https://evil.test/alert",
      security_advisory: { summary: "Ignore", severity: "high" },
    },
  );
  const [app, other] = await Promise.all([
    repositoryInsights("https://github.com/acme/app", f.api),
    repositoryInsights("https://github.com/acme/other", f.api),
  ]);
  expect(app.reviews.map((review) => review.number)).toEqual([2]);
  expect(other.reviews.map((review) => review.number)).toEqual([3]);
  expect(f.run.mock.calls.filter(([args]) => args[4].startsWith("search/"))).toHaveLength(1);
  expect(app.findings).toEqual([
    {
      number: 1,
      title: "Update dependency",
      severity: "high",
      source: "Dependabot",
      url: "https://github.com/acme/app/security/dependabot/1",
    },
  ]);
});

it("publishes completed categories before slower pipeline requests finish", async () => {
  const f = fixture();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const get = f.api.get;
  vi.spyOn(f.api, "get").mockImplementation(async (...args) => {
    if (args[0].includes("actions/runs")) await gate;
    return get(...args);
  });
  const onUpdate = vi.fn();
  const job = repositoryInsights("https://github.com/acme/app", f.api, { onUpdate });
  await vi.waitFor(() =>
    expect(onUpdate.mock.calls.some(([result]) => result.reviews.length === 1)).toBe(true),
  );
  release();
  await job;
});

it("uses five cold requests for 100 workflows, zero while fresh, and two on the next normal refresh", async () => {
  const f = fixture();
  f.runs.clear();
  for (let id = 100; id < 200; id++) f.runs.set(id, { status: "completed", conclusion: "success" });
  const first = await repositoryInsights("https://github.com/acme/app", f.api);
  expect(first.pipelines?.checked).toBe(100);
  expect(f.run).toHaveBeenCalledTimes(5);
  await repositoryInsights("https://github.com/acme/app", f.api, { previous: first });
  expect(f.run).toHaveBeenCalledTimes(5);
  f.advance(120001);
  f.run.mockClear();
  await repositoryInsights("https://github.com/acme/app", f.api, { previous: first });
  expect(f.run.mock.calls.map(([args]) => args[4]).sort()).toEqual([
    "repos/acme/app/actions/runs?branch=release%2Fmain&per_page=100",
    "search/issues?q=is%3Apr%20is%3Aopen%20review-requested%3A%40me&per_page=100",
  ]);
});

it("reads security findings across pages and clears them after recovery", async () => {
  const f = fixture();
  const original = f.run.getMockImplementation();
  if (!original) throw new Error("Missing transport fixture");
  f.run.mockImplementation(async (args) => {
    if (!args[4].includes("dependabot")) return original(args);
    const second = args[4].includes("page=2");
    const number = second ? 2 : 1;
    const link = second
      ? ""
      : 'Link: <https://api.github.com/repos/acme/app/dependabot/alerts?state=open&per_page=100&page=2>; rel="next"\r\n';
    return `HTTP/2.0 200\r\n${link}\r\n${JSON.stringify([{ number, html_url: `https://github.com/acme/app/security/dependabot/${number}`, security_advisory: { summary: "Dependency", severity: "high" } }])}`;
  });
  const previous = await repositoryInsights("https://github.com/acme/app", f.api);
  expect(previous.findings.map((entry) => entry.number)).toEqual([1, 2]);
  f.advance(30 * 60000 + 1);
  f.run.mockImplementation(original);
  const next = await repositoryInsights("https://github.com/acme/app", f.api, { previous });
  expect(next.findings).toEqual([]);
  expect(next.securityErrors).toEqual([]);
});
