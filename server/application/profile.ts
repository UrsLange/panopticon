import type { ProfileAccess } from "./ports.js";

export function createProfileService(getProfile: () => ProfileAccess) {
  return {
    documents() {
      const profile = getProfile();
      if (profile.isGit()) profile.refresh();
      return profile.documents();
    },
    edit: (path: string, content: string, hash: string) => getProfile().edit(path, content, hash),
    create: (title: string, type: string, body: string) => getProfile().create(title, type, body),
    enrichment: () => ({ prompt: getProfile().enrichmentPrompt() }),
  };
}
