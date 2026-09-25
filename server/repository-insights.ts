import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ProjectInsights, SecurityFinding } from "../shared/projects.js";

const execute = promisify(execFile);
const link = z.object({ number: z.number(), title: z.string(), url: z.string().url() });
const finding = link.extend({ severity: z.string() });

export async function repositoryInsights(
  url: string,
  run: (args: string[]) => Promise<string> = async (args) =>
    (
      await execute("gh", args, {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      })
    ).stdout,
): Promise<ProjectInsights> {
  const result: ProjectInsights = {
    checkedAt: new Date().toISOString(),
    reviews: [],
    findings: [],
    reviewError: null,
    securityErrors: [],
  };
  const parsed = new URL(url);
  const repo = parsed.pathname.slice(1);
  if (parsed.hostname !== "github.com" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    result.reviewError =
      "Review integration is available for github.com repositories. Open this repository at its host.";
    result.securityErrors = ["Security integration is available for github.com repositories."];
    return result;
  }
  const valid = (value: { url: string }) => value.url.startsWith(`https://github.com/${repo}/`);
  await Promise.all([
    (async () => {
      try {
        const output = await run([
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--search",
          "review-requested:@me",
          "--limit",
          "100",
          "--json",
          "number,title,url",
        ]);
        result.reviews = z.array(link).parse(JSON.parse(output)).filter(valid);
        if (result.reviews.length === 100)
          result.reviewError =
            "Showing the first 100 requested reviews. Open GitHub for the complete list.";
      } catch {
        result.reviewError =
          "Cannot read requested reviews. Install GitHub CLI and sign in with gh auth login, then refresh.";
      }
    })(),
    ...(
      [
        [
          "Dependabot",
          "dependabot",
          "{number,title: .security_advisory.summary,url:.html_url,severity:.security_advisory.severity}",
        ],
        [
          "Code scanning",
          "code-scanning",
          '{number,title:.rule.description,url:.html_url,severity:(.rule.security_severity_level // .rule.severity // "unknown")}',
        ],
        [
          "Secret scanning",
          "secret-scanning",
          '{number,title:.secret_type_display_name,url:.html_url,severity:"high"}',
        ],
      ] as const
    ).map(async ([source, endpoint, projection]) => {
      try {
        const output = await run([
          "api",
          "--paginate",
          "--slurp",
          `repos/${repo}/${endpoint}/alerts?state=open&per_page=100`,
          "--jq",
          `.[][] | ${projection}`,
        ]);
        const entries = output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => finding.parse(JSON.parse(line)));
        result.findings.push(
          ...entries.filter(valid).map((entry) => ({ ...entry, source }) as SecurityFinding),
        );
      } catch {
        result.securityErrors.push(
          `${source} unavailable. Check that it is enabled and your GitHub account can read its alerts.`,
        );
      }
    }),
  ]);
  return result;
}
