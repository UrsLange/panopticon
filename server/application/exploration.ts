export type ExplorationProgress = {
  phase?: "connecting" | "reading" | "updating" | "validating";
  model?: string;
  sessionId?: string;
  filesRead?: number;
};
export type ExplorationDiagnostic = {
  category: string;
  message: string;
  statusCode?: number;
  exitCode?: string | number;
  signal?: string;
};
export class ExplorationError extends Error {
  constructor(readonly diagnostic: ExplorationDiagnostic) {
    super(diagnostic.message);
  }
}
export type ProjectExploration = {
  repository: string;
  document: string;
  model: string;
  onProgress?: (progress: ExplorationProgress) => void;
};
