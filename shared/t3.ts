import { z } from "zod";

export const t3ImplementationSchema = z.object({
  autoStart: z.boolean().optional(),
  model: z.object({
    instanceId: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(200),
  }),
  workspaceMode: z.enum(["worktree", "checkout"]),
  runtimeMode: z.enum(["full-access", "approval-required", "auto-accept-edits"]),
});
export const t3OverridesSchema = t3ImplementationSchema.partial();
export type T3ImplementationSettings = z.infer<typeof t3ImplementationSchema>;
export type T3Overrides = z.infer<typeof t3OverridesSchema>;

export const t3ConnectionSchema = z.object({
  endpoint: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  }, "Use the T3 Code HTTP or HTTPS endpoint without a path or credentials."),
  credential: z.string().trim().max(8000).optional(),
  instanceId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
});
export type T3ConnectionInput = z.infer<typeof t3ConnectionSchema>;
export type T3Model = { instanceId: string; model: string; options?: Record<string, unknown> };
export type T3Connection = {
  endpoint: string;
  accessToken: string;
  environmentId: string;
  serverVersion: string;
  defaultModel: T3Model;
};
export type T3Status = {
  autoStart?: boolean;
  configured: boolean;
  endpoint: string;
  serverVersion: string;
  defaultModel: T3Model;
};
export type LocalMerge = {
  branch: string;
  mainBranch: string;
  head: string;
  mainHead: string;
  merged: boolean;
  dirty: boolean;
};
export type ImplementationProgress = {
  turnState: "running" | "interrupted" | "completed" | "error" | null;
  checkedAt: string;
  error: string | null;
  localMerge?: LocalMerge;
};
export type Implementation = {
  autoStarted?: boolean;
  id: string;
  itemId: string;
  revision: number;
  profileRoot: string;
  endpoint: string;
  environmentId: string;
  repositoryId: string;
  workspaceRoot: string;
  baseBranch: string;
  projectId: string;
  title: string;
  prompt: string;
  model: T3Model;
  createdAt: string;
  workspaceMode?: T3ImplementationSettings["workspaceMode"];
  runtimeMode?: T3ImplementationSettings["runtimeMode"];
  state: "pending" | "submitted";
  error: string | null;
  mergedCommit?: string;
  completionReview?: { head: string; reason: string };
  progress?: ImplementationProgress;
};
export type CompletionReview = {
  itemId: string;
  implementationId: string;
  revision: number;
  title: string;
  head: string;
  reason: string;
};
export type ImplementationSummary = Pick<
  Implementation,
  | "id"
  | "revision"
  | "repositoryId"
  | "workspaceRoot"
  | "createdAt"
  | "state"
  | "error"
  | "progress"
  | "workspaceMode"
> & { url: string; taskChanged: boolean };
export type ImplementationOptions = {
  autoStart?: boolean;
  configured: boolean;
  repositories: { id: string; name: string; path: string }[];
  suggestedRepositoryId: string | null;
  latest: ImplementationSummary | null;
};
