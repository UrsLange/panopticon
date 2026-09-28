import type { ProfileLearningStatus } from "../../shared/profile-learning.js";
import { dayInTimezone } from "../../shared/schema.js";
import type { Assistant } from "./assistant.js";
import { ApplicationError, ProfileCommitError } from "./errors.js";
import type { ProfileAccess } from "./ports.js";
import {
  type ProfileLearningRecords,
  type ProfileLearningState,
  profileConsolidationSchema,
} from "./profile-learning-model.js";

export function createProfileLearning({
  records,
  getProfile,
  getAssistant,
  busy,
  timezone,
  now,
}: {
  records: ProfileLearningRecords;
  getProfile: () => Pick<ProfileAccess, "root" | "isGit" | "documents" | "consolidate">;
  getAssistant: () => Assistant | null;
  busy: () => boolean;
  timezone: () => string;
  now: () => Date;
}) {
  let active: Promise<ProfileLearningStatus> | null = null;
  const state = (root: string): ProfileLearningState =>
    records.profileLearningState(root) ?? {
      cursor: 0,
      completedDay: null,
      lastAttempt: null,
      lastSuccess: null,
      summary: "",
      provisionalMemory: "",
      error: null,
    };
  const status = (): ProfileLearningStatus => {
    const { lastAttempt, lastSuccess, summary, error } = state(getProfile().root);
    return { running: !!active, lastAttempt, lastSuccess, summary, error };
  };
  const run = (scheduled = false): Promise<ProfileLearningStatus> => {
    if (active) return active;
    const profile = getProfile();
    const assistant = getAssistant();
    if (!assistant || !profile.isGit() || busy()) return Promise.resolve(status());
    const previous = state(profile.root);
    const started = now();
    const zone = timezone();
    const day = dayInTimezone(started, zone);
    if (
      scheduled &&
      ((!previous.error && previous.completedDay === day) ||
        (previous.error &&
          previous.lastAttempt &&
          started.getTime() - Date.parse(previous.lastAttempt) < 900000))
    )
      return Promise.resolve(status());
    const attempt = { ...previous, lastAttempt: started.toISOString(), error: null };
    records.saveProfileLearningState(profile.root, attempt);
    active = Promise.resolve()
      .then(async () => {
        try {
          const documents = profile.documents();
          const pending = records.profileActivity(profile.root, previous.cursor);
          const activity = [];
          let size = 0;
          for (const event of pending) {
            if (activity.length && size + event.content.length > 60000) break;
            activity.push(event);
            size += event.content.length;
          }
          const result = profileConsolidationSchema.parse(
            await assistant.consolidateProfile({
              documents,
              activity,
              provisionalMemory: previous.provisionalMemory,
              date: day,
              timezone: zone,
            }),
          );
          if (getProfile() !== profile)
            throw new Error("Profile changed during consolidation. Retry in the intended profile.");
          if (busy())
            throw new Error("Wait for active profile work before retrying consolidation.");
          profile.consolidate(documents, result);
          const cursor = activity.at(-1)?.id ?? previous.cursor;
          records.saveProfileLearningState(profile.root, {
            ...attempt,
            cursor,
            provisionalMemory: result.provisionalMemory,
            completedDay: records.profileActivity(profile.root, cursor).length ? null : day,
            lastSuccess: now().toISOString(),
            summary: result.summary,
          });
        } catch (error) {
          records.saveProfileLearningState(profile.root, {
            ...attempt,
            error:
              error instanceof ProfileCommitError
                ? error.message
                : "Profile learning failed. Activity is retained for retry; check the model connection and profile files.",
          });
        }
        return { ...status(), running: false };
      })
      .finally(() => {
        active = null;
      });
    return active;
  };
  return {
    status,
    run,
    request() {
      if (!getAssistant() || !getProfile().isGit())
        throw new ApplicationError("invalid", "Connect a model and a profile repository first.");
      if (busy())
        throw new ApplicationError(
          "conflict",
          "Wait for active profile work before consolidating.",
        );
      void run().catch(() => {});
      return status();
    },
    busy: () => !!active,
    close: async () => {
      await active;
    },
  };
}
