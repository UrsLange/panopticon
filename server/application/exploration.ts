import type { ProfileDocument } from "../../shared/schema.js";

export type ExplorationProgress = {
  phase?: "connecting" | "reading" | "updating" | "validating";
  model?: string;
  responseId?: string;
  filesRead?: number;
};
export type ExplorationDiagnostic = {
  category: string;
  message: string;
  statusCode?: number;
};
export class ExplorationError extends Error {
  constructor(readonly diagnostic: ExplorationDiagnostic) {
    super(diagnostic.message);
  }
}
export type ProjectExploration = {
  repository: string;
  document: ProfileDocument;
  model: string;
  onProgress?: (progress: ExplorationProgress) => void;
};
