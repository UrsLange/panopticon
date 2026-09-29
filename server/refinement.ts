import { randomUUID } from "node:crypto";
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
  const runId = randomUUID();
  const started = performance.now();
  let requests = 0,
    toolCalls = 0,
    toolFailures = 0,
    webSearchCalls = 0;
  let inputTokens = 0,
    outputTokens = 0,
    usageRequests = 0;
  let outcome = "failed";
  const log = (event: string, details: Record<string, unknown>) =>
    console.info(
      JSON.stringify({
        event: `capture_refinement.${event}`,
        timestamp: new Date().toISOString(),
        runId,
        itemId: context.capture.id,
        model,
        ...details,
      }),
    );
  try {
    while (true) {
      const request = {
        model,
        store: false,
        include: ["reasoning.encrypted_content" as const],
        instructions: `${instructions}\n${prompts.research}`,
        input,
        tools: [
          { type: "web_search" as const },
          ...tools.map(({ name, description, parameters }) => ({
            type: "function" as const,
            name,
            description,
            parameters,
            strict: true,
          })),
        ],
        parallel_tool_calls: true,
      };
      requests++;
      const requestStarted = performance.now();
      log("request_started", {
        request: requests,
        requestCharacters: JSON.stringify(request).length,
      });
      const response = await client.responses
        .create(request, { timeout: 120000 })
        .catch((error: unknown) => {
          log("request_finished", {
            request: requests,
            durationMs: Math.round(performance.now() - requestStarted),
            status: "failed",
            httpStatus: error instanceof OpenAI.APIError ? (error.status ?? null) : null,
            timedOut: error instanceof OpenAI.APIConnectionTimeoutError,
          });
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
      const usage = response.usage;
      if (usage) {
        inputTokens += usage.input_tokens;
        outputTokens += usage.output_tokens;
        usageRequests++;
      }
      webSearchCalls += response.output.filter((item) => item.type === "web_search_call").length;
      log("request_finished", {
        request: requests,
        durationMs: Math.round(performance.now() - requestStarted),
        status: response.status,
        usage: usage
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? null,
              reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
            }
          : null,
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
        throw new Error("Refinement ended without calling complete_refinement.");
      }
      input.push(...responseHistory(response.output));
      let completed = false;
      let failedChange = false;
      const execute = async (call: (typeof calls)[number]) => {
        let output: unknown;
        const tool = tools.find((tool) => tool.name === call.name);
        const toolStarted = performance.now();
        const toolCall = ++toolCalls;
        let status = "completed";
        log("tool_started", { request: requests, toolCall, tool: tool?.name ?? "unknown" });
        try {
          if (!tool) throw new Error("Unknown refinement tool.");
          if (call.name === "complete_refinement") {
            if (call !== calls.at(-1))
              throw new Error("Call complete_refinement last, after all other work.");
            if (failedChange)
              throw new Error(
                "A preceding change failed. Inspect its result and repair it before completing.",
              );
          }
          const args = JSON.parse(call.arguments);
          if (call.name === "save_refinement") {
            const available = new Set(
              [...sources].map((source) => URL.parse(source)?.href ?? source),
            );
            if (
              !Array.isArray(args.sources) ||
              args.sources.some(
                (source: string) => !available.has(URL.parse(source)?.href ?? source),
              )
            )
              throw new Error(
                "Cite only supplied or retrieved evidence. Read the source or remove the unsupported citation, then save again.",
              );
          }
          const result = await tool.execute(args, signal);
          output = result.data;
          for (const source of result.sources) sources.add(source);
          if (call.name === "complete_refinement") completed = true;
        } catch (error) {
          status = "failed";
          toolFailures++;
          if (!tool?.readOnly) failedChange = true;
          output = {
            error: (error as Error).message,
            guidance:
              "Correct the arguments or try another source. Ask the user only about unresolved information that materially changes the outcome; a failed optional lookup is not itself a clarification question.",
          };
        }
        const serialized = JSON.stringify(output);
        log("tool_finished", {
          request: requests,
          toolCall,
          tool: tool?.name ?? "unknown",
          durationMs: Math.round(performance.now() - toolStarted),
          status,
          outputCharacters: serialized.length,
        });
        return {
          type: "function_call_output" as const,
          call_id: call.call_id,
          output: serialized,
        };
      };
      for (let index = 0; index < calls.length; ) {
        if (tools.find((tool) => tool.name === calls[index].name)?.readOnly) {
          const start = index;
          while (
            index < calls.length &&
            tools.find((tool) => tool.name === calls[index].name)?.readOnly
          )
            index++;
          input.push(...(await Promise.all(calls.slice(start, index).map(execute))));
        } else {
          input.push(await execute(calls[index++]));
          if (completed) {
            outcome = "completed";
            return;
          }
        }
      }
    }
  } finally {
    log("finished", {
      status: outcome,
      durationMs: Math.round(performance.now() - started),
      requests,
      toolCalls,
      toolFailures,
      webSearchCalls,
      usageRequests,
      inputTokens: usageRequests ? inputTokens : null,
      outputTokens: usageRequests ? outputTokens : null,
    });
  }
}
