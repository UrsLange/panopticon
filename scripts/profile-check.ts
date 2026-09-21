import { Profile } from "../server/profile.js";
import { SettingsStore } from "../server/settings.js";

const profile = new Profile(new SettingsStore().profilePath);
if (!profile.isGit())
  throw new Error("Connect or create an independent Git repository in Settings.");
const documents = profile.documents();
if (!documents.length)
  throw new Error("The profile has no Markdown documents. Add context in the app.");
console.log(`Validated ${documents.length} OKF documents in ${profile.root}`);
