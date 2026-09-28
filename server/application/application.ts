import type { createCaptures } from "./captures.js";
import type { createConversation } from "./conversation.js";
import type { PeopleSync } from "./people-sync.js";
import type { createPreferences } from "./preferences.js";
import type { createProfileService } from "./profile.js";
import type { createProfileLearning } from "./profile-learning.js";
import type { createProfileUpdates } from "./profile-updates.js";
import type { createProjectWorkspace } from "./project-workspace.js";
import type { ProjectScanner } from "./projects.js";
import type { createT3 } from "./t3.js";

export type Application = {
  projects: ReturnType<typeof createProjectWorkspace>;
  t3: ReturnType<typeof createT3>;
  captures: ReturnType<typeof createCaptures>;
  conversation: ReturnType<typeof createConversation>;
  notes: ReturnType<typeof createProfileUpdates>;
  profileLearning: ReturnType<typeof createProfileLearning>;
  profiles: ReturnType<typeof createProfileService>;
  preferences: ReturnType<typeof createPreferences>;
  scanner: ProjectScanner;
  peopleSync: PeopleSync;
  close(): Promise<void>;
};
