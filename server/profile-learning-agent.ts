import type OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type {
  ProfileLearningTool,
  ProfileLearningWorkspace,
} from "./application/profile-learning-model.js";
import { prompts } from "./prompts.js";
import { responseHistory } from "./refinement.js";

export async function consolidateProfile(
  client: OpenAI,
  model: string,
  workspace: ProfileLearningWorkspace,
  tools: ProfileLearningTool[],
) {
  return runProfileAgent(client, model, prompts["profile-consolidation"], workspace, tools);
}

export async function runProfileAgent(
  client: OpenAI,
  model: string,
  instructions: string,
  workspace: object,
  tools: ProfileLearningTool[],
  onResponse?: (id: string) => void,
) {
  const input: ResponseInputItem[] = [{ role: "user", content: JSON.stringify(workspace) }];
  while (true) {
    const response = await client.responses.create({
      model,
      store: false,
      include: ["reasoning.encrypted_content"],
      instructions,
      input,
      tools: tools.map(({ name, description, parameters }) => ({
        type: "function",
        name,
        description,
        parameters,
        strict: true,
      })),
      parallel_tool_calls: false,
    });
    onResponse?.(response.id);
    if (response.status !== "completed") throw new Error("Profile editing did not complete.");
    const calls = response.output.filter((item) => item.type === "function_call");
    if (!calls.length) {
      if (!response.output_text.trim()) throw new Error("Profile editing returned no summary.");
      return response.output_text;
    }
    input.push(...responseHistory(response.output));
    for (const call of calls) {
      let result: unknown;
      try {
        const tool = tools.find((tool) => tool.name === call.name);
        if (!tool) throw new Error("Unknown profile tool.");
        result = await tool.execute(JSON.parse(call.arguments));
      } catch (error) {
        result = { error: (error as Error).message };
      }
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }
  }
}
