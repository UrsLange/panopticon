export type ProfileLearningStatus = {
  running: boolean;
  lastAttempt: string | null;
  lastSuccess: string | null;
  summary: string;
  error: string | null;
};
