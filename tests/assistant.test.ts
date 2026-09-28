import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { AssistantContext } from "../server/application/assistant.js";
import { createAssistant } from "../server/assistant.js";
import { prompts } from "../server/prompts.js";

it("uses Responses structured outputs and limits returned citations to supplied evidence", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const output =
      requests.length === 1
        ? {
            title: "Onboarding idea",
            kind: "idea",
            project: "Activation",
            dueDate: null,
            priority: "normal",
            relatedId: null,
            rationale: "Tentative suggestion",
            needsClarification: false,
            clarificationQuestions: [],
            updateProfile: false,
            referenceIds: [],
            prompt: "Explore inviting a colleague to onboarding.",
            sources: [],
          }
        : requests.length === 2
          ? { answer: "You sponsor Activation.", sources: ["profile.md", "invented.md"] }
          : {
              summary: "Kept a useful unresolved implication.",
              paths: [],
              changes: [],
              provisionalMemory:
                "An upcoming launch is suggested, but its scope remains ambiguous.",
            };
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: "resp_test",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "test-model",
        output: [
          {
            type: "message",
            id: "msg_test",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }],
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const assistant = createAssistant("test-key", "test-model", `http://127.0.0.1:${port}/v1`);
    expect(assistant).not.toBeNull();
    if (!assistant) throw new Error("Test assistant missing");
    const context: AssistantContext = {
      candidates: [],
      references: [],
      people: null,
      today: "2026-09-17",
      profile: {
        directory: [],
        documents: [{ path: "profile.md", content: "I sponsor Activation." }],
      },
      related: [],
      commitments: { date: "2026-09-17", due: [], suggested: [], waiting: [] },
    };
    expect((await assistant.interpret("Perhaps we could invite a colleague", context)).kind).toBe(
      "idea",
    );
    const answer = await assistant.ask("What is my role?", context, [], "");
    expect(answer.sources).toEqual(["profile.md"]);
    expect(requests[0].store).toBe(false);
    expect(requests[0].text).toMatchObject({ format: { type: "json_schema", strict: true } });
    expect(JSON.parse((requests[0].input as { content: string }[])[0].content).context.today).toBe(
      "2026-09-17",
    );
    const consolidationInput = {
      documents: [
        {
          path: "profile.md",
          title: "Profile",
          type: "Profile",
          description: "Context",
          hash: "hash",
          content: "Full context ".repeat(2000),
        },
      ],
      activity: [
        {
          id: 12,
          kind: "capture" as const,
          content: "Prepare the partner briefing.",
          createdAt: "2026-09-17T10:00:00Z",
        },
      ],
      provisionalMemory: "Earlier candidate with its original evidence.",
      date: "2026-09-17",
      timezone: "Europe/Berlin",
    };
    const consolidated = await assistant.consolidateProfile(consolidationInput);
    expect(consolidated.provisionalMemory).toContain("upcoming launch");
    expect(JSON.parse(requests[2].input as string)).toEqual(consolidationInput);
    expect(requests[2]).toMatchObject({
      store: false,
      instructions: prompts["profile-consolidation"],
      text: { format: { name: "profile_consolidation", strict: true } },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
