import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { AssistantContext, RefinementTool } from "../server/application/assistant.js";
import { createAssistant, validateToolCalling } from "../server/assistant.js";
import { readSessionEvent, searchSessionEvidence } from "../server/ctx.js";
import { refineCapture } from "../server/refinement.js";
import { createResearch } from "../server/research-tools.js";

vi.mock("../server/ctx.js", () => ({
  searchSessionEvidence: vi.fn(async () => ({
    results: [{ ctx_event_id: "abcdef12", snippet: "Check browser behavior" }],
  })),
  readSessionEvent: vi.fn(
    async () => "The team decided to verify the onboarding flow in a browser.",
  ),
}));

const context: AssistantContext = {
  today: "2026-09-19",
  candidates: [],
  references: [],
  people: null,
  profile: { directory: [], documents: [{ path: "unused.md", content: "Unrelated preference" }] },
  related: [],
  commitments: { date: "2026-09-19", due: [], suggested: [], waiting: [] },
};
const interpretation = {
  title: "Review onboarding",
  kind: "commitment",
  project: "Activation",
  dueDate: null,
  priority: "normal",
  relatedId: null,
  referenceIds: [],
  rationale: "Supported by prior work.",
  needsClarification: false,
  clarificationQuestions: [],
  updateProfile: false,
  prompt: "Review the onboarding invitation flow and verify it in a browser.",
  sources: ["rules.md", "project:one/README.md", "ctx:abcdef12"],
};
const message = (value: unknown) => ({
  type: "message",
  id: "msg_result",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }],
});
const call = (name: string, input: unknown, id: string) => ({
  type: "function_call",
  id: `fc_${id}`,
  name,
  arguments: JSON.stringify(input),
  call_id: id,
  namespace: null,
});
type ModelRequest = {
  input: { type?: string; role?: string; content?: string; output?: string }[];
  tool_choice: unknown;
  instructions: string;
  tools: { type: string }[];
  max_tool_calls?: number;
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) await close();
});
async function provider(respond: (request: ModelRequest, index: number) => unknown[]) {
  const requests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as ModelRequest;
    requests.push(input);
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: `resp_${requests.length}`,
        object: "response",
        status: "completed",
        output: respond(input, requests.length - 1),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

function saveTool() {
  const execute = vi.fn(async (input: unknown) => ({ data: input, sources: [] as string[] }));
  const tool: RefinementTool = {
    name: "save_refinement",
    description: "Save a refinement",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute,
  };
  return { tool, execute };
}

it.each([
  [
    new OpenAI.APIConnectionTimeoutError(),
    "The model provider request timed out. Retry refinement.",
  ],
  [
    new OpenAI.APIConnectionError({ message: "private connection details" }),
    "The model provider could not be reached. Check your connection and model settings.",
  ],
  [
    new OpenAI.APIError(
      429,
      { message: "private provider details" },
      "private response",
      undefined,
    ),
    "The model provider returned HTTP 429. Check provider availability and access, then retry.",
  ],
])("preserves provider failures with a safe summary", async (error, message) => {
  const client = new OpenAI({ apiKey: "test-key" });
  vi.spyOn(client.responses, "create").mockRejectedValueOnce(error);
  await expect(
    refineCapture(client, "test", "", "Input", context, { scopes: [], tools: [] }, []),
  ).rejects.toMatchObject({ message, cause: error });
});

it("retains profile, project, CTX and capture evidence across tool turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-refinement-"));
  const profile = join(root, "profile"),
    project = join(root, "project");
  mkdirSync(profile);
  mkdirSync(project);
  writeFileSync(join(profile, "rules.md"), "Verify interactive changes in a browser.");
  writeFileSync(join(project, "README.md"), "Activation owns the onboarding invitation flow.");
  const reasoning = {
    type: "reasoning",
    id: "rs_test",
    summary: [],
    encrypted_content: "encrypted-test-reasoning",
  };
  const saved = saveTool();
  const evidence = [...interpretation.sources, "capture:earlier"];
  const captureTool: RefinementTool = {
    name: "search_captures",
    description: "Search captures",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({
      data: { text: "Earlier capture: keep the invitation optional." },
      sources: ["capture:earlier"],
    }),
  };
  const model = await provider((_request, index) => {
    if (index === 0)
      return [
        reasoning,
        call("read_file", { scope: "profile", path: "rules.md", offset: 0 }, "profile"),
      ];
    if (index === 1)
      return [call("read_file", { scope: "project:one", path: "README.md", offset: 0 }, "project")];
    if (index === 2)
      return [
        call(
          "search_history",
          { query: "onboarding", project: "project:one", since: null },
          "search",
        ),
      ];
    if (index === 3) return [call("read_history", { eventId: "abcdef12", offset: 0 }, "history")];
    if (index === 4) return [call("search_captures", {}, "captures")];
    if (index === 5)
      return [call("save_refinement", { ...interpretation, sources: evidence }, "save")];
    return [message("Saved")];
  });
  const assistant = createAssistant("test-key", "test", model.url, () =>
    createResearch([
      { id: "profile", name: "Profile", root: profile },
      { id: "project:one", name: "Activation", root: project },
    ]),
  );
  assert(assistant);
  await assistant.interpret("Review onboarding", context, [captureTool, saved.tool]);
  expect(saved.execute).toHaveBeenCalledWith(
    expect.objectContaining({ sources: evidence }),
    expect.any(AbortSignal),
  );
  expect(model.requests[1].input).toContainEqual(reasoning);
  expect(model.requests[1].input.find((item) => item.type === "function_call")).not.toHaveProperty(
    "namespace",
  );
  expect(JSON.stringify(model.requests[5].input)).toContain("Activation owns");
  expect(JSON.stringify(model.requests[5].input)).toContain("team decided");
  expect(JSON.stringify(model.requests[5].input)).toContain("Earlier capture");
  expect(searchSessionEvidence).toHaveBeenLastCalledWith(
    "onboarding",
    project,
    undefined,
    expect.any(AbortSignal),
  );
  expect(readSessionEvent).toHaveBeenCalled();
  expect(model.requests[0]).not.toHaveProperty("text");
  expect(model.requests[0]).not.toHaveProperty("max_tool_calls");
});

it("supplies the original capture and previous answers without a separate rationale", async () => {
  const previous = {
    prompt: "Plan a demo.",
    rationale: "",
    sourcePaths: [],
    clarifications: [{ id: "q", question: "Which project?", answer: "Portal", resolved: false }],
  };
  const model = await provider(() => [message("No save")]);
  const assistant = createAssistant("test-key", "test", model.url);
  await assistant?.interpret("Plan the demo", { ...context, previousRefinement: previous }, []);
  expect(JSON.parse(model.requests[0].input[0].content ?? "")).toMatchObject({
    capture: "Plan the demo",
    context: { previousRefinement: previous },
  });
});

it.each(["empty", "unavailable"])(
  "keeps %s history from forcing artificial clarification",
  async (failure) => {
    vi.mocked(searchSessionEvidence).mockImplementationOnce(async () => {
      if (failure === "unavailable") throw new Error("History unavailable");
      return { results: [], moreAvailable: false, coverage: "complete" };
    });
    const saved = saveTool();
    const model = await provider((_request, index) =>
      index === 0
        ? [call("search_history", { query: "onboarding", project: null, since: null }, "history")]
        : index === 1
          ? [
              call(
                "save_refinement",
                { sources: [], clarificationQuestions: [], prompt: "Call Anna." },
                "save",
              ),
            ]
          : [message("Saved")],
    );
    const assistant = createAssistant("test-key", "test", model.url, () => createResearch([]));
    await assistant?.interpret("Call Anna", context, [saved.tool]);
    expect(saved.execute).toHaveBeenCalledWith(
      { sources: [], clarificationQuestions: [], prompt: "Call Anna." },
      expect.any(AbortSignal),
    );
  },
);

it("rejects invented citations as a tool error and lets the agent repair the save", async () => {
  const saved = saveTool();
  const model = await provider((_request, index) =>
    index < 2
      ? [
          call(
            "save_refinement",
            { sources: index === 0 ? ["invented.md"] : [], clarificationQuestions: [] },
            `save${index}`,
          ),
        ]
      : [message("Saved")],
  );
  await createAssistant("test-key", "test", model.url)?.interpret("A clear task", context, [
    saved.tool,
  ]);
  expect(saved.execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(model.requests[1].input)).toContain("unsupported citation");
});

it("recovers a missing file path without changing the saved outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-refinement-file-"));
  writeFileSync(join(root, "rules.md"), "Use focused commits.");
  const saved = saveTool();
  const model = await provider((_request, index) =>
    index < 2
      ? [
          call(
            "read_file",
            { scope: "profile", path: index ? "rules.md" : "missing.md", offset: 0 },
            `read${index}`,
          ),
        ]
      : index === 2
        ? [call("save_refinement", { sources: ["rules.md"], clarificationQuestions: [] }, "save")]
        : [message("Saved")],
  );
  await createAssistant("test-key", "test", model.url, () =>
    createResearch([{ id: "profile", name: "Profile", root }]),
  )?.interpret("A task", context, [saved.tool]);
  expect(saved.execute).toHaveBeenCalledWith(
    { sources: ["rules.md"], clarificationQuestions: [] },
    expect.any(AbortSignal),
  );
});

it("retains hosted web citations across web-only and local tool turns", async () => {
  const url = "https://example.com/guide";
  const saved = saveTool();
  const model = await provider((_request, index) =>
    index === 0
      ? [
          {
            type: "web_search_call",
            id: "web",
            status: "completed",
            action: { type: "open_page", url },
          },
        ]
      : index === 1
        ? [call("save_refinement", { sources: [url] }, "save")]
        : [message("Saved")],
  );
  await createAssistant("test-key", "test", model.url)?.interpret(`Review ${url}`, context, [
    saved.tool,
  ]);
  expect(saved.execute).toHaveBeenCalledWith({ sources: [url] }, expect.any(AbortSignal));
});

it("rejects a provider that ignores a required validation tool call", async () => {
  const model = await provider((request) => {
    expect(request.input[0]).toMatchObject({ type: "message", role: "user" });
    return [message({ value: "invented" })];
  });
  await expect(validateToolCalling("test-key", "test", model.url)).rejects.toThrow(
    "did not perform",
  );
});
