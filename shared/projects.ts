import { z } from "zod";
import type { T3Overrides } from "./t3.js";

export type ProjectGit = {
  branch: string | null;
  head: string;
  upstream: string | null;
  remote: string | null;
  repositoryUrl: string | null;
  defaultBranch: string | null;
  dirty: boolean;
  conflicts: boolean;
  operation: boolean;
  ahead: number;
  behind: number;
  version: string;
};

export type RepositoryLink = { title: string; url: string; number: number };
export type SecurityFinding = RepositoryLink & {
  source: "Dependabot";
  severity: string;
};
export type ProjectInsights = {
  checkedAt: string;
  reviewsCheckedAt?: string;
  securityCheckedAt?: string;
  reviews: RepositoryLink[];
  findings: SecurityFinding[];
  reviewError: string | null;
  securityErrors: string[];
  pipelines?: {
    checkedAt?: string;
    branch: string | null;
    failures: RepositoryLink[];
    pending: number;
    checked: number;
    error: string | null;
  };
};

export type Project = {
  id: string;
  profileRoot: string;
  root: string;
  path: string;
  name: string;
  document: string | null;
  documentSource: "discovery" | "manual";
  returnToDefault: boolean;
  hidden: boolean;
  t3?: T3Overrides;
  git: ProjectGit | null;
  insights: ProjectInsights | null;
  checkedAt: string | null;
  remoteCheckedAt: string | null;
  remoteAttemptedAt?: string;
  error: string | null;
  remoteError: string | null;
};

export type ProjectWorkspace = {
  projects: Project[];
  refreshing: boolean;
  refreshingIds: string[];
  errors: string[];
};
export type ProjectChanges = {
  files: { path: string; status: string }[];
  diff: string;
  commits: { direction: "incoming" | "outgoing"; hash: string; subject: string }[];
};
export type ProjectDetail = { project: Project; changes: ProjectChanges };

export const projectActionSchema = z.object({
  action: z.enum(["pull", "push", "commit", "discard", "switch", "merge"]),
  version: z.string().min(1),
  message: z.string().trim().min(1).max(2000).optional(),
  files: z.array(z.string().min(1).max(4096)).min(1).max(5000).optional(),
});
export type ProjectAction = z.infer<typeof projectActionSchema>;
export type ProjectAttention =
  | "local"
  | "incoming"
  | "branch"
  | "reviews"
  | "security"
  | "pipelines";
export const projectAttentionOrder: ProjectAttention[] = [
  "local",
  "incoming",
  "branch",
  "reviews",
  "security",
  "pipelines",
];

export function projectAttention(project: Project): Record<ProjectAttention, string | null> {
  const { git, insights } = project;
  return {
    local: project.error
      ? project.error
      : git && !git.branch
        ? "Check out a branch"
        : git?.conflicts || git?.operation
          ? "Resolve the Git operation"
          : git?.dirty
            ? "Review and commit local changes"
            : git?.ahead
              ? "Push local commits"
              : git?.remote && git.head && !git.upstream
                ? "Publish this branch"
                : null,
    incoming: project.remoteError
      ? "Retry remote check"
      : git?.remote && !project.remoteCheckedAt
        ? "Check remote changes"
        : git?.behind
          ? git.dirty
            ? "Save local changes before pulling"
            : git.ahead
              ? "Integrate diverged changes"
              : "Pull updates"
          : null,
    branch:
      project.returnToDefault && git && git.branch !== git.defaultBranch
        ? git.defaultBranch
          ? `Return to ${git.defaultBranch}`
          : "Identify the default branch"
        : null,
    reviews: insights?.reviews.length
      ? "Open requested reviews"
      : insights?.reviewError
        ? "Check review access"
        : null,
    security: insights?.findings.length ? "Review Dependabot alerts" : null,
    pipelines: insights?.pipelines?.failures.length
      ? `Open failing pipelines on ${insights.pipelines.branch}`
      : null,
  };
}

export function projectNeedsAttention(project: Project) {
  return Object.values(projectAttention(project)).some(Boolean);
}
