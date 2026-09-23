import type { EntraConfig, PublicEntraConfig } from "../../shared/people.js";
import type { Settings } from "../../shared/schema.js";
import type { Connection } from "./connection.js";
import { ApplicationError } from "./errors.js";
import type { PeopleSync } from "./people-sync.js";
import type { ProfileAccess } from "./ports.js";
import type { ProjectScanner } from "./projects.js";

export type ProfileSelection = {
  mode: "create" | "connect";
  path: string;
  timezone: string;
  name: string;
  role: string;
  company: string;
  team: string;
  teamPurpose: string;
};
export interface PreferenceStorage {
  view(): {
    credentialSources: Settings["credentialSources"];
    entra: PublicEntraConfig;
    modelReady: boolean;
    profileReady: boolean;
    connection: Connection;
    projectRoots: string[];
    timezone: string;
  };
  saveEntra(input: EntraConfig): void;
  saveProjectRoots(roots: string[]): void;
  saveProfile(path: string, timezone: string): void;
}
export interface ModelConnection {
  discover(input?: Connection): Promise<string[]>;
  connect(input: Connection): Promise<void>;
}

export function createPreferences({
  storage,
  models,
  getProfile,
  openProfile,
  selectProfile,
  scanner,
  peopleSync,
  capturesBusy,
  assistantConfigured,
  ctxAvailable,
  timezone,
  directoryPath,
  detectTenant,
  chooseDirectory,
}: {
  storage: PreferenceStorage;
  models: ModelConnection;
  getProfile: () => ProfileAccess;
  openProfile: (path: string) => ProfileAccess;
  selectProfile: (profile: ProfileAccess) => void;
  scanner: ProjectScanner;
  peopleSync: PeopleSync;
  capturesBusy: () => boolean;
  assistantConfigured: boolean;
  ctxAvailable: () => boolean;
  timezone: () => string;
  directoryPath: (path: string) => Promise<string>;
  detectTenant: () => Promise<string | null>;
  chooseDirectory: () => Promise<string | null>;
}) {
  const status = (): Settings => {
    const saved = storage.view();
    const profile = getProfile();
    return {
      credentialSources: saved.credentialSources,
      entra: saved.entra,
      aiConfigured:
        assistantConfigured ||
        (saved.modelReady &&
          saved.credentialSources.some(
            (source) =>
              source.endpoint.replace(/\/+$/, "") === saved.connection.baseURL.replace(/\/+$/, ""),
          )),
      model: saved.connection.model,
      provider: new URL(saved.connection.baseURL).origin,
      baseURL: saved.connection.baseURL,
      modelReady: saved.modelReady,
      profileReady:
        (saved.profileReady || profile.documents().some((doc) => doc.type !== "Index")) &&
        profile.isGit(),
      profilePath: profile.root,
      profileGit: profile.isGit(),
      projectRoots: saved.projectRoots,
      ctxAvailable: ctxAvailable(),
      timezone: timezone(),
    };
  };
  const checkProfileChange = () => {
    if (capturesBusy())
      throw new ApplicationError(
        "conflict",
        "Wait for capture processing and profile updates before changing profiles.",
      );
    if (peopleSync.status().running)
      throw new ApplicationError(
        "conflict",
        "Wait for the active people sync before changing profiles.",
      );
    if (scanner.isRunning())
      throw new ApplicationError(
        "conflict",
        "Wait for the active project scan before changing profiles.",
      );
  };
  return {
    status,
    checkProfileChange,
    detectTenant: async () => ({ tenantId: await detectTenant() }),
    chooseDirectory: async () => ({ path: await chooseDirectory() }),
    saveEntra(input: EntraConfig) {
      if (peopleSync.status().running)
        throw new ApplicationError(
          "conflict",
          "Wait for the active people sync before changing its settings.",
        );
      try {
        storage.saveEntra(input);
        peopleSync.reset();
        return status();
      } catch (error) {
        throw new ApplicationError("invalid", (error as Error).message);
      }
    },
    async projectRoots(roots: string[]) {
      if (scanner.isRunning())
        throw new ApplicationError(
          "conflict",
          "Wait for the active project scan before changing directories.",
        );
      const normalized: string[] = [];
      for (const root of roots) {
        try {
          normalized.push(await directoryPath(root));
        } catch {
          throw new ApplicationError(
            "invalid",
            `Project root is not an accessible directory: ${root}`,
          );
        }
      }
      storage.saveProjectRoots([...new Set(normalized)]);
      scanner.invalidate();
      return status();
    },
    async discover(input?: Connection) {
      try {
        return { models: await models.discover(input) };
      } catch (error) {
        throw new ApplicationError("invalid", (error as Error).message);
      }
    },
    async connect(input: Connection) {
      try {
        await models.connect(input);
        return status();
      } catch (error) {
        throw new ApplicationError("invalid", (error as Error).message);
      }
    },
    profile(input: ProfileSelection) {
      checkProfileChange();
      const next = openProfile(input.path);
      try {
        if (input.mode === "connect") {
          if (!next.isGit()) throw new Error("Choose an existing independent Git repository.");
          next.documents();
        } else {
          const facts = [
            ["Preferred name", input.name],
            ["Role", input.role],
            ["Company context", input.company],
            ["Team", input.team],
            ["Team purpose", input.teamPurpose],
            ["Timezone", input.timezone],
          ];
          next.initialize(
            facts
              .filter(([, value]) => value.trim())
              .map(([label, value]) => `## ${label}\n${value}`)
              .join("\n\n"),
          );
        }
        next.refresh();
        storage.saveProfile(next.root, input.timezone);
        peopleSync.migrate();
        if (next.root !== getProfile().root) scanner.reset();
        selectProfile(next);
        return status();
      } catch (error) {
        throw new ApplicationError("invalid", (error as Error).message);
      }
    },
  };
}
