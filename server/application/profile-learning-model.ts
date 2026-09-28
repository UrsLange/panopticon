export type ProfileLearningInput = {
  activity: ProfileActivity[];
  provisionalMemory: string;
  date: string;
  timezone: string;
};
export type ProfileLearningWorkspace = {
  profileRoot: string;
  activityPath: string;
  provisionalMemoryPath: string;
};
export type ProfileLearningTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(input: unknown): unknown | Promise<unknown>;
};
export type ProfileLearningAgent = (
  workspace: ProfileLearningWorkspace,
  tools: ProfileLearningTool[],
) => Promise<string>;
export type ProfileEditingWorkspace = {
  profileRoot: string;
  artifactPaths: Record<string, string>;
};
export type ProfileEditingAgent = (
  workspace: ProfileEditingWorkspace,
  tools: ProfileLearningTool[],
) => Promise<string>;
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
