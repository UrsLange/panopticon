import { afterEach, expect, it, vi } from "vitest";
import { createGitHubApi } from "../server/github-api.js";
import { Store } from "../server/store.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
});
function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return `HTTP/2.0 ${status}\r\n${Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("")}\r\n${status === 304 ? "" : JSON.stringify(body)}`;
}
function fixture(run: (args: string[]) => Promise<string>) {
  const store = new Store(":memory:");
  stores.push(store);
  let time = 1800000000000;
  const now = () => time;
  const sleep = async () => {};
  return {
    store,
    now,
    sleep,
    advance: (ms: number) => {
      time += ms;
    },
    api: createGitHubApi(store, run, now, sleep),
  };
}

it("persists fresh responses, revalidates expired responses, and coalesces concurrent requests", async () => {
  const run = vi.fn(async (_args: string[]) => response({ value: 1 }, 200, { ETag: '"first"' }));
  const f = fixture(run);
  await Promise.all(Array.from({ length: 20 }, () => f.api.get("repos/a/b", 60000)));
  expect(run).toHaveBeenCalledTimes(1);
  const restarted = createGitHubApi(f.store, run, f.now, f.sleep);
  expect((await restarted.get("repos/a/b", 60000)).body).toEqual({ value: 1 });
  expect(run).toHaveBeenCalledTimes(1);
  f.advance(60001);
  run.mockResolvedValue(response(null, 304));
  expect((await restarted.get("repos/a/b", 60000)).body).toEqual({ value: 1 });
  expect(run.mock.calls[1][0]).toContain('If-None-Match: "first"');
  expect(f.store.githubCache("repos/a/b")?.checkedAt).toBe(f.now());
});

it("honors poll intervals even for manual refresh and supports Last-Modified validators", async () => {
  const run = vi.fn(async (_args: string[]) =>
    response([], 200, { "Last-Modified": "yesterday", "X-Poll-Interval": "120" }),
  );
  const f = fixture(run);
  await f.api.get("repos/a/b", 30000);
  f.advance(60000);
  await f.api.get("repos/a/b", 30000, true);
  expect(run).toHaveBeenCalledTimes(1);
  f.advance(60001);
  await f.api.get("repos/a/b", 30000);
  expect(run.mock.calls[1][0]).toContain("If-Modified-Since: yesterday");
});

it("follows cached pagination links and validates their origin", async () => {
  const run = vi.fn(async (args: string[]) =>
    args.includes("repos/a/b?page=2")
      ? response([2])
      : response([1], 200, { Link: '<https://api.github.com/repos/a/b?page=2>; rel="next"' }),
  );
  const f = fixture(run);
  expect((await f.api.pages("repos/a/b", 60000)).map((page) => page.body)).toEqual([[1], [2]]);
  await f.api.pages("repos/a/b", 60000);
  expect(run).toHaveBeenCalledTimes(2);
  run.mockResolvedValue(response([], 200, { Link: '<https://evil.test/page>; rel="next"' }));
  await expect(f.api.pages("repos/other/b", 60000)).rejects.toThrow("pagination link");
});

it("persists shared rate-limit backoff and prevents queued and forced requests from bypassing it", async () => {
  const run = vi.fn(async () =>
    response({ message: "secondary rate limit" }, 429, { "Retry-After": "120" }),
  );
  const f = fixture(run);
  await expect(f.api.get("repos/a/b", 60000)).rejects.toThrow("rate limit");
  const restarted = createGitHubApi(f.store, run, f.now, f.sleep);
  await expect(restarted.get("repos/c/d", 60000, true)).rejects.toThrow("rate limit");
  expect(run).toHaveBeenCalledTimes(1);
  f.advance(120001);
  run.mockResolvedValue(response({ ok: true }));
  expect((await restarted.get("repos/c/d", 60000)).body).toEqual({ ok: true });
});

it("retains cached data on failures and backs off without treating it as fresh", async () => {
  const run = vi.fn(async () => response([1], 200, { ETag: '"saved"' }));
  const f = fixture(run);
  await f.api.get("repos/a/b", 60000);
  f.advance(60001);
  run.mockResolvedValue(response({ message: "no access" }, 403));
  await expect(f.api.get("repos/a/b", 60000)).rejects.toThrow("403");
  await expect(f.api.get("repos/a/b", 60000, true)).rejects.toThrow("deferred");
  expect(f.store.githubCache("repos/a/b")?.body).toEqual([1]);
  expect(run).toHaveBeenCalledTimes(2);
});

it("limits in-flight requests and serves queued repositories in order", async () => {
  const releases: (() => void)[] = [];
  const started: string[] = [];
  const run = vi.fn(async (args: string[]) => {
    started.push(args[4]);
    await new Promise<void>((resolve) => releases.push(resolve));
    return response([]);
  });
  const f = fixture(run);
  const jobs = Array.from({ length: 6 }, (_, i) => f.api.get(`repos/a/${i}`, 60000));
  await vi.waitFor(() => expect(started).toHaveLength(4));
  releases[0]();
  await vi.waitFor(() => expect(started).toHaveLength(5));
  releases[1]();
  await vi.waitFor(() =>
    expect(started).toEqual(Array.from({ length: 6 }, (_, i) => `repos/a/${i}`)),
  );
  for (const release of releases) release();
  await Promise.all(jobs);
});

it("reserves remaining primary budget and waits until its reset", async () => {
  const run = vi.fn(async () =>
    response([], 200, {
      "x-ratelimit-resource": "core",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "500",
      "x-ratelimit-reset": "1800003600",
    }),
  );
  const f = fixture(run);
  await f.api.get("repos/a/first", 60000);
  await expect(f.api.get("repos/a/second", 60000)).rejects.toThrow("rate limit");
  expect(run).toHaveBeenCalledTimes(1);
});
