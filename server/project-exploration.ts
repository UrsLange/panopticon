import { basename } from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { z } from "zod";
import type { Connection } from "./application/connection.js";
import { ExplorationError, type ProjectExploration } from "./application/exploration.js";
import { end, metadata, start, summary } from "./application/project-documents.js";
import { renderPrompt } from "./prompts.js";
import { responseHistory } from "./refinement.js";
import { createResearch } from "./research-tools.js";

export const explorationLimits = {
  calls: 100,
  milliseconds: 10 * 60000,
  contextCharacters: 400000,
};
const resultSchema = z.object({
  summary: z.string().trim().min(1),
  sources: z.array(z.string()).min(1),
  complete: z.boolean(),
});

export async function exploreProject(
  { repository, document, model, onProgress }: ProjectExploration,
  connection: Connection,
) {
  const previous = summary(document);
  onProgress?.({ phase: "connecting", model });
  const client = new OpenAI({
    apiKey: connection.apiKey,
    baseURL: connection.baseURL,
    maxRetries: 0,
    fetchOptions: { redirect: "error" },
  });
  const research = createResearch([
    { id: "repository", name: basename(repository), root: repository },
  ]);
  const tools = research.tools.filter(({ name }) =>
    ["list_files", "search_files", "read_file"].includes(name),
  );
  const input: ResponseInputItem[] = [
    {
      type: "message",
      role: "user",
      content: JSON.stringify({ scopes: research.scopes, previousSummary: previous }),
    },
  ];
  const instructions = renderPrompt("project-exploration", {
    calls: String(explorationLimits.calls),
    minutes: String(explorationLimits.milliseconds / 60000),
  });
  const sources = new Set<string>();
  const reads = new Set<string>();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), explorationLimits.milliseconds);
  timeout.unref();
  let calls = 0;
  try {
    while (true) {
      controller.signal.throwIfAborted();
      if (JSON.stringify(input).length >= explorationLimits.contextCharacters)
        throw new ExplorationError({
          category: "context-limit",
          message: "Project discovery exceeded its context limit. The summary was not applied.",
        });
      const response = await client.responses.parse(
        {
          model,
          store: false,
          include: ["reasoning.encrypted_content"],
          instructions,
          input,
          tools: tools.map(({ name, description, parameters }) => ({
            type: "function" as const,
            name,
            description,
            parameters,
            strict: true,
          })),
          tool_choice: calls >= explorationLimits.calls ? "none" : "auto",
          max_output_tokens: 10000,
          text: { format: zodTextFormat(resultSchema, "project_summary") },
        },
        { timeout: 120000, signal: controller.signal },
      );
      controller.signal.throwIfAborted();
      onProgress?.({ responseId: response.id });
      if (response.status !== "completed")
        throw new ExplorationError({
          category: "incomplete",
          message: "Project discovery did not complete. The summary was not applied.",
        });
      const requested = response.output.filter((item) => item.type === "function_call");
      if (!requested.length) {
        const result = resultSchema.parse(response.output_parsed);
        if (
          !result.complete ||
          !reads.size ||
          result.sources.some((source) => !sources.has(source))
        )
          throw new ExplorationError({
            category: "incomplete",
            message:
              "Project discovery returned incomplete or unsupported findings. The summary was not applied.",
          });
        if (result.summary.includes(start) || result.summary.includes(end))
          throw new ExplorationError({
            category: "invalid-output",
            message: "Project discovery returned summary markers. The summary was not applied.",
          });
        onProgress?.({ phase: "updating" });
        const body = metadata(document).body;
        const bodyOffset = document.content.length - body.length;
        const draft =
          result.summary === previous
            ? document.content
            : document.content.slice(0, bodyOffset + body.indexOf(start) + start.length) +
              `\n${result.summary}\n` +
              document.content.slice(bodyOffset + body.indexOf(end));
        onProgress?.({ phase: "validating" });
        return draft;
      }
      input.push(...responseHistory(response.output));
      for (const call of requested) {
        controller.signal.throwIfAborted();
        if (calls >= explorationLimits.calls)
          throw new ExplorationError({
            category: "tool-limit",
            message: "Project discovery exceeded its tool-call limit. The summary was not applied.",
          });
        calls++;
        let output: unknown;
        try {
          const tool = tools.find((tool) => tool.name === call.name);
          if (!tool) throw new Error("Unknown tool");
          const result = await tool.execute(JSON.parse(call.arguments), controller.signal);
          output = result.data;
          for (const source of result.sources) sources.add(source);
          if (call.name === "read_file") {
            for (const source of result.sources) reads.add(source);
            onProgress?.({ phase: "reading", filesRead: reads.size });
          }
        } catch {
          controller.signal.throwIfAborted();
          output = {
            error:
              "Context lookup failed. Use the supplied file tools and scope; list files to correct a path. Excluded, oversized, binary and symlinked files cannot be read. If required evidence remains unavailable, return complete: false.",
          };
        }
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(output),
        });
      }
    }
  } catch (error) {
    if (error instanceof ExplorationError) throw error;
    if (controller.signal.aborted || error instanceof OpenAI.APIConnectionTimeoutError)
      throw new ExplorationError({
        category: "timeout",
        message: "Project discovery timed out. The summary was not applied; retry the scan.",
      });
    if (error instanceof OpenAI.APIError)
      throw new ExplorationError({
        category: "provider",
        statusCode: error.status,
        message: error.status
          ? `The model provider returned HTTP ${error.status}. Check provider availability and access.`
          : "The model provider could not be reached. Check your connection and model settings.",
      });
    throw new ExplorationError({
      category: "invalid-output",
      message: "Project discovery returned invalid output. The summary was not applied.",
    });
  } finally {
    clearTimeout(timeout);
  }
}
