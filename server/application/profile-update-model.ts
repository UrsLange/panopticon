import { z } from "zod";

export const profileUpdateSchema = z.object({
  decision: z.enum(["apply", "review"]),
  summary: z.string(),
  paths: z.array(z.string()),
  changes: z.array(z.object({ path: z.string(), content: z.string() })),
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
