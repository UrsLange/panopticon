import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import type { RefinementContext, RefinementTool } from "./application/assistant.js";
import { ApplicationError } from "./application/errors.js";
import { prompts } from "./prompts.js";
import type { Research } from "./research-tools.js";

export function responseHistory(output: ResponseOutputItem[]) {
  // Some providers return null for an absent namespace but reject it when replayed.
  return toResponseInputItems(output).map((item) =>
    item.type === "function_call" ? { ...item, namespace: item.namespace ?? undefined } : item,
  );
}

export async function refineCapture(
  client: OpenAI,
  model: string,
  instructions: string,
  capture: string,
  context: RefinementContext,
  research: Research,
  captureTools: RefinementTool[],
) {
  const input: ResponseInputItem[] = [
    { role: "user", content: JSON.stringify({ capture, context, scopes: research.scopes }) },
  ];
  const sources = new Set([
    context.capture.id,
    ...context.capture.sourcePaths,
    ...context.capture.references.map((reference) => reference.source),
    ...context.linkedCaptures.map((entry) => entry.id),
  ]);
  const tools = [...research.tools, ...captureTools];
  const signal = new AbortController().signal;
  while (true) {
    const response = await client.responses
      .create(
        {
          model,
          store: false,
          include: ["reasoning.encrypted_content"],
          instructions: `${instructions}\n${prompts.research}`,
          input,
          tools: [
            { type: "web_search" },
            ...tools.map(({ name, description, parameters }) => ({
              type: "function" as const,
              name,
              description,
              parameters,
              strict: true,
            })),
          ],
          parallel_tool_calls: false,
        },
        { timeout: 120000 },
      )
      .catch((error: unknown) => {
        if (error instanceof OpenAI.APIError) {
          const message =
            error instanceof OpenAI.APIConnectionTimeoutError
              ? "The model provider request timed out. Retry refinement."
              : error.status
                ? `The model provider returned HTTP ${error.status}. Check provider availability and access, then retry.`
                : "The model provider could not be reached. Check your connection and model settings.";
          throw new ApplicationError("unavailable", message, { cause: error });
        }
        throw error;
      });
    if (response.status !== "completed") throw new Error("Refinement did not complete.");
    for (const item of response.output) {
      if (item.type === "web_search_call" && item.status === "completed") {
        if (item.action.type === "search")
          for (const source of item.action.sources ?? []) sources.add(source.url);
        else if (item.action.url) sources.add(item.action.url);
      }
      if (item.type === "message")
        for (const content of item.content) {
          if (content.type === "output_text")
            for (const annotation of content.annotations) {
              if (annotation.type === "url_citation") sources.add(annotation.url);
            }
        }
    }
    const calls = response.output.filter((item) => item.type === "function_call");
    if (!calls.length) {
      if (
        response.output.some((item) => item.type === "web_search_call") &&
        !response.output.some((item) => item.type === "message")
      ) {
        input.push(...responseHistory(response.output));
        continue;
      }
      return;
    }
    input.push(...responseHistory(response.output));
    for (const call of calls) {
      let output: unknown;
      try {
        const tool = tools.find((tool) => tool.name === call.name);
        if (!tool) throw new Error("Unknown refinement tool.");
        const args = JSON.parse(call.arguments);
        if (call.name === "save_refinement") {
          const available = new Set(
            [...sources].map((source) => URL.parse(source)?.href ?? source),
          );
          if (
            !Array.isArray(args.sources) ||
            args.sources.some((source: string) => !available.has(URL.parse(source)?.href ?? source))
          )
            throw new Error(
              "Cite only supplied or retrieved evidence. Read the source or remove the unsupported citation, then save again.",
            );
        }
        const result = await tool.execute(args, signal);
        output = result.data;
        for (const source of result.sources) sources.add(source);
      } catch (error) {
        output = {
          error: (error as Error).message,
          guidance:
            "Correct the arguments or try another source. Ask the user only about unresolved information that materially changes the outcome; a failed optional lookup is not itself a clarification question.",
        };
      }
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(output),
      });
    }
  }
}
