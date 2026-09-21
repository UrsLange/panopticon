import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProfileDocument } from "../shared/schema.js";
import type { ProfileUpdate } from "./application/profile-update-model.js";
import {
  validateProtectedContent,
  validateSnapshot,
  validateUpdatePath,
  validateUpdateTargets,
} from "./application/profile-update-rules.js";
import { Profile } from "./profile.js";

export function applyProfileUpdate(
  profile: Profile,
  snapshot: ProfileDocument[],
  update: ProfileUpdate,
) {
  const staging = mkdtempSync(join(tmpdir(), "pa-profile-update-"));
  try {
    for (const document of snapshot) {
      mkdirSync(dirname(join(staging, document.path)), { recursive: true });
      writeFileSync(join(staging, document.path), document.content);
    }
    const seen = new Set<string>();
    for (const change of update.changes) {
      const parts = change.path.split("/");
      validateUpdatePath(change.path, seen);
      seen.add(change.path);
      for (let i = 1; i <= parts.length; i++) {
        const target = join(profile.root, ...parts.slice(0, i));
        if (existsSync(target) && lstatSync(target).isSymbolicLink())
          throw new Error("Profile update cannot write through symbolic links.");
      }
      const previous = snapshot.find((doc) => doc.path === change.path);
      if (!previous && existsSync(join(profile.root, change.path)))
        throw new Error("Profile update would overwrite an unrecognized file.");
      if (previous) validateProtectedContent(previous, change);
      mkdirSync(dirname(join(staging, change.path)), { recursive: true });
      writeFileSync(join(staging, change.path), change.content);
    }
    const staged = new Profile(staging);
    staged.reconcileIndex();
    const documents = staged.documents();
    validateUpdateTargets(update, documents);
    const current = profile.documents();
    validateSnapshot(snapshot, current);
    for (const document of documents) {
      if (snapshot.find((doc) => doc.path === document.path)?.hash !== document.hash)
        profile.prepareWrite(document.path);
    }
    for (const document of documents) {
      const previous = snapshot.find((doc) => doc.path === document.path);
      if (previous?.hash === document.hash) continue;
      if (previous) profile.save(document.path, document.content, previous.hash);
      else {
        mkdirSync(dirname(join(profile.root, document.path)), { recursive: true });
        writeFileSync(join(profile.root, document.path), document.content, { flag: "wx" });
      }
    }
    for (const document of documents) {
      if (readFileSync(join(profile.root, document.path), "utf8") !== document.content)
        throw new Error("Profile changed while verifying the saved update.");
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
