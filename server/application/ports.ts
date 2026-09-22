import type { PeopleContext, Person } from "../../shared/people.js";
import type { Item, ItemFields, ProfileDocument } from "../../shared/schema.js";
import type { ProfileUpdate } from "./profile-update-model.js";

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
    >
  >;

export interface CaptureRecords {
  get(id: string): Item | undefined;
  update(id: string, fields: ItemChanges, revision: number): Item;
}

export interface CaptureStorage extends CaptureRecords {
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
  incorporate(snapshot: ProfileDocument[], update: ProfileUpdate): void;
}

export interface ProfileAccess extends ProfileNotes {
  refresh(): void;
  initialize(about: string): void;
  edit(path: string, content: string, hash: string): ProfileDocument | undefined;
  create(title: string, type: string, body: string): ProfileDocument | undefined;
  enrichmentPrompt(): string;
}

export type Message = { id: number; role: string; content: string; sources: string[] };
export interface ConversationHistory {
  messages(): Message[];
  addMessage(role: "user" | "assistant", content: string, sources?: string[]): void;
}
