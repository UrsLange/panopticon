import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { createAssistant } from "../server/assistant.js";
import { prompts } from "../server/prompts.js";

it("runs tools until the model finishes, preserves tool history, and lets the model recover from tool errors", async () => {
  const requests: Record<string, unknown>[] = [];
  const execute = vi.fn((input: unknown) => {
    if (!(input as { repaired?: boolean }).repaired) throw new Error("Choose a unique passage.");
    return { saved: "profile.md" };
  });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const step = requests.length;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: `response_${step}`,
        object: "response",
        status: "completed",
        output:
          step < 3
            ? [
                {
                  type: "function_call",
                  id: `fc_${step}`,
                  call_id: `call_${step}`,
                  name: "edit_file",
                  arguments: JSON.stringify({ repaired: step === 2 }),
                  status: "completed",
                },
              ]
            : [
                {
                  type: "message",
                  id: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: "Updated and checked the profile.",
                      annotations: [],
                    },
                  ],
                },
              ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const assistant = createAssistant("test-key", "test-model", `http://127.0.0.1:${port}/v1`);
    if (!assistant) throw new Error("Missing test assistant");
    const workspace = {
      profileRoot: "/profile",
      activityPath: "/artifacts/activity.json",
      provisionalMemoryPath: "/artifacts/memory.md",
    };
    const summary = await assistant.consolidateProfile(workspace, [
      {
        name: "edit_file",
        description: "Edit a document",
        parameters: {
          type: "object",
          properties: { repaired: { type: "boolean" } },
          required: ["repaired"],
          additionalProperties: false,
        },
        execute,
      },
    ]);
    expect(summary).toBe("Updated and checked the profile.");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(requests[0]).toMatchObject({
      store: false,
      instructions: prompts["profile-consolidation"],
      parallel_tool_calls: false,
    });
    expect(requests[0]).not.toHaveProperty("text");
    expect(requests[0]).not.toHaveProperty("max_tool_calls");
    expect(requests[0]).not.toHaveProperty("max_output_tokens");
    expect(JSON.parse((requests[0].input as { content: string }[])[0].content)).toEqual(workspace);
    expect(requests[1].input).toEqual(
      expect.arrayContaining([
        {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ error: "Choose a unique passage." }),
        },
      ]),
    );
    expect(requests[2].input).toEqual(
      expect.arrayContaining([
        {
          type: "function_call_output",
          call_id: "call_2",
          output: JSON.stringify({ saved: "profile.md" }),
        },
      ]),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
