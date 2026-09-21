import type { ProfileAccess } from "./application/ports.js";
import type { Profile } from "./profile.js";
import { applyProfileUpdate } from "./profile-update.js";

export function profileAdapter(profile: Profile): ProfileAccess {
  return {
    root: profile.root,
    isGit: () => profile.isGit(),
    documents: () => profile.documents(),
    refresh: () => profile.change("refresh profile navigation", () => profile.reconcileIndex()),
    initialize: (about) =>
      profile.initialize(() => {
        profile.create("About me", "Profile", about);
      }),
    enrichmentPrompt: () => profile.enrichmentPrompt(),
    edit: (path, content, hash) =>
      profile.change("update profile document", () => {
        profile.checkWritable("index.md");
        const saved = profile.save(path, content, hash);
        profile.reconcileIndex();
        return profile.documents().find((doc) => doc.path === saved.path);
      }),
    create: (title, type, body) =>
      profile.change("add profile concept", () => {
        profile.checkWritable("index.md");
        const document = profile.create(title, type, body);
        profile.reconcileIndex();
        return profile.documents().find((doc) => doc.path === document.path);
      }),
    incorporate: (snapshot, update) =>
      profile.change("incorporate profile note", () =>
        applyProfileUpdate(profile, snapshot, update),
      ),
  };
}
