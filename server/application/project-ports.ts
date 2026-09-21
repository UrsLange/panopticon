import type { ProfileDocument } from "../../shared/schema.js";
import type { ExplorationProgress } from "./exploration.js";
import type { ScanStatus } from "./projects.js";

export interface DiscoverySettings {
  readonly projectRoots: string[];
  readonly profilePath: string;
  readonly timezone: string;
  connection(): { model: string };
}

export type RepositoryIdentity = { root: string; name: string; path: string; id: string };

export interface DiscoveryProfile {
  readonly root: string;
  isGit(): boolean;
  documents(): ProfileDocument[];
  refresh(): void;
  add(path: string, content: string): void;
  apply(before: ProfileDocument, content: string, saved: () => void): void;
  markMissing(before: ProfileDocument, content: string): void;
}

export interface DiscoveryPorts {
  loadStatus(): Partial<ScanStatus>;
  saveStatus(status: ScanStatus): void;
  profileExists(root: string): boolean;
  profile(root: string): DiscoveryProfile;
  repositories(root: string): Promise<RepositoryIdentity[]>;
  identity(root: string, name: string): RepositoryIdentity;
  isProfileRepository(repository: string, profile: string): Promise<boolean>;
  snapshot(repository: string): Promise<{ fingerprint: string }>;
  explore(request: {
    repository: string;
    document: ProfileDocument;
    model: string;
    onProgress: (progress: ExplorationProgress) => void;
  }): Promise<string>;
}
