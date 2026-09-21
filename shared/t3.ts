import { z } from "zod";

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
  configured: boolean;
  endpoint: string;
  serverVersion: string;
  defaultModel: T3Model;
};
export type Implementation = {
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
  state: "pending" | "submitted";
  error: string | null;
};
export type ImplementationSummary = Pick<
  Implementation,
  "id" | "revision" | "repositoryId" | "workspaceRoot" | "createdAt" | "state" | "error"
> & { url: string };
export type ImplementationOptions = {
  configured: boolean;
  repositories: { id: string; name: string; path: string }[];
  suggestedRepositoryId: string | null;
  latest: ImplementationSummary | null;
};
