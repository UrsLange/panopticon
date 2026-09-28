import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);

export function ctxAvailable() {
  try {
    execFileSync("ctx", ["--version"], { timeout: 3000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function searchSessions(query: string) {
  const { stdout } = await execute(
    "ctx",
    ["search", "--term", query, "--limit", "5", "--refresh", "off", "--color", "never"],
    {
      timeout: 15000,
      maxBuffer: 128 * 1024,
    },
  );
  return stdout;
}

export async function searchSessionEvidence(
  query: string,
  workspace: string | undefined,
  since: string | undefined,
  signal: AbortSignal,
) {
  const { stdout } = await execute(
    "ctx",
    [
      "search",
      "--term",
      query,
      "--limit",
      "10",
      "--refresh",
      "off",
      "--format",
      "json",
      ...(workspace ? ["--workspace", workspace] : []),
      ...(since
        ? ["--since", /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00Z` : since]
        : []),
    ],
    { timeout: 30000, maxBuffer: 1024 * 1024, signal },
  );
  const result = z
    .object({
      results: z.array(
        z.object({
          ctx_event_id: z.string(),
          ctx_session_id: z.string(),
          provider: z.string(),
          timestamp: z.string(),
          snippet: z.string(),
        }),
      ),
      result_window: z.object({ more_available: z.boolean() }),
    })
    .parse(JSON.parse(stdout));
  return {
    results: result.results,
    moreAvailable: result.result_window.more_available,
    coverage:
      "Existing CTX index only. Narrow or rephrase queries for more results; history does not establish current state.",
  };
}

export async function readSessionEvent(eventId: string, signal: AbortSignal) {
  const { stdout } = await execute(
    "ctx",
    ["show", "event", eventId, "--window", "2", "--color", "never"],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024, signal },
  );
  return stdout;
}
