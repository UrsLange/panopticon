import { z } from "zod";
import type { PublicEntraConfig } from "./people.js";

export const kindSchema = z.enum(["unclassified", "idea", "note", "commitment"]);
export const statusSchema = z.enum(["open", "waiting", "done", "archived"]);
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
  dueDate: dateSchema.nullable(),
  priority: z.enum(["normal", "high"]),
  relatedId: z.string().nullable(),
});
export const itemPatchSchema = itemFieldsSchema.partial();
export type ItemFields = z.infer<typeof itemFieldsSchema>;
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

export const interpretationSchema = z.object({
  prompt: z.string().max(30000),
  sources: z.array(z.string()),
  referenceIds: z.array(z.string()),
  title: z.string(),
  kind: z.enum(["idea", "note", "commitment"]),
  project: z.string(),
  dueDate: z.string().nullable(),
  priority: z.enum(["normal", "high"]),
  relatedId: z.string().nullable(),
  rationale: z.string(),
  needsClarification: z.boolean(),
  updateProfile: z.boolean(),
});
export type Interpretation = z.infer<typeof interpretationSchema>;
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
