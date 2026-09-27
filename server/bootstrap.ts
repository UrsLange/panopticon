import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dayInTimezone } from "../shared/schema.js";
import { createHttpApp } from "./app.js";
import type { Application } from "./application/application.js";
import type { Assistant } from "./application/assistant.js";
import { createCaptures } from "./application/captures.js";
import { createContext } from "./application/context.js";
import { createConversation } from "./application/conversation.js";
import { resolveImplementationRepository } from "./application/implementation-repository.js";
import type { PeopleSync } from "./application/people-sync.js";
import { createPreferences } from "./application/preferences.js";
import { createProfileService } from "./application/profile.js";
import { createProfileUpdates } from "./application/profile-updates.js";
import {
  createProjectWorkspace,
  type ProjectWorkspaceIO,
} from "./application/project-workspace.js";
import type { ProjectScanner } from "./application/projects.js";
import { createT3, type T3Client } from "./application/t3.js";
import { createAssistant } from "./assistant.js";
import { config } from "./config.js";
import { ctxAvailable, searchSessions } from "./ctx.js";
import { chooseDirectory } from "./directory-picker.js";
import { createGitHubApi } from "./github-api.js";
import { createPeopleSync, detectEntraTenant } from "./people.js";
import { Profile } from "./profile.js";
import { profileAdapter } from "./profile-adapter.js";
import { createProjectWorkspaceIO } from "./project-repositories.js";
import { createProjectScanner } from "./projects.js";
import { repositoryInsights } from "./repository-insights.js";
import { createResearch } from "./research-tools.js";
import { SettingsStore, settingsModels } from "./settings.js";
import { Store } from "./store.js";
import { createT3Client, implementationWorkspace, readLocalMerge } from "./t3.js";

export type AppOptions = {
  projectIO?: ProjectWorkspaceIO;
  chooseDirectory?: () => Promise<string | null>;
  t3Client?: T3Client;
  store?: Store;
  profile?: Profile;
  assistant?: Assistant | null;
  timezone?: string;
  now?: () => Date;
  settings?: SettingsStore;
  projectScanner?: ProjectScanner;
  peopleSync?: PeopleSync;
};

export function createApplication(options: AppOptions = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  const store = options.store ?? new Store(join(config.dataDir, "assistant.sqlite"));
  const settings = options.settings ?? new SettingsStore();
  const scanner = options.projectScanner ?? createProjectScanner(settings);
  const peopleSync = options.peopleSync ?? createPeopleSync(settings, store);
  let profileNotes = profileAdapter(options.profile ?? new Profile(settings.profilePath));
  const getAssistant = () => {
    if (options.assistant !== undefined) return options.assistant;
    if (!settings.modelReady) return null;
    const connection = settings.credentials();
    return createAssistant(connection.apiKey ?? "", connection.model, connection.baseURL, () =>
      createResearch([
        { id: "profile", name: "Personal profile", root: profileNotes.root },
        ...scanner
          .status()
          .projects.filter(
            (project) =>
              project.availability === "available" &&
              settings.projectRoots.includes(project.root) &&
              resolve(project.root, project.name) === resolve(project.path),
          )
          .map((project) => ({
            id: `project:${project.id}`,
            name: project.name,
            root: project.path,
            ...(project.document ? { profileDocument: project.document } : {}),
          })),
      ]),
    );
  };
  const now = options.now ?? (() => new Date());
  const today = () => dayInTimezone(now(), options.timezone ?? settings.timezone);
  const context = createContext({
    store,
    getProfile: () => profileNotes,
    directory: () => settings.entraCredentials(),
    today,
  });

  const notes = createProfileUpdates({
    store,
    getProfile: () => profileNotes,
    getAssistant,
    timezone: () => options.timezone ?? settings.timezone,
    discoveryRunning: () => scanner.isRunning(),
  });

  const repositories = () =>
    scanner
      .status()
      .projects.filter(
        (project) =>
          project.availability === "available" &&
          settings.projectRoots.includes(project.root) &&
          resolve(project.root, project.name) === resolve(project.path),
      );
  const captures = createCaptures({
    store,
    getAssistant,
    context,
    notes,
    today,
    resolveRepository: (item) =>
      resolveImplementationRepository(item, repositories(), profileNotes.documents()),
  });
  const profiles = createProfileService(() => profileNotes);
  const github = createGitHubApi(store);
  const projects = createProjectWorkspace({
    records: store,
    scope: () => ({ profile: profileNotes.root, roots: settings.projectRoots }),
    documents: () => profileNotes.documents(),
    io:
      options.projectIO ??
      createProjectWorkspaceIO((url, options) => repositoryInsights(url, github, options)),
    now: () => now().toISOString(),
  });
  const conversation = createConversation({ store, getAssistant, context, searchSessions });
  const t3 = createT3({
    records: store,
    settings,
    client: options.t3Client ?? createT3Client(),
    getProfile: () => profileNotes,
    repositories,
    workspace: implementationWorkspace,
    localMerge: readLocalMerge,
    id: randomUUID,
    now: () => now().toISOString(),
  });

  const preferences = createPreferences({
    storage: {
      view: () => ({
        credentialSources: settings.credentialSources(),
        entra: settings.publicEntra(),
        modelReady: settings.modelReady,
        profileReady: settings.profileReady,
        connection: settings.connection(),
        projectRoots: settings.projectRoots,
        timezone: settings.timezone,
      }),
      saveEntra: (input) => settings.saveEntra(input),
      saveProjectRoots: (roots) => settings.saveProjectRoots(roots),
      saveProfile: (path, timezone) => settings.saveProfile(path, timezone),
    },
    models: settingsModels(settings),
    getProfile: () => profileNotes,
    openProfile: (path) => profileAdapter(new Profile(resolve(path))),
    selectProfile: (next) => {
      profileNotes = next;
    },
    scanner,
    peopleSync,
    capturesBusy: () => notes.busy() || captures.busy(),
    assistantConfigured: !!options.assistant,
    ctxAvailable,
    timezone: () => options.timezone ?? settings.timezone,
    directoryPath: async (root) => {
      const path = await realpath(root);
      if (!(await stat(path)).isDirectory()) throw new Error();
      return path;
    },
    detectTenant: detectEntraTenant,
    chooseDirectory: options.chooseDirectory ?? chooseDirectory,
  });
  return {
    projects,
    t3,
    notes,
    captures,
    profiles,
    conversation,
    preferences,
    scanner,
    peopleSync,
    async close() {
      await projects.close();
      await t3.close();
      await peopleSync.close();
      await scanner.close();
      await captures.close();
      await notes.close();
      if (!options.store) store.db.close();
    },
  } satisfies Application;
}

export function createApp(options: AppOptions = {}) {
  return createHttpApp(createApplication(options), config.port);
}
