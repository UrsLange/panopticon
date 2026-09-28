import type { PeopleContext, Person } from "../../shared/people.js";
import type { Item, ItemFields, ProfileDocument } from "../../shared/schema.js";
import type {
  ProfileActivityWriter,
  ProfileEditingAgent,
  ProfileLearningAgent,
  ProfileLearningInput,
} from "./profile-learning-model.js";

export type Today = { date: string; due: Item[]; suggested: Item[]; waiting: Item[] };
export type ProfileContext = {
  directory: Pick<ProfileDocument, "path" | "title" | "type" | "description">[];
  documents: Pick<ProfileDocument, "path" | "content">[];
};
export type ItemChanges = Partial<ItemFields> &
  Partial<
    Pick<
      Item,
      | "processing"
      | "processingError"
      | "rationale"
      | "sourcePaths"
      | "references"
      | "profilePath"
      | "repositoryId"
      | "clarifications"
    >
  >;

export interface CaptureRecords {
  get(id: string): Item | undefined;
  update(id: string, fields: ItemChanges, revision: number): Item;
}

export interface CaptureStorage extends CaptureRecords, ProfileActivityWriter {
  capture(text: string): Item;
  list(): Item[];
  today(date: string): Today;
  history(id: string): { item: Item; changedAt: string }[];
}

export interface PeopleLookup {
  person(profilePath: string, tenantId: string, email: string): Person | null;
}

export interface ContextQueries extends PeopleLookup {
  peopleContext(
    profilePath: string,
    query: string,
    myEmail: string,
    tenantId: string,
  ): PeopleContext | null;
  search(query: string): Item[];
  today(date: string): Today;
}

export interface ProfileNotes {
  readonly root: string;
  isGit(): boolean;
  documents(): ProfileDocument[];
  incorporate(
    item: Item,
    date: string,
    agent: ProfileEditingAgent,
    guard: () => void,
  ): Promise<{ decision: "apply" | "review"; summary: string; paths: string[] }>;
}

export interface ProfileAccess extends ProfileNotes {
  consolidate(
    input: ProfileLearningInput,
    agent: ProfileLearningAgent,
  ): Promise<{ summary: string; provisionalMemory: string }>;
  refresh(): void;
  initialize(about: string): void;
  edit(path: string, content: string, hash: string): ProfileDocument | undefined;
  create(title: string, type: string, body: string): ProfileDocument | undefined;
  enrichmentPrompt(): string;
}

export type Message = { id: number; role: string; content: string; sources: string[] };
export interface ConversationHistory extends ProfileActivityWriter {
  profileConversation(profileRoot: string): { role: string; content: string }[];
  messages(): Message[];
  addMessage(role: "user" | "assistant", content: string, sources?: string[]): void;
}
