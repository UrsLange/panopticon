import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { concurrency } from "./application/concurrency.js";

export type GitHubCacheEntry = {
  body?: unknown;
  etag?: string;
  modified?: string;
  link?: string;
  checkedAt?: number;
  expires: number;
  retryAt?: number;
  failures?: number;
  pollInterval?: number;
};
export type GitHubResponse = GitHubCacheEntry & { body: unknown; checkedAt: number };
export interface GitHubCache {
  githubCache(key: string): GitHubCacheEntry | undefined;
  saveGithubCache(key: string, entry: GitHubCacheEntry): void;
}

const execute = promisify(execFile);
async function gh(args: string[]) {
  try {
    return (
      await execute("gh", args, {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      })
    ).stdout;
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (output?.startsWith("HTTP/")) return output;
    throw new Error("GitHub CLI unavailable. Check your sign-in and network connection.");
  }
}

export function createGitHubApi(
  cache: GitHubCache,
  run = gh,
  now = Date.now,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  const queue = concurrency(4);
  const inFlight = new Map<string, Promise<GitHubResponse>>();
  let nextStart = 0;
  let spacing = 200;
  let averageDuration = 0;
  let blockedUntil = cache.githubCache("rate-limit")?.retryAt ?? 0;
  let rateFailures = cache.githubCache("rate-limit")?.failures ?? 0;

  async function request(endpoint: string, ttl: number, force = false): Promise<GitHubResponse> {
    const existing = inFlight.get(endpoint);
    if (existing) return existing;
    const saved = cache.githubCache(endpoint);
    if ((saved?.retryAt ?? 0) > now())
      throw new Error("GitHub check deferred after an error; retry is scheduled.");
    if (
      saved?.body !== undefined &&
      saved.checkedAt !== undefined &&
      (saved.checkedAt + (saved.pollInterval ?? 0) > now() ||
        saved.checkedAt + 5000 > now() ||
        (!force &&
          Math.min(saved.expires, saved.checkedAt + Math.max(ttl, saved.pollInterval ?? 0)) >
            now()))
    )
      return { ...saved, body: saved.body, checkedAt: saved.checkedAt };
    const job = queue(async () => {
      if (blockedUntil > now())
        throw new Error("GitHub checks paused for rate limits; they will resume automatically.");
      const start = Math.max(now(), nextStart);
      nextStart = start + spacing;
      if (start > now()) await sleep(start - now());
      if (blockedUntil > now())
        throw new Error("GitHub checks paused for rate limits; they will resume automatically.");
      try {
        const args = ["api", "--hostname", "github.com", "--include", endpoint];
        if (saved?.etag) args.push("-H", `If-None-Match: ${saved.etag}`);
        else if (saved?.modified) args.push("-H", `If-Modified-Since: ${saved.modified}`);
        const startedAt = now();
        const raw = await run(args);
        averageDuration = averageDuration * 0.75 + (now() - startedAt) * 0.25;
        const separator = raw.search(/\r?\n\r?\n/);
        const head = raw.slice(0, separator);
        const status = Number(head.match(/^HTTP\/\S+ (\d+)/)?.[1]);
        if (separator < 0 || !status) throw new Error("Invalid GitHub API response.");
        const headers = new Map(
          head
            .split(/\r?\n/)
            .slice(1)
            .map((line) => {
              const colon = line.indexOf(":");
              return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
            }),
        );
        const remaining = Number(headers.get("x-ratelimit-remaining"));
        const limit = Number(headers.get("x-ratelimit-limit"));
        const reset = Number(headers.get("x-ratelimit-reset")) * 1000;
        if (headers.get("x-ratelimit-resource") === "core" && limit > 0 && reset > now()) {
          spacing =
            remaining < limit / 2
              ? Math.max(
                  200,
                  averageDuration,
                  (reset - now()) / Math.max(1, remaining - limit / 10),
                )
              : Math.max(200, averageDuration);
          if (remaining <= limit / 10) blockedUntil = Math.max(blockedUntil, reset + 1000);
        }
        const bodyText = raw.slice(separator).trim();
        const limited =
          status === 429 ||
          (status === 403 &&
            (headers.has("retry-after") ||
              (remaining === 0 && headers.has("x-ratelimit-remaining")) ||
              /rate limit/i.test(bodyText)));
        if (limited) {
          rateFailures++;
          const retry = headers.get("retry-after");
          const retryAt = retry
            ? Number.isFinite(Number(retry))
              ? now() + Number(retry) * 1000
              : Date.parse(retry)
            : 0;
          blockedUntil = Math.max(
            blockedUntil,
            retryAt || 0,
            remaining === 0 ? reset + 1000 : 0,
            now() + Math.min(3600000, 60000 * 2 ** (rateFailures - 1)),
          );
        }
        if ((status === 304 || (status >= 200 && status < 300)) && blockedUntil <= now())
          rateFailures = 0;
        cache.saveGithubCache("rate-limit", {
          expires: 0,
          retryAt: blockedUntil,
          failures: rateFailures,
        });
        if (status === 304 && saved?.body !== undefined) {
          const entry = {
            ...saved,
            body: saved.body,
            pollInterval:
              Number(headers.get("x-poll-interval") ?? (saved.pollInterval ?? 0) / 1000) * 1000,
            checkedAt: now(),
            expires: now() + Math.max(ttl, Number(headers.get("x-poll-interval") ?? 0) * 1000),
            retryAt: undefined,
            failures: 0,
          };
          cache.saveGithubCache(endpoint, entry);
          return entry;
        }
        if (status < 200 || status >= 300)
          throw new Error(
            limited
              ? "GitHub checks paused for rate limits; they will resume automatically."
              : `GitHub API returned ${status}. Check repository access.`,
          );
        const entry: GitHubResponse = {
          body: JSON.parse(bodyText),
          pollInterval: Number(headers.get("x-poll-interval") ?? 0) * 1000,
          etag: headers.get("etag"),
          modified: headers.get("last-modified"),
          link: headers.get("link"),
          checkedAt: now(),
          expires: now() + Math.max(ttl, Number(headers.get("x-poll-interval") ?? 0) * 1000),
          failures: 0,
        };
        cache.saveGithubCache(endpoint, entry);
        return entry;
      } catch (error) {
        const failures = (saved?.failures ?? 0) + 1;
        cache.saveGithubCache(endpoint, {
          ...saved,
          expires: 0,
          failures,
          retryAt: Math.max(blockedUntil, now() + Math.min(3600000, 60000 * 2 ** (failures - 1))),
        });
        throw error;
      }
    });
    inFlight.set(endpoint, job);
    try {
      return await job;
    } finally {
      inFlight.delete(endpoint);
    }
  }
  return {
    get: request,
    async pages(endpoint: string, ttl: number, force = false) {
      const pages: GitHubResponse[] = [];
      let next: string | undefined = endpoint;
      while (next) {
        const page = await request(next, ttl, force);
        pages.push(page);
        if (endpoint.startsWith("search/") && pages.length === 10) break;
        const link = page.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
        if (link) {
          const url = new URL(link);
          if (url.origin !== "https://api.github.com")
            throw new Error("Invalid GitHub pagination link.");
          next = url.pathname.slice(1) + url.search;
        } else next = undefined;
      }
      return pages;
    },
  };
}
export type GitHubApi = ReturnType<typeof createGitHubApi>;
