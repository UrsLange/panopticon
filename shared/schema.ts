import { z } from "zod";
import type { PublicEntraConfig } from "./people.js";

export const kindSchema = z.enum(["unclassified", "idea", "note", "commitment"]);
export const statusSchema = z.enum([
  "open",
  "in_progress",
  "in_review",
  "waiting",
  "done",
  "archived",
]);
export const statusLabels = {
  open: "Not started",
  in_progress: "In progress",
  in_review: "Ready for review",
  waiting: "Waiting",
  done: "Done",
  archived: "Archived",
};
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Use a valid calendar date");

export const itemFieldsSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().max(30000),
  prompt: z.string().max(30000),
  kind: kindSchema,
  status: statusSchema,
  project: z.string().max(200),
  noProject: z.boolean(),
  execution: z.enum(["manual", "implementation"]),
  dueDate: dateSchema.nullable(),
  priority: z.enum(["normal", "high"]),
  relatedId: z.string().nullable(),
});
export const itemPatchSchema = itemFieldsSchema.partial();
export type ItemFields = z.infer<typeof itemFieldsSchema>;
export function projectLabel(item: Pick<ItemFields, "project" | "noProject">) {
  return item.noProject ? "No project" : item.project || "Unassigned";
}
export type EntityReference = {
  start: number;
  end: number;
  mention: string;
  kind: "person" | "project" | "repository";
  target: string;
  label: string;
  source: string;
};

export function annotatedText(text: string, references: EntityReference[]) {
  let result = text;
  for (const reference of [...references].sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, reference.end)} [${reference.label}]${result.slice(reference.end)}`;
  }
  return result;
}

export type Item = ItemFields & {
  parentId: string | null;
  clarifications: Clarification[];
  repositoryId: string | null;
  references: EntityReference[];
  id: string;
  original: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  processing: "pending" | "review" | "ready";
  processingError: string | null;
  rationale: string;
  sourcePaths: string[];
  profilePath: string | null;
};

export type Capture = Item & {
  refinement: "running" | "failed" | "paused" | "review" | "ready";
};

export type Clarification = {
  id: string;
  question: string;
  answer: string;
  resolved: boolean;
};

export const clarificationAnswersSchema = z.object({
  revision: z.number().int().nonnegative(),
  answers: z
    .array(z.object({ id: z.string().min(1), answer: z.string().trim().max(5000) }))
    .max(20),
});

export const refinementSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1).max(300),
  kind: z.enum(["idea", "note", "commitment"]),
  execution: z.enum(["manual", "implementation"]),
  project: z.string().max(200),
  noProject: z.boolean(),
  dueDate: dateSchema.nullable(),
  priority: z.enum(["normal", "high"]),
  relatedId: z.string().nullable(),
  prompt: z.string().trim().min(1).max(30000),
  sources: z.array(z.string()),
  referenceIds: z.array(z.string()),
  clarificationQuestions: z.array(z.string().trim().min(1)),
});
export type Refinement = z.infer<typeof refinementSchema>;
export type ProfileDocument = {
  path: string;
  title: string;
  type: string;
  description: string;
  content: string;
  hash: string;
};
export type AssistantReply = { answer: string; sources: string[] };
export type Settings = {
  credentialSources: {
    source: "saved" | "environment" | "file";
    endpoint: string;
    path?: string;
  }[];
  entra: PublicEntraConfig;
  aiConfigured: boolean;
  model: string;
  provider: string;
  profilePath: string;
  profileGit: boolean;
  ctxAvailable: boolean;
  timezone: string;
  baseURL: string;
  modelReady: boolean;
  profileReady: boolean;
  projectRoots: string[];
};

export function dayInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
