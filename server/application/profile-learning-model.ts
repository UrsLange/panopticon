import { z } from "zod";
import { profileUpdateSchema } from "./profile-update-model.js";

export const profileConsolidationSchema = profileUpdateSchema.omit({ decision: true }).extend({
  provisionalMemory: z.string().max(12000),
});
export type ProfileConsolidation = z.infer<typeof profileConsolidationSchema>;
export type ProfileActivityKind =
  | "capture"
  | "edit"
  | "clarification"
  | "conversation"
  | "implementation";
export type ProfileActivity = {
  id: number;
  kind: ProfileActivityKind;
  content: string;
  createdAt: string;
};
export type ProfileLearningState = {
  cursor: number;
  completedDay: string | null;
  lastAttempt: string | null;
  lastSuccess: string | null;
  summary: string;
  provisionalMemory: string;
  error: string | null;
};
export interface ProfileActivityWriter {
  recordProfileActivity(profileRoot: string, kind: ProfileActivityKind, evidence: unknown): void;
}
export interface ProfileLearningRecords extends ProfileActivityWriter {
  profileActivity(profileRoot: string, after: number): ProfileActivity[];
  profileLearningState(profileRoot: string): ProfileLearningState | undefined;
  saveProfileLearningState(profileRoot: string, state: ProfileLearningState): void;
}
