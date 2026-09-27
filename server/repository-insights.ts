import { z } from "zod";
import type { ProjectInsights } from "../shared/projects.js";
import type { GitHubApi } from "./github-api.js";

const workflow = z.object({ id: z.number().int(), name: z.string(), state: z.string() });
const workflowRun = z.object({
  id: z.number().int(),
  workflow_id: z.number().int(),
  html_url: z.string().url(),
  head_branch: z.string().nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const review = z.object({ number: z.number(), title: z.string(), html_url: z.string().url() });
const finding = review.omit({ title: true }).extend({
  security_advisory: z.object({ summary: z.string(), severity: z.string() }),
});
const minute = 60000;

export type InsightOptions = {
  force?: boolean;
  previous?: ProjectInsights | null;
  onUpdate?(insights: ProjectInsights): void;
};

export async function repositoryInsights(
  url: string,
  api: GitHubApi,
  options: InsightOptions = {},
): Promise<ProjectInsights> {
  const result: ProjectInsights = options.previous
    ? structuredClone(options.previous)
    : {
        checkedAt: "",
        reviews: [],
        findings: [],
        reviewError: null,
        securityErrors: [],
      };
  const parsed = new URL(url);
  const repo = parsed.pathname.slice(1);
  if (parsed.hostname !== "github.com" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    result.reviewError = "Review integration is available for github.com repositories.";
    result.securityErrors = ["Security integration is available for github.com repositories."];
    result.pipelines = {
      branch: null,
      failures: [],
      pending: 0,
      checked: 0,
      error: "Pipeline integration is available for github.com repositories.",
    };
    return result;
  }
  const valid = (url: string) => url.startsWith(`https://github.com/${repo}/`);
  const publish = () => {
    const dates = [
      result.reviewsCheckedAt,
      result.securityCheckedAt,
      result.pipelines?.checkedAt,
    ].filter((date): date is string => !!date);
    result.checkedAt = dates.sort()[0] ?? "";
    options.onUpdate?.(structuredClone(result));
  };
  await Promise.all([
    (async () => {
      try {
        const [metadataResult, pagesResult] = await Promise.allSettled([
          api.get(`repos/${repo}`, 60 * minute, options.force),
          api.pages(`repos/${repo}/actions/workflows?per_page=100`, 30 * minute, options.force),
        ]);
        if (metadataResult.status === "rejected") throw metadataResult.reason;
        if (pagesResult.status === "rejected") throw pagesResult.reason;
        const metadata = metadataResult.value;
        const pages = pagesResult.value;
        const branch = z
          .object({ default_branch: z.string().min(1) })
          .parse(metadata.body).default_branch;
        const workflows = pages
          .flatMap((page) => z.object({ workflows: z.array(workflow) }).parse(page.body).workflows)
          .filter((entry) => entry.state === "active");
        const ttl = result.pipelines?.pending ? 30_000 : 2 * minute;
        const recent = await api.get(
          `repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
          ttl,
          options.force,
        );
        const runs = z
          .object({ workflow_runs: z.array(workflowRun) })
          .parse(recent.body).workflow_runs;
        const pipelines: NonNullable<ProjectInsights["pipelines"]> = {
          branch,
          failures: [],
          pending: 0,
          checked: 0,
          error: null,
          checkedAt: new Date(recent.checkedAt).toISOString(),
        };
        for (const entry of workflows) {
          try {
            let latest = runs.find(
              (run) => run.workflow_id === entry.id && run.head_branch === branch,
            );
            if (!latest) {
              const page = await api.get(
                `repos/${repo}/actions/workflows/${entry.id}/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
                ttl,
                options.force,
              );
              latest = z.object({ workflow_runs: z.array(workflowRun) }).parse(page.body)
                .workflow_runs[0];
              pipelines.checkedAt = new Date(
                Math.min(recent.checkedAt, page.checkedAt, Date.parse(pipelines.checkedAt ?? "")),
              ).toISOString();
            }
            pipelines.checked++;
            if (!latest || latest.head_branch !== branch) continue;
            if (latest.status !== "completed") pipelines.pending++;
            else if (
              ["failure", "timed_out", "startup_failure"].includes(latest.conclusion ?? "") &&
              valid(latest.html_url)
            )
              pipelines.failures.push({
                number: latest.id,
                title: entry.name,
                url: latest.html_url,
              });
          } catch {
            pipelines.error =
              "Some pipeline checks are unavailable; previous findings are retained. Checks will retry automatically.";
            const previous = result.pipelines;
            if (previous?.branch === branch)
              pipelines.failures.push(
                ...previous.failures.filter((failure) => failure.title === entry.name),
              );
          }
        }
        result.pipelines = pipelines;
      } catch (error) {
        result.pipelines = {
          branch: null,
          failures: [],
          pending: 0,
          checked: 0,
          ...result.pipelines,
          error: `Cannot check pipelines. ${(error as Error).message}`,
        };
      }
      publish();
    })(),
    (async () => {
      try {
        const pages = await api.pages(
          "search/issues?q=is%3Apr%20is%3Aopen%20review-requested%3A%40me&per_page=100",
          2 * minute,
          options.force,
        );
        const responses = pages.map((page) =>
          z
            .object({
              items: z.array(review),
              total_count: z.number(),
              incomplete_results: z.boolean(),
            })
            .parse(page.body),
        );
        const reviews = responses
          .flatMap((page) => page.items)
          .filter((entry) => valid(entry.html_url))
          .map((entry) => ({ number: entry.number, title: entry.title, url: entry.html_url }));
        result.reviewError = responses.some(
          (page) => page.incomplete_results || page.total_count > 1000,
        )
          ? "GitHub returned an incomplete review search. Open GitHub for the complete list."
          : null;
        result.reviews = result.reviewError
          ? [
              ...new Map(
                [...result.reviews, ...reviews].map((entry) => [entry.url, entry]),
              ).values(),
            ]
          : reviews;
        result.reviewsCheckedAt = new Date(
          Math.min(...pages.map((page) => page.checkedAt)),
        ).toISOString();
      } catch (error) {
        result.reviewError = `Cannot read requested reviews. ${(error as Error).message}`;
      }
      publish();
    })(),
    (async () => {
      try {
        const pages = await api.pages(
          `repos/${repo}/dependabot/alerts?state=open&per_page=100`,
          30 * minute,
          options.force,
        );
        result.findings = pages
          .flatMap((page) => z.array(finding).parse(page.body))
          .filter((entry) => valid(entry.html_url))
          .map((entry) => ({
            number: entry.number,
            title: entry.security_advisory.summary,
            url: entry.html_url,
            severity: entry.security_advisory.severity,
            source: "Dependabot" as const,
          }));
        result.securityErrors = [];
        result.securityCheckedAt = new Date(
          Math.min(...pages.map((page) => page.checkedAt)),
        ).toISOString();
      } catch (error) {
        result.securityErrors = [`Dependabot unavailable. ${(error as Error).message}`];
      }
      publish();
    })(),
  ]);
  return result;
}
