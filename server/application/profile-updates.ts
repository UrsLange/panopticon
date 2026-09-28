import { dayInTimezone } from "../../shared/schema.js";
import type { Assistant } from "./assistant.js";
import { ApplicationError } from "./errors.js";
import type { CaptureRecords, ProfileNotes } from "./ports.js";

export function createProfileUpdates({
  store,
  getProfile,
  getAssistant,
  timezone,
  discoveryRunning,
}: {
  store: CaptureRecords;
  getProfile: () => ProfileNotes;
  getAssistant: () => Assistant | null;
  timezone: () => string;
  discoveryRunning: () => boolean;
}) {
  const profileUpdates = new Map<string, Promise<void>>();
  let profileQueue = Promise.resolve();
  const merge = (id: string, revision: number) => {
    const active = profileUpdates.get(id);
    if (active) return active;
    const target = getProfile();
    const task = profileQueue
      .then(async () => {
        const item = store.get(id);
        if (
          !item ||
          item.revision !== revision ||
          item.kind !== "note" ||
          ["done", "archived"].includes(item.status)
        )
          return;
        try {
          const assistant = getAssistant();
          if (!assistant) throw new Error("Connect and validate a model in Settings.");
          if (!target.isGit()) throw new Error("Connect a profile repository in Settings.");
          if (discoveryRunning())
            throw new Error("Wait for project discovery to finish, then retry.");
          const guard = () => {
            if (store.get(id)?.revision !== revision)
              throw new Error("Note changed during the update. Retry with the latest note.");
            if (getProfile() !== target)
              throw new Error("Profile changed. Retry in the intended profile.");
            if (discoveryRunning())
              throw new Error("Wait for project discovery to finish, then retry.");
          };
          guard();
          const result = await target.incorporate(
            item,
            dayInTimezone(new Date(item.createdAt), timezone()),
            assistant.updateProfile,
            guard,
          );
          guard();
          if (result.decision === "review") {
            store.update(
              id,
              { processing: "review", processingError: null, rationale: result.summary },
              revision,
            );
            return;
          }
          if (discoveryRunning())
            throw new Error("Wait for project discovery to finish, then retry.");
          store.update(
            id,
            {
              status: "done",
              processing: "ready",
              processingError: null,
              rationale: result.summary,
              sourcePaths: result.paths,
              profilePath: target.root,
            },
            revision,
          );
        } catch (error) {
          if (store.get(id)?.revision === revision)
            store.update(
              id,
              {
                processing: "review",
                processingError: `Profile update failed. ${(error as Error).message}`,
              },
              revision,
            );
        }
      })
      .finally(() => profileUpdates.delete(id));
    profileUpdates.set(id, task);
    profileQueue = task;
    return task;
  };

  return {
    async add(id: string, revision: number) {
      const item = store.get(id);
      if (!item) throw new ApplicationError("not-found", "Item not found");
      if (item.kind !== "note" || item.status === "archived")
        throw new ApplicationError("invalid", "Choose a pending note to add to the profile.");
      if (item.status === "done") return item;
      if (item.revision !== revision)
        throw new Error("This item changed. Reload before adding it to the profile.");
      await merge(item.id, revision);
      return store.get(item.id);
    },
    merge,
    has: (id: string) => profileUpdates.has(id),
    busy: () => profileUpdates.size > 0,
    close: () => profileQueue,
  };
}
