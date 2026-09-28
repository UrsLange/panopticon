import type { PeopleContext } from "../../shared/people.js";
import type { AssistantReply, EntityReference, Item } from "../../shared/schema.js";
import type { ReferenceCandidate } from "./aliases.js";
import type { ProfileContext, Today } from "./ports.js";
import type { ProfileEditingAgent, ProfileLearningAgent } from "./profile-learning-model.js";

export type AssistantContext = {
  capture?: Item;
  linkedCaptures?: Item[];
  referencesOnly?: boolean;
  previousRefinement?: Pick<Item, "prompt" | "clarifications" | "sourcePaths">;
  candidates: ReferenceCandidate[];
  references: EntityReference[];
  people: PeopleContext | null;
  today: string;
  profile: ProfileContext;
  related: Item[];
  commitments: Today;
};

export interface Assistant {
  interpret(text: string, context: AssistantContext, tools: RefinementTool[]): Promise<void>;
  updateProfile: ProfileEditingAgent;
  consolidateProfile: ProfileLearningAgent;
  ask(
    text: string,
    context: AssistantContext,
    history: { role: string; content: string }[],
    sessionEvidence: string,
  ): Promise<AssistantReply>;
}

export type RefinementTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(input: unknown, signal: AbortSignal): Promise<{ data: unknown; sources: string[] }>;
};

export function contextSources(context: AssistantContext) {
  return [
    ...(context.capture ? [context.capture.id] : []),
    ...(context.previousRefinement?.sourcePaths ?? []),
    ...context.profile.documents.map((doc) => doc.path),
    ...context.candidates.map((candidate) => candidate.source),
    ...context.references.map((reference) => reference.source),
    ...(context.people ? [context.people.source] : []),
    ...context.related.map((item) => item.id),
    ...context.commitments.due.map((item) => item.id),
    ...context.commitments.suggested.map((item) => item.id),
    ...context.commitments.waiting.map((item) => item.id),
  ];
}
