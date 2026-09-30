import { createHash, randomUUID } from "node:crypto";
import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import {
  ctxAssessmentSchema,
  type RefinementContext,
  type RefinementContinuation,
  type RefinementTool,
} from "./application/assistant.js";
import { ApplicationError } from "./application/errors.js";
import { prompts } from "./prompts.js";
import type { Research } from "./research-tools.js";

export type RefinementMetrics = {
  runId: string;
  sessionId: string;
  itemId: string;
  model: string;
  resumed: boolean;
  timestamp: string;
  status: string;
  durationMs: number;
  modelDurationMs: number;
  requests: number;
  toolCalls: number;
  toolFailures: number;
  webSearchCalls: number;
  usageRequests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  ctx: {
    searches: number;
    reads: number;
    failures: number;
    durationMs: number;
    requestRounds: number;
    evidenceSources: number;
    citedSources: number;
    priorEvidence: boolean;
    priorLookup: boolean;
    assessment: ReturnType<typeof ctxAssessmentSchema.parse>;
  };
};

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
  continuation?: RefinementContinuation,
  record?: (metrics: RefinementMetrics) => void,
) {
  const tools = [...research.tools, ...captureTools];
  const compatibility = createHash("sha256")
    .update(
      JSON.stringify({
        model,
        endpoint: client.baseURL,
        instructions,
        research: prompts.research,
        tools: tools.map(({ name, parameters }) => ({ name, parameters })),
      }),
    )
    .digest("hex");
  const previous = continuation?.state
    ? (JSON.parse(continuation.state) as {
        compatibility: string;
        sessionId: string;
        input: ResponseInputItem[];
        sources: string[];
        ctxSources: string[];
        ctxUsed: boolean;
      })
    : null;
  const session = previous?.compatibility === compatibility ? previous : null;
  const sessionId = session?.sessionId ?? randomUUID();
  const input: ResponseInputItem[] = [
    ...(session?.input ?? []),
    { role: "user", content: JSON.stringify({ capture, context, scopes: research.scopes }) },
  ];
  const sources = new Set([
    ...(session?.sources ?? []),
    ...context.preferences.map((document) => document.path),
    context.capture.id,
    ...context.capture.sourcePaths,
    ...context.capture.references.map((reference) => reference.source),
    ...context.linkedCaptures.map((entry) => entry.id),
  ]);
  const signal = new AbortController().signal;
  const runId = randomUUID();
  const started = performance.now();
  const ctxSources = new Set(session?.ctxSources ?? []);
  const citedCtxSources = new Set<string>();
  let modelDurationMs = 0;
  const ctx: RefinementMetrics["ctx"] = {
    searches: 0,
    reads: 0,
    failures: 0,
    durationMs: 0,
    requestRounds: 0,
    evidenceSources: 0,
    citedSources: 0,
    priorEvidence: ctxSources.size > 0,
    priorLookup: session?.ctxUsed ?? false,
    assessment: null,
  };
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
        sessionId,
        resumed: !!session,
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
          modelDurationMs += performance.now() - requestStarted;
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
      modelDurationMs += performance.now() - requestStarted;
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
      if (calls.some((call) => ["search_history", "read_history"].includes(call.name)))
        ctx.requestRounds++;
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
        const historyCall = ["search_history", "read_history"].includes(call.name);
        if (call.name === "search_history") ctx.searches++;
        if (call.name === "read_history") ctx.reads++;
        log("tool_started", { request: requests, toolCall, tool: tool?.name ?? "unknown" });
        try {
          if (!tool) throw new Error("Unknown refinement tool.");
          const args = JSON.parse(call.arguments);
          const completing =
            call.name === "complete_refinement" ||
            (call.name === "save_refinement" && args.complete === true);
          if (completing) {
            if (call !== calls.at(-1))
              throw new Error(
                "Call complete_refinement last, or make the final save with complete true the last call.",
              );
            if (failedChange)
              throw new Error(
                "A preceding change failed. Inspect its result and repair it before completing.",
              );
          }
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
          if (historyCall) for (const source of result.sources) ctxSources.add(source);
          if (call.name === "save_refinement")
            for (const source of args.sources)
              if (ctxSources.has(source)) citedCtxSources.add(source);
          if (completing) {
            ctx.assessment = ctxAssessmentSchema.parse(args.ctxAssessment);
            completed = true;
          }
        } catch (error) {
          status = "failed";
          toolFailures++;
          if (historyCall) ctx.failures++;
          if (!tool?.readOnly) failedChange = true;
          output = {
            error: (error as Error).message,
            guidance:
              "Correct the arguments or try another source. Ask the user only about unresolved information that materially changes the outcome; a failed optional lookup is not itself a clarification question.",
          };
        }
        const serialized = JSON.stringify(output);
        if (historyCall) ctx.durationMs += performance.now() - toolStarted;
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
            continuation?.save(
              JSON.stringify({
                compatibility,
                sessionId,
                input,
                sources: [...sources],
                ctxSources: [...ctxSources],
                ctxUsed: ctx.priorLookup || ctx.searches + ctx.reads > 0,
              }),
            );
            outcome = "completed";
            return;
          }
        }
      }
    }
  } finally {
    ctx.durationMs = Math.round(ctx.durationMs);
    ctx.evidenceSources = ctxSources.size;
    ctx.citedSources = citedCtxSources.size;
    const metrics: RefinementMetrics = {
      runId,
      sessionId,
      itemId: context.capture.id,
      model,
      resumed: !!session,
      timestamp: new Date().toISOString(),
      status: outcome,
      durationMs: Math.round(performance.now() - started),
      modelDurationMs: Math.round(modelDurationMs),
      requests,
      toolCalls,
      toolFailures,
      webSearchCalls,
      usageRequests,
      inputTokens: usageRequests ? inputTokens : null,
      outputTokens: usageRequests ? outputTokens : null,
      ctx,
    };
    log("finished", { ...metrics, ctx: { ...ctx, assessment: ctx.assessment?.value ?? null } });
    try {
      record?.(metrics);
    } catch {
      console.error("Could not persist refinement performance metrics", { runId });
    }
  }
}
