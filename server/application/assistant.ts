import type { PeopleContext } from "../../shared/people.js";
import type { AssistantReply, EntityReference, Interpretation, Item } from "../../shared/schema.js";
import type { ReferenceCandidate } from "./aliases.js";
import type { ProfileContext, Today } from "./ports.js";
import type { ProfileEditingAgent, ProfileLearningAgent } from "./profile-learning-model.js";

export type AssistantContext = {
  previousRefinement?: Pick<Item, "prompt" | "rationale" | "clarifications" | "sourcePaths">;
  candidates: ReferenceCandidate[];
  references: EntityReference[];
  people: PeopleContext | null;
  today: string;
  profile: ProfileContext;
  related: Item[];
  commitments: Today;
};

export interface Assistant {
  interpret(text: string, context: AssistantContext): Promise<Interpretation>;
  updateProfile: ProfileEditingAgent;
  consolidateProfile: ProfileLearningAgent;
  ask(
    text: string,
    context: AssistantContext,
    history: { role: string; content: string }[],
    sessionEvidence: string,
  ): Promise<AssistantReply>;
}
