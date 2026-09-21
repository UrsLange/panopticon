import type { EntraConfig, PeopleSyncStatus, Person } from "../../shared/people.js";

export type PeopleSyncState = Omit<PeopleSyncStatus, "running"> & { profilePath: string };
export interface PeopleSyncSettings {
  readonly profilePath: string;
  readonly profileReady: boolean;
  entraCredentials(): EntraConfig | undefined;
}
export interface PeopleDirectory {
  peopleSyncedAt(root: string, tenant: string): string | null;
  replacePeople(root: string, tenant: string, people: Person[], syncedAt: string): void;
}
export interface PeopleSyncPorts {
  loadStatus(): Partial<PeopleSyncState>;
  saveStatus(state: PeopleSyncState): void;
  loadPeople(
    config: EntraConfig,
  ): Promise<{ people: Person[]; skipped: number; warnings?: string[] }>;
  migrate(
    root: string,
    selectedTenant: string | undefined,
    imported: (syncedAt: string | null, count: number) => void,
  ): void;
}
