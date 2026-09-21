import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import { ZodError } from "zod";
import { interpretationSchema } from "../shared/schema.js";
import type { AssistantContext } from "./application/assistant.js";
import { prompts, renderPrompt } from "./prompts.js";
import type { Research } from "./research-tools.js";

export const refinementLimits = { calls: 100, milliseconds: 15 * 60000, contextCharacters: 400000 };

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
  context: AssistantContext,
  research: Research,
) {
  const input: ResponseInputItem[] = [
    {
      type: "message",
      role: "user",
      content: JSON.stringify({ capture, context, scopes: research.scopes }),
    },
  ];
  const sources = new Set([
    ...context.profile.documents.map((doc) => doc.path),
    ...context.candidates.map((candidate) => candidate.source),
    ...context.references.map((reference) => reference.source),
    ...(context.people ? [context.people.source] : []),
    ...context.related.map((item) => item.id),
    ...context.commitments.due.map((item) => item.id),
    ...context.commitments.suggested.map((item) => item.id),
    ...context.commitments.waiting.map((item) => item.id),
  ]);
  const tools = research.tools.map(({ name, description, parameters }) => ({
    type: "function" as const,
    name,
    description,
    parameters,
    strict: true,
  }));
  const issues = new Set<string>();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), refinementLimits.milliseconds);
  timeout.unref();
  let calls = 0;
  let finalizing = false;
  try {
    while (true) {
      if (
        !finalizing &&
        (controller.signal.aborted ||
          calls >= refinementLimits.calls ||
          JSON.stringify(input).length >= refinementLimits.contextCharacters)
      ) {
        issues.add("Research reached its safety budget; some context may remain unchecked.");
        finalizing = true;
      }
      const prompt = `${instructions}\n${renderPrompt("research", {
        calls: String(refinementLimits.calls),
        minutes: String(refinementLimits.milliseconds / 60000),
        limitations: issues.size
          ? renderPrompt("research-limitations", { issues: [...issues].join(" ") })
          : "",
        finalization: finalizing ? prompts["research-finalization"] : "",
      })}`;
      let response: Awaited<ReturnType<typeof client.responses.parse>>;
      try {
        response = await client.responses.parse(
          {
            model,
            store: false,
            include: ["reasoning.encrypted_content"],
            instructions: prompt,
            input,
            tools,
            tool_choice: finalizing ? "none" : "auto",
            max_output_tokens: 10000,
            text: { format: zodTextFormat(interpretationSchema, "capture_interpretation") },
          },
          { timeout: 120000, ...(finalizing ? {} : { signal: controller.signal }) },
        );
      } catch (error) {
        if (!finalizing && controller.signal.aborted) continue;
        throw error;
      }
      const requested = response.output.filter((item) => item.type === "function_call");
      if (!requested.length) {
        const result = interpretationSchema.parse(response.output_parsed);
        if (result.sources.some((source) => !sources.has(source)))
          issues.add("Some proposed citations were not retrieved and need review.");
        result.sources = [...new Set(result.sources.filter((source) => sources.has(source)))];
        if (issues.size) {
          result.needsClarification = true;
          result.updateProfile = false;
          result.rationale = [result.rationale, ...issues].filter(Boolean).join("\n\n");
        }
        return result;
      }
      if (finalizing) throw new Error("The model did not finalize capture refinement.");
      input.push(...responseHistory(response.output));
      for (const call of requested) {
        let output: unknown;
        if (
          calls >= refinementLimits.calls ||
          controller.signal.aborted ||
          JSON.stringify(input).length >= refinementLimits.contextCharacters
        ) {
          output = { error: "Research budget reached. Finalize with the available evidence." };
        } else {
          calls++;
          const tool = research.tools.find(({ name }) => name === call.name);
          try {
            if (!tool) throw new Error("Unknown tool");
            const result = await tool.execute(JSON.parse(call.arguments), controller.signal);
            if (JSON.stringify(result.data).length > 30000)
              throw new Error("Tool output too large");
            output = result.data;
            for (const source of result.sources) sources.add(source);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (
              ["read_file", "list_files", "search_files"].includes(call.name) &&
              ["ENOENT", "ENOTDIR"].includes(code ?? "")
            ) {
              output = {
                error:
                  "The requested path was not found or is not a directory. Use list_files from the scope root or search_files to locate the correct path, then retry.",
              };
            } else if (error instanceof ZodError || error instanceof SyntaxError) {
              output = {
                error:
                  "Invalid tool arguments. Check the tool schema and retry with valid JSON and all required fields.",
              };
            } else {
              issues.add(`${call.name} could not retrieve requested context.`);
              output = {
                error:
                  "Context lookup failed. Check the tool arguments or try another source. The file, history index or command may be unavailable, excluded, or too large.",
              };
            }
          }
        }
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(output),
        });
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}
