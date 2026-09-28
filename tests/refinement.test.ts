import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import { afterEach, expect, it, vi } from "vitest";
import type { AssistantContext } from "../server/application/assistant.js";
import { createAssistant, validateToolCalling } from "../server/assistant.js";
import { readSessionEvent, searchSessionEvidence } from "../server/ctx.js";
import { refineCapture, refinementLimits } from "../server/refinement.js";
import { createResearch, type ResearchTool } from "../server/research-tools.js";

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

it("researches profile, project and CTX evidence over multiple Responses turns with reasoning preserved", async () => {
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
  const model = await provider((_request, index) => {
    expect(_request.input[0]).toMatchObject({ type: "message", role: "user" });
    if (index === 0)
      return [reasoning, call("list_files", { scope: "profile", path: "", offset: 0 }, "list")];
    if (index === 1)
      return [
        call("read_file", { scope: "profile", path: "rules.md", offset: 0 }, "profile"),
        call("read_file", { scope: "project:one", path: "README.md", offset: 0 }, "project"),
        call(
          "search_history",
          { query: "onboarding", project: "project:one", since: null },
          "search",
        ),
      ];
    if (index === 2) return [call("read_history", { eventId: "abcdef12", offset: 0 }, "history")];
    return [message(interpretation)];
  });
  const assistant = createAssistant("test-key", "test", model.url, () =>
    createResearch([
      { id: "profile", name: "Profile", root: profile },
      { id: "project:one", name: "Activation", root: project },
    ]),
  );
  const result = await assistant?.interpret("Review onboarding", context);
  expect(result).toEqual(interpretation);
  expect(result?.sources).not.toContain("unused.md");
  expect(model.requests).toHaveLength(4);
  expect(model.requests[1].input).toContainEqual(reasoning);
  expect(model.requests[1].input.find((item) => item.type === "function_call")).not.toHaveProperty(
    "namespace",
  );
  expect(JSON.stringify(model.requests[3].input)).toContain("Activation owns");
  expect(JSON.stringify(model.requests[3].input)).toContain("team decided");
  expect(searchSessionEvidence).toHaveBeenLastCalledWith(
    "onboarding",
    project,
    undefined,
    expect.any(AbortSignal),
  );
  expect(readSessionEvent).toHaveBeenCalled();
});

it("requests structured clarification questions and supplies the previous brief and answers to the provider", async () => {
  const previousRefinement = {
    prompt: "Plan a demo.",
    rationale: "Identify the project and person.",
    sourcePaths: ["rules.md"],
    clarifications: [{ id: "0:0", question: "Which project?", answer: "Portal", resolved: false }],
  };
  const model = await provider((request) => {
    expect(JSON.parse(request.input[0].content ?? "").context.previousRefinement).toEqual(
      previousRefinement,
    );
    return [
      message({
        ...interpretation,
        sources: ["rules.md"],
        needsClarification: true,
        clarificationQuestions: ["Which Benjamin do you mean?"],
      }),
    ];
  });
  const result = await createAssistant("test-key", "test", model.url)?.interpret(
    "Plan a demo with Benjamin",
    { ...context, previousRefinement },
  );
  expect(result).toMatchObject({
    needsClarification: true,
    clarificationQuestions: ["Which Benjamin do you mean?"],
    sources: ["rules.md"],
  });
});

it("resolves capture links with web search and preserves citations across local research turns", async () => {
  const url = "https://example.com/";
  const web = {
    id: "ws_search",
    type: "web_search_call",
    status: "completed",
    action: { type: "search", sources: null },
  };
  const cited = message({ ...interpretation, sources: [url] });
  const annotated = {
    ...cited,
    content: [
      {
        ...cited.content[0],
        annotations: [
          { type: "url_citation", url, title: "Example Domain", start_index: 0, end_index: 1 },
        ],
      },
    ],
  };
  const model = await provider((request, index) => {
    expect(request.tools).toContainEqual({ type: "web_search" });
    if (index === 0) {
      expect(request.max_tool_calls).toBe(100);
      return [web, annotated, call("lookup", {}, "local")];
    }
    expect(request.max_tool_calls).toBe(98);
    return [message({ ...interpretation, sources: ["https://example.com", url] })];
  });
  const result = await createAssistant("test-key", "test", model.url, () => ({
    scopes: [],
    tools: [researchTool],
  }))?.interpret(`Review ${url}`, context);
  expect(result).toMatchObject({ sources: [url], needsClarification: false });
  expect(model.requests[1].input).toContainEqual(web);
});

it("continues after web-only turns and accepts retrieved URLs while rejecting invented ones", async () => {
  const urls = [
    "https://example.com/search",
    "https://example.com/page",
    "https://example.com/find",
  ];
  const model = await provider((_request, index) =>
    index === 0
      ? [
          {
            id: "ws_search",
            type: "web_search_call",
            status: "completed",
            action: { type: "search", sources: [{ type: "url", url: urls[0] }] },
          },
          {
            id: "ws_open",
            type: "web_search_call",
            status: "completed",
            action: { type: "open_page", url: urls[1] },
          },
          {
            id: "ws_find",
            type: "web_search_call",
            status: "completed",
            action: { type: "find_in_page", url: urls[2], pattern: "example" },
          },
        ]
      : [message({ ...interpretation, sources: [...urls, "https://invented.example/"] })],
  );
  const result = await createAssistant("test-key", "test", model.url)?.interpret(
    "Review these pages",
    context,
  );
  expect(result).toMatchObject({ sources: urls, needsClarification: true });
  expect(result?.rationale).toContain("citations were not retrieved");
});

it("marks failed web retrieval for review without accepting the failed URL", async () => {
  const model = await provider(() => [
    {
      id: "ws_failed",
      type: "web_search_call",
      status: "failed",
      action: { type: "open_page", url: "https://example.com/private" },
    },
    message({
      ...interpretation,
      kind: "note",
      updateProfile: true,
      sources: ["https://example.com/private"],
    }),
  ]);
  const result = await createAssistant("test-key", "test", model.url)?.interpret(
    "Remember this page",
    context,
  );
  expect(result).toMatchObject({ sources: [], needsClarification: true, updateProfile: false });
  expect(result?.rationale).toContain("Web search could not retrieve");
});

it("counts hosted web calls against the research budget before executing local tools", async () => {
  const execute = vi.fn(researchTool.execute);
  const model = await provider((request, index) => {
    if (index === 0)
      return [
        ...Array.from({ length: 100 }, (_, i) => ({
          id: `ws_${i}`,
          type: "web_search_call",
          status: "completed",
          action: { type: "search" },
        })),
        call("lookup", {}, "local"),
      ];
    expect(request.tool_choice).toBe("none");
    expect(request.max_tool_calls).toBeUndefined();
    return [message({ ...interpretation, sources: [] })];
  });
  const result = await createAssistant("test-key", "test", model.url, () => ({
    scopes: [],
    tools: [{ ...researchTool, execute }],
  }))?.interpret("Research", context);
  expect(execute).not.toHaveBeenCalled();
  expect(result?.rationale).toContain("safety budget");
});

it("can correct a missing file path without treating recovered evidence as incomplete", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-research-retry-"));
  writeFileSync(join(root, "rules.md"), "Verify in a browser.");
  const model = await provider((_request, index) => {
    if (index === 0)
      return [call("read_file", { scope: "profile", path: "wrong.md", offset: 0 }, "missing")];
    if (index === 1)
      return [call("read_file", { scope: "profile", path: "rules.md", offset: 0 }, "corrected")];
    return [message({ ...interpretation, sources: ["rules.md"] })];
  });
  const assistant = createAssistant("test-key", "test", model.url, () =>
    createResearch([{ id: "profile", name: "Profile", root }]),
  );
  const result = await assistant?.interpret("Review onboarding", context);
  expect(result).toMatchObject({ needsClarification: false, sources: ["rules.md"] });
  expect(JSON.stringify(model.requests[1].input)).toContain("locate the correct path");
});

it.each(["empty", "unavailable"])(
  "refines a self-contained capture with %s history without forcing clarification",
  async (history) => {
    if (history === "empty")
      vi.mocked(searchSessionEvidence).mockResolvedValueOnce({
        results: [],
        moreAvailable: false,
        coverage: "Existing CTX index only.",
      });
    else vi.mocked(searchSessionEvidence).mockRejectedValueOnce(new Error("CTX is unavailable"));
    const model = await provider((_request, index) =>
      index === 0
        ? [call("search_history", { query: "unknown", project: null, since: null }, "search")]
        : [message({ ...interpretation, sources: [] })],
    );
    const assistant = createAssistant("test-key", "test", model.url, () => createResearch([]));
    const result = await assistant?.interpret("Review onboarding", context);
    expect(result).toEqual({ ...interpretation, sources: [] });
    const output = model.requests[1].input.find((item) => item.type === "function_call_output");
    expect(JSON.parse(output?.output ?? "")).toEqual(
      history === "empty"
        ? { results: [], moreAvailable: false, coverage: "Existing CTX index only." }
        : { error: expect.stringContaining("History search is unavailable") },
    );
  },
);

it("preserves specific clarification questions when unavailable history leaves a material gap", async () => {
  vi.mocked(searchSessionEvidence).mockRejectedValueOnce(new Error("CTX is unavailable"));
  const clarified = {
    ...interpretation,
    sources: [],
    needsClarification: true,
    clarificationQuestions: ["Which onboarding change did you agree on?"],
  };
  const model = await provider((_request, index) =>
    index === 0
      ? [
          call(
            "search_history",
            { query: "onboarding agreement", project: null, since: null },
            "search",
          ),
        ]
      : [message(clarified)],
  );
  const assistant = createAssistant("test-key", "test", model.url, () => createResearch([]));
  expect(
    await assistant?.interpret("Implement the onboarding change we agreed on", context),
  ).toEqual(clarified);
});

it("marks fabricated citations for review even when history is unavailable without authorizing profile writes", async () => {
  vi.mocked(searchSessionEvidence).mockRejectedValueOnce(new Error("CTX is unavailable"));
  const model = await provider((_request, index) =>
    index === 0
      ? [call("search_history", { query: "unknown", project: null, since: null }, "search")]
      : [
          message({
            ...interpretation,
            kind: "note",
            updateProfile: true,
            sources: ["made-up.md"],
          }),
        ],
  );
  const assistant = createAssistant("test-key", "test", model.url, () => createResearch([]));
  const result = await assistant?.interpret("Remember my review preference", context);
  expect(result).toMatchObject({ needsClarification: true, updateProfile: false, sources: [] });
  expect(result?.rationale).toContain("citations were not retrieved");
  expect(result?.prompt).toContain("Clarify material gaps before dependent work");
  expect(JSON.stringify(model.requests[1].input)).toContain("History search is unavailable");
});

const researchTool: ResearchTool = {
  name: "lookup",
  description: "Retrieve context",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => ({ data: "Evidence", sources: [] }),
};

it("allows 100 research calls and then reserves a final response with review status", async () => {
  const execute = vi.fn(researchTool.execute);
  const parse = vi.fn(async (request: { tool_choice: string }) =>
    request.tool_choice === "none"
      ? { output: [], output_parsed: { ...interpretation, sources: [] } }
      : { output: [call("lookup", {}, `call_${execute.mock.calls.length}`)], output_parsed: null },
  );
  const client = { responses: { parse } } as unknown as OpenAI;
  const result = await refineCapture(client, "test", "", "Review", context, {
    scopes: [],
    tools: [{ ...researchTool, execute }],
  });
  expect(execute).toHaveBeenCalledTimes(100);
  expect(parse).toHaveBeenCalledTimes(101);
  expect(result.needsClarification).toBe(true);
  expect(result.rationale).toContain("safety budget");
});

it("stops research on timeout while allowing finalization after the research signal is aborted", async () => {
  vi.useFakeTimers();
  const execute = vi.fn(async (_input: unknown, signal: AbortSignal) => {
    await new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }),
    );
    return { data: "", sources: [] };
  });
  const parse = vi.fn(
    async (request: { tool_choice: string }, options: { signal?: AbortSignal }) => {
      if (request.tool_choice === "none") {
        expect(options.signal).toBeUndefined();
        return { output: [], output_parsed: { ...interpretation, sources: [] } };
      }
      return { output: [call("lookup", {}, "slow")], output_parsed: null };
    },
  );
  const result = refineCapture(
    { responses: { parse } } as unknown as OpenAI,
    "test",
    "",
    "Review",
    context,
    { scopes: [], tools: [{ ...researchTool, execute }] },
  );
  await vi.advanceTimersByTimeAsync(refinementLimits.milliseconds);
  expect((await result).needsClarification).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledTimes(2);
});

it("stops a growing context before another research turn and refuses unexpected finalization calls", async () => {
  const large = {
    ...context,
    profile: {
      directory: [],
      documents: [{ path: "large.md", content: "x".repeat(refinementLimits.contextCharacters) }],
    },
  };
  const parse = vi.fn(async (request: { tool_choice: string }) => {
    expect(request.tool_choice).toBe("none");
    return { output: [call("lookup", {}, "unexpected")], output_parsed: null };
  });
  await expect(
    refineCapture({ responses: { parse } } as unknown as OpenAI, "test", "", "Review", large, {
      scopes: [],
      tools: [researchTool],
    }),
  ).rejects.toThrow("did not finalize");
  expect(parse).toHaveBeenCalledTimes(1);
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
