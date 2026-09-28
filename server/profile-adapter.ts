import { z } from "zod";
import type { ProfileAccess } from "./application/ports.js";
import type { Profile } from "./profile.js";
import { runProfileEditing, runProfileLearning } from "./profile-learning-workspace.js";

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
    async incorporate(item, date, agent, guard) {
      let paths: string[] | undefined;
      const schema = z.object({ paths: z.array(z.string()).min(1) });
      const result = await runProfileEditing(
        profile,
        {
          "note.json": {
            content: JSON.stringify(
              { capture: item, knowledge: item.prompt || item.body, captureDate: date },
              null,
              2,
            ),
          },
        },
        (workspace, tools) =>
          agent(workspace, [
            ...tools.map((tool) => ({
              ...tool,
              execute(input: unknown) {
                if (["write_file", "edit_file", "move_file", "delete_file"].includes(tool.name))
                  paths = undefined;
                return tool.execute(input);
              },
            })),
            {
              name: "complete_note",
              description:
                "Record that all of the note is incorporated or already present. Supply the profile concept paths containing the knowledge. Commit any edits first. If clarification is needed, do not call this tool; explain the question in your final response.",
              parameters: z.toJSONSchema(schema),
              execute(input) {
                guard();
                if (profile.pendingPaths().length)
                  throw new Error("Commit profile edits before completing the note.");
                const selected = schema.parse(input).paths;
                if (
                  selected.some(
                    (path) =>
                      !profile.documents().some((doc) => doc.path === path && doc.type !== "Index"),
                  )
                )
                  throw new Error("Choose existing profile concepts containing the note.");
                paths = selected;
                return { completed: true };
              },
            },
          ]),
        guard,
      );
      return { summary: result.summary, decision: paths ? "apply" : "review", paths: paths ?? [] };
    },
    consolidate: (input, agent) => runProfileLearning(profile, input, agent),
  };
}
