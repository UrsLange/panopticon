import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ProjectInsights } from "../shared/projects.js";

const execute = promisify(execFile);
const link = z.object({ number: z.number(), title: z.string(), url: z.string().url() });
const finding = link.extend({ severity: z.string() });
const workflow = z.object({ id: z.number().int(), name: z.string(), state: z.string() });
const workflowRun = z.object({
  id: z.number().int(),
  html_url: z.string().url(),
  head_branch: z.string().nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
});

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
  const pipelines: NonNullable<ProjectInsights["pipelines"]> = {
    branch: null,
    failures: [],
    pending: 0,
    checked: 0,
    error: null,
  };
  const result: ProjectInsights = {
    checkedAt: new Date().toISOString(),
    reviews: [],
    findings: [],
    reviewError: null,
    securityErrors: [],
    pipelines,
  };
  const parsed = new URL(url);
  const repo = parsed.pathname.slice(1);
  if (parsed.hostname !== "github.com" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    result.reviewError =
      "Review integration is available for github.com repositories. Open this repository at its host.";
    result.securityErrors = ["Security integration is available for github.com repositories."];
    pipelines.error = "Pipeline integration is available for github.com repositories.";
    return result;
  }
  const valid = (value: { url: string }) => value.url.startsWith(`https://github.com/${repo}/`);
  await Promise.all([
    (async () => {
      try {
        pipelines.branch = z
          .string()
          .min(1)
          .parse(
            JSON.parse(await run(["api", `repos/${repo}`, "--jq", "{default_branch}"]))
              .default_branch,
          );
        const output = await run([
          "api",
          "--paginate",
          `repos/${repo}/actions/workflows?per_page=100`,
          "--jq",
          ".workflows[] | {id,name,state}",
        ]);
        const workflows = output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => workflow.parse(JSON.parse(line)));
        for (const entry of workflows.filter((item) => item.state === "active")) {
          try {
            const runs = z
              .array(workflowRun)
              .parse(
                JSON.parse(
                  await run([
                    "api",
                    `repos/${repo}/actions/workflows/${entry.id}/runs?branch=${encodeURIComponent(pipelines.branch)}&per_page=1`,
                    "--jq",
                    ".workflow_runs | map({id,html_url,head_branch,status,conclusion})",
                  ]),
                ),
              );
            pipelines.checked++;
            const latest = runs[0];
            if (!latest || latest.head_branch !== pipelines.branch) continue;
            if (latest.status !== "completed") pipelines.pending++;
            else if (
              ["failure", "timed_out", "startup_failure"].includes(latest.conclusion ?? "") &&
              valid({ url: latest.html_url })
            )
              pipelines.failures.push({
                number: latest.id,
                title: entry.name,
                url: latest.html_url,
              });
          } catch {
            pipelines.error =
              "Some pipeline checks are unavailable. Check GitHub Actions access, then refresh.";
          }
        }
      } catch {
        pipelines.error =
          "Cannot check pipelines. Check GitHub Actions access and your GitHub CLI sign-in, then refresh.";
      }
    })(),
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
    (async () => {
      try {
        const output = await run([
          "api",
          "--paginate",
          `repos/${repo}/dependabot/alerts?state=open&per_page=100`,
          "--jq",
          ".[] | {number,title:.security_advisory.summary,url:.html_url,severity:.security_advisory.severity}",
        ]);
        const entries = output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => finding.parse(JSON.parse(line)));
        result.findings = entries
          .filter(valid)
          .map((entry) => ({ ...entry, source: "Dependabot" }));
      } catch {
        result.securityErrors.push(
          "Dependabot unavailable. Check that it is enabled and your GitHub account can read its alerts.",
        );
      }
    })(),
  ]);
  return result;
}
