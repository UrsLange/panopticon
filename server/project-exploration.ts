import { basename } from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import type { Connection } from "./application/connection.js";
import { ExplorationError, type ProjectExploration } from "./application/exploration.js";
import { metadata } from "./application/project-documents.js";
import { Profile } from "./profile.js";
import { runProfileAgent } from "./profile-learning-agent.js";
import { runProfileEditing } from "./profile-learning-workspace.js";
import { prompts } from "./prompts.js";
import { createResearch } from "./research-tools.js";

export async function exploreProject(
  { repository, profileRoot, document, model, onProgress, validateSource }: ProjectExploration,
  connection: Connection,
) {
  onProgress?.({ phase: "connecting", model });
  const client = new OpenAI({
    apiKey: connection.apiKey,
    baseURL: connection.baseURL,
    maxRetries: 0,
    fetchOptions: { redirect: "error" },
  });
  const profile = new Profile(profileRoot);
  const research = createResearch([
    { id: "repository", name: basename(repository), root: repository },
  ]);
  const reads = new Set<string>();
  const sources = new Set<string>();
  let completed = false;
  const verifyIdentity = () => {
    const previous = metadata(document).data;
    const current = profile
      .documents()
      .find((doc) => metadata(doc).data.repository_id === previous.repository_id);
    if (
      !current ||
      metadata(current).data.project_discovery !== true ||
      metadata(current).data.repository_name !== previous.repository_name
    )
      throw new Error("Preserve the project's discovery identity in the profile.");
  };
  const completion = z.object({ sources: z.array(z.string()).min(1) });
  try {
    await runProfileEditing(
      profile,
      {
        "project.json": {
          content: JSON.stringify(
            {
              documentPath: document.path,
              repositoryId: metadata(document).data.repository_id,
              scopes: research.scopes,
            },
            null,
            2,
          ),
        },
      },
      async (workspace, profileTools) => {
        const tools = profileTools.map((tool) => ({
          ...tool,
          async execute(input: unknown) {
            if (tool.name === "commit_profile") {
              await validateSource();
              verifyIdentity();
            }
            if (["write_file", "edit_file", "move_file", "delete_file"].includes(tool.name)) {
              completed = false;
              onProgress?.({ phase: "updating" });
            }
            return tool.execute(input);
          },
        }));
        const repositoryTools = research.tools
          .filter(({ name }) => ["list_files", "search_files", "read_file"].includes(name))
          .map((tool) => ({
            name: tool.name === "read_file" ? "read_repository_file" : tool.name,
            description: tool.description,
            parameters: tool.parameters,
            async execute(input: unknown) {
              const result = await tool.execute(input, new AbortController().signal);
              for (const source of result.sources) sources.add(source);
              if (tool.name === "read_file") {
                for (const source of result.sources) reads.add(source);
                onProgress?.({ phase: "reading", filesRead: reads.size });
              }
              return result.data;
            },
          }));
        const result = await runProfileAgent(
          client,
          model,
          prompts["project-exploration"],
          workspace,
          [
            ...tools,
            ...repositoryTools,
            {
              name: "complete_project_review",
              description:
                "Finish the repository review after committing profile edits, or verifying that existing knowledge is accurate. Supply retrieved source IDs supporting the findings.",
              parameters: z.toJSONSchema(completion),
              async execute(input) {
                const evidence = completion.parse(input).sources;
                if (!reads.size || evidence.some((source) => !sources.has(source)))
                  throw new Error(
                    "Read repository evidence and cite retrieved sources before completing the review.",
                  );
                if (profile.pendingPaths().length)
                  throw new Error("Commit profile edits before completing the review.");
                await validateSource();
                verifyIdentity();
                completed = true;
                return { completed: true };
              },
            },
          ],
          (id) => onProgress?.({ responseId: id }),
        );
        if (!completed)
          throw new ExplorationError({
            category: "incomplete",
            message: "Project review did not complete. Review any saved edits before retrying.",
          });
        await validateSource();
        onProgress?.({ phase: "validating" });
        return result;
      },
    );
  } catch (error) {
    if (error instanceof ExplorationError) throw error;
    if (error instanceof OpenAI.APIError)
      throw new ExplorationError({
        category: "provider",
        statusCode: error.status,
        message: error.status
          ? `The model provider returned HTTP ${error.status}. Check provider availability and access.`
          : "The model provider could not be reached. Check your connection and model settings.",
      });
    throw error;
  }
}
