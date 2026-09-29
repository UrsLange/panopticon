import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import type { RefinementContext, RefinementTool } from "../server/application/assistant.js";
import { capturedItem } from "../server/application/items.js";
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

const context: RefinementContext = {
  today: "2026-09-19",
  capture: capturedItem("Review onboarding", "capture", "2026-09-19T12:00:00.000Z"),
  linkedCaptures: [],
  referencesOnly: false,
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
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
async function provider(
  respond: (request: ModelRequest, index: number) => unknown[],
  usage?: { input_tokens: number; output_tokens: number },
) {
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
        usage,
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
  const complete: RefinementTool = {
    name: "complete_refinement",
    description: "Finish refinement",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ data: { completed: true }, sources: [] }),
  };
  return { tool, execute, tools: [tool, complete] };
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

it("allows 120 seconds for each refinement request", async () => {
  const client = new OpenAI({ apiKey: "test-key", timeout: 45000 });
  const request = vi.spyOn(client.responses, "create").mockRejectedValueOnce(new Error("Stopped"));
  await expect(
    refineCapture(client, "test", "", "Input", context, { scopes: [], tools: [] }, []),
  ).rejects.toThrow("Stopped");
  expect(request).toHaveBeenCalledWith(expect.any(Object), { timeout: 120000 });
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
    return [call("complete_refinement", {}, "complete")];
  });
  const assistant = createAssistant("test-key", "test", model.url, () =>
    createResearch([
      { id: "profile", name: "Profile", root: profile },
      { id: "project:one", name: "Activation", root: project },
    ]),
  );
  assert(assistant);
  await assistant.interpret("Review onboarding", context, [captureTool, ...saved.tools]);
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
  await expect(
    assistant?.interpret(
      "Plan the demo",
      { ...context, capture: { ...context.capture, ...previous } },
      [],
    ),
  ).rejects.toThrow("complete_refinement");
  expect(JSON.parse(model.requests[0].input[0].content ?? "")).toMatchObject({
    capture: "Plan the demo",
    context: { capture: previous },
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
          : [call("complete_refinement", {}, "complete")],
    );
    const assistant = createAssistant("test-key", "test", model.url, () => createResearch([]));
    await assistant?.interpret("Call Anna", context, saved.tools);
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
      : [call("complete_refinement", {}, "complete")],
  );
  await createAssistant("test-key", "test", model.url)?.interpret("A clear task", context, [
    ...saved.tools,
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
        : [call("complete_refinement", {}, "complete")],
  );
  await createAssistant("test-key", "test", model.url, () =>
    createResearch([{ id: "profile", name: "Profile", root }]),
  )?.interpret("A task", context, saved.tools);
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
        : [call("complete_refinement", {}, "complete")],
  );
  await createAssistant("test-key", "test", model.url)?.interpret(`Review ${url}`, context, [
    ...saved.tools,
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

it("saves and completes a simple task in one model request", async () => {
  const saved = saveTool();
  const model = await provider(() => [
    call("save_refinement", { sources: [], prompt: "Buy milk." }, "save"),
    call("complete_refinement", {}, "complete"),
  ]);
  await createAssistant("test-key", "test", model.url)?.interpret("Buy milk", context, saved.tools);
  expect(saved.execute).toHaveBeenCalledTimes(1);
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]).toHaveProperty("parallel_tool_calls", true);
});

it("runs independent reads together and preserves barriers around ordered changes", async () => {
  const saved = saveTool();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readers: RefinementTool[] = ["first", "second", "after"].map((name) => ({
    name,
    readOnly: true,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      events.push(name);
      if (name === "first") await gate;
      if (name === "second") release();
      return { data: name, sources: [name] };
    },
  }));
  saved.execute.mockImplementation(async (input) => {
    const { step } = input as { step: string };
    events.push(`${step}:start`);
    await Promise.resolve();
    events.push(`${step}:end`);
    return { data: input, sources: [] };
  });
  const model = await provider(() => [
    call("first", {}, "first"),
    call("second", {}, "second"),
    call("save_refinement", { step: "one", sources: ["first", "second"] }, "one"),
    call("save_refinement", { step: "two", sources: [] }, "two"),
    call("after", {}, "after"),
    call("complete_refinement", {}, "complete"),
  ]);
  await createAssistant("test-key", "test", model.url)?.interpret("A task", context, [
    ...readers,
    ...saved.tools,
  ]);
  expect(events).toEqual([
    "first",
    "second",
    "one:start",
    "one:end",
    "two:start",
    "two:end",
    "after",
  ]);
  expect(model.requests).toHaveLength(1);
});

it("does not complete after a failed change in the same response", async () => {
  const saved = saveTool();
  const complete = vi.spyOn(saved.tools[1], "execute");
  const model = await provider((_request, index) => [
    call("save_refinement", { sources: index ? [] : ["invented.md"] }, `save${index}`),
    call("complete_refinement", {}, `complete${index}`),
  ]);
  await createAssistant("test-key", "test", model.url)?.interpret("A task", context, saved.tools);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(saved.execute).toHaveBeenCalledTimes(1);
  expect(model.requests).toHaveLength(2);
  expect(JSON.stringify(model.requests[1].input)).toContain("preceding change failed");
});

it("requires completion to be the last call", async () => {
  const saved = saveTool();
  const complete = vi.spyOn(saved.tools[1], "execute");
  const model = await provider((_request, index) =>
    index === 0
      ? [call("complete_refinement", {}, "early"), call("save_refinement", { sources: [] }, "save")]
      : [call("complete_refinement", {}, "complete")],
  );
  await createAssistant("test-key", "test", model.url)?.interpret("A task", context, saved.tools);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(model.requests[1].input)).toContain("complete_refinement last");
});

it("logs request and tool timings, usage and failures without logging private content", async () => {
  const saved = saveTool();
  saved.execute.mockRejectedValueOnce(new Error("private tool failure"));
  const model = await provider(
    (_request, index) => [
      call("save_refinement", { sources: [], prompt: "private tool argument" }, `save${index}`),
      ...(index ? [call("complete_refinement", {}, "complete")] : []),
    ],
    { input_tokens: 100, output_tokens: 25 },
  );
  await createAssistant("test-key", "test", model.url)?.interpret(
    "private capture",
    context,
    saved.tools,
  );
  const logs = vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(line));
  expect(new Set(logs.map((event) => event.runId)).size).toBe(1);
  expect(logs.every((event) => event.itemId === context.capture.id)).toBe(true);
  expect(logs.filter((event) => event.event === "capture_refinement.request_started")).toHaveLength(
    2,
  );
  expect(logs.filter((event) => event.event === "capture_refinement.request_finished")).toEqual([
    expect.objectContaining({
      request: 1,
      durationMs: expect.any(Number),
      usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: null, reasoningTokens: null },
    }),
    expect.objectContaining({ request: 2, durationMs: expect.any(Number) }),
  ]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "capture_refinement.tool_finished",
      tool: "save_refinement",
      status: "failed",
      durationMs: expect.any(Number),
    }),
  );
  expect(logs.at(-1)).toMatchObject({
    event: "capture_refinement.finished",
    status: "completed",
    requests: 2,
    toolCalls: 3,
    toolFailures: 1,
    usageRequests: 2,
    inputTokens: 200,
    outputTokens: 50,
  });
  expect(JSON.stringify(logs)).not.toContain("private");
  expect(JSON.stringify(logs)).not.toContain("test-key");
});

it("logs provider timeouts and reports missing usage without inventing zero token counts", async () => {
  const client = new OpenAI({ apiKey: "test-key" });
  vi.spyOn(client.responses, "create").mockRejectedValueOnce(
    new OpenAI.APIConnectionTimeoutError(),
  );
  await expect(
    refineCapture(client, "test", "", "Input", context, { scopes: [], tools: [] }, []),
  ).rejects.toThrow("timed out");
  const logs = vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(line));
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "capture_refinement.request_finished",
      status: "failed",
      timedOut: true,
      durationMs: expect.any(Number),
    }),
  );
  expect(logs.at(-1)).toMatchObject({
    status: "failed",
    requests: 1,
    toolCalls: 0,
    usageRequests: 0,
    inputTokens: null,
    outputTokens: null,
  });
});
