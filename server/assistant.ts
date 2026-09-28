import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { Assistant } from "./application/assistant.js";
import { consolidateProfile, runProfileAgent } from "./profile-learning-agent.js";
import { prompts } from "./prompts.js";
import { refineCapture, responseHistory } from "./refinement.js";
import type { Research } from "./research-tools.js";

const replySchema = z.object({ answer: z.string(), sources: z.array(z.string()) });

export async function validateToolCalling(apiKey: string, model: string, baseURL: string) {
  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: 45000,
    maxRetries: 0,
    fetchOptions: { redirect: "error" },
  });
  const tools = [
    {
      type: "function" as const,
      name: "read_validation_value",
      description: "Read the synthetic connection validation value.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      strict: true,
    },
  ];
  const input = [
    {
      type: "message" as const,
      role: "user" as const,
      content: prompts["connection-validation"],
    },
  ];
  const response = await client.responses.create({
    model,
    store: false,
    include: ["reasoning.encrypted_content"],
    input,
    tools,
    tool_choice: { type: "function", name: "read_validation_value" },
    parallel_tool_calls: false,
  });
  const calls = response.output.filter((item) => item.type === "function_call");
  if (
    calls.length !== 1 ||
    calls[0].name !== "read_validation_value" ||
    Object.keys(JSON.parse(calls[0].arguments)).length
  )
    throw new Error("The model did not perform the validation tool call.");
  const value = randomUUID();
  const result = await client.responses.parse({
    model,
    store: false,
    tools,
    tool_choice: "none",
    input: [
      ...input,
      ...responseHistory(response.output),
      {
        type: "function_call_output",
        call_id: calls[0].call_id,
        output: JSON.stringify({ value }),
      },
    ],
    text: { format: zodTextFormat(z.object({ value: z.string() }), "tool_validation") },
  });
  if (result.output_parsed?.value !== value)
    throw new Error("The model did not use the tool result.");
}

export function createAssistant(
  apiKey: string,
  model: string,
  baseURL: string,
  research: () => Research = () => ({ scopes: [], tools: [] }),
): Assistant | null {
  if (!apiKey || !model) return null;
  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: 45000,
    maxRetries: 0,
    fetchOptions: { redirect: "error" },
  });
  const instructions = prompts.shared;
  return {
    async interpret(text, context) {
      return refineCapture(
        client,
        model,
        `${instructions}\n${prompts.capture}`,
        text,
        context,
        research(),
      );
    },
    updateProfile: (workspace, tools) =>
      runProfileAgent(client, model, prompts["profile-update"], workspace, tools),
    consolidateProfile: (workspace, tools) => consolidateProfile(client, model, workspace, tools),
    async ask(text, context, history, sessionEvidence) {
      const response = await client.responses.parse({
        model,
        store: false,
        instructions: `${instructions}\n${prompts.conversation}`,
        input: JSON.stringify({ question: text, context, history, sessionEvidence }),
        text: { format: zodTextFormat(replySchema, "assistant_reply") },
      });
      if (!response.output_parsed) throw new Error("The model did not return an answer.");
      const allowed = new Set([
        ...context.candidates.map((candidate) => candidate.source),
        ...(context.people ? [context.people.source] : []),
        ...context.profile.documents.map((doc) => doc.path),
        ...context.related.map((item) => item.id),
        ...context.commitments.due.map((item) => item.id),
        ...context.commitments.suggested.map((item) => item.id),
        ...context.commitments.waiting.map((item) => item.id),
      ]);
      return {
        ...response.output_parsed,
        sources: response.output_parsed.sources.filter((source) => allowed.has(source)),
      };
    },
  };
}
