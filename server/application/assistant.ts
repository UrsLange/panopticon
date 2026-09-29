import type { PeopleContext } from "../../shared/people.js";
import type { AssistantReply, EntityReference, Item } from "../../shared/schema.js";
import type { ReferenceCandidate } from "./aliases.js";
import type { ProfileContext, Today } from "./ports.js";
import type { ProfileEditingAgent, ProfileLearningAgent } from "./profile-learning-model.js";

export type AssistantContext = {
  candidates: ReferenceCandidate[];
  references: EntityReference[];
  people: PeopleContext | null;
  today: string;
  profile: ProfileContext;
  related: Item[];
  commitments: Today;
};

export type RefinementContext = {
  today: string;
  capture: Item;
  linkedCaptures: Pick<
    Item,
    "id" | "original" | "title" | "kind" | "status" | "processing" | "parentId"
  >[];
  referencesOnly: boolean;
};

export interface Assistant {
  interpret(text: string, context: RefinementContext, tools: RefinementTool[]): Promise<void>;
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
  readOnly?: boolean;
  description: string;
  parameters: Record<string, unknown>;
  execute(input: unknown, signal: AbortSignal): Promise<{ data: unknown; sources: string[] }>;
};
