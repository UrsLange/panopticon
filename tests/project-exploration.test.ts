import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectExploration } from "../server/application/exploration.js";
import { parseConcept } from "../server/application/profile-document.js";
import { end, start } from "../server/application/project-documents.js";
import { config } from "../server/config.js";
import { Profile } from "../server/profile.js";
import { explorationLimits, exploreProject } from "../server/project-exploration.js";
import { createProjectScanner } from "../server/projects.js";
import { SettingsStore } from "../server/settings.js";

const connection = {
  apiKey: "discovery-key",
  baseURL: "https://provider.example/v1",
  model: "selected-model",
};
const findings = {
  summary: "## Purpose\nTeam onboarding. See README.md.",
  sources: ["repository/README.md"],
  complete: true,
};
const call = (name: string, args: unknown, id = name) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: id,
  name,
  arguments: JSON.stringify(args),
  namespace: null,
});
const readme = call("read_file", { scope: "repository", path: "README.md", offset: 0 });
const message = (value: unknown) => ({
  type: "message",
  id: "msg_test",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }],
});
type ModelRequest = {
  model: string;
  store: boolean;
  input: { type?: string; content?: string; output?: string; namespace?: string }[];
  tools: { name: string }[];
  tool_choice: string;
};
function provider(
  respond: (request: ModelRequest, index: number) => unknown[] | Response | Promise<Response>,
) {
  const requests: ModelRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.url).toBe(`${connection.baseURL}/responses`);
    expect(request.headers.get("Authorization")).toBe(`Bearer ${connection.apiKey}`);
    expect(request.redirect).toBe("error");
    const body = (await request.json()) as ModelRequest;
    requests.push(body);
    const output = await respond(body, requests.length - 1);
    return output instanceof Response
      ? output
      : Response.json({
          id: `resp_${requests.length}`,
          object: "response",
          status: "completed",
          output,
        });
  });
  vi.stubGlobal("fetch", fetch);
  return { requests, fetch };
}
function fixture(previous = "Old summary") {
  const root = mkdtempSync(join(tmpdir(), "pa-exploration-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  writeFileSync(join(repository, "README.md"), "A project for team onboarding.");
  const content = `---\ntype: Project\ntitle: 'Literal ${start}'\ncustom: keep\n---\n\n${start}\n${previous}\n${end}\n\n## Personal notes\nPrivate note.\n\n`;
  const document = { ...parseConcept(content, "project.md"), hash: "before" };
  const request: ProjectExploration = { repository, document, model: connection.model };
  return { root, request };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("uses the configured connection, researches files and returns a draft with protected content intact", async () => {
  const { request } = fixture();
  const reasoning = {
    type: "reasoning",
    id: "rs_test",
    summary: [],
    encrypted_content: "reasoning",
  };
  const model = provider((_request, index) => {
    if (index === 0)
      return [reasoning, call("list_files", { scope: "repository", path: "", offset: 0 })];
    if (index === 1) return [readme];
    return [message(findings)];
  });
  const progress = vi.fn();
  const draft = await exploreProject({ ...request, onProgress: progress }, connection);
  expect(draft).toBe(request.document.content.replace("Old summary", findings.summary));
  expect(request.document.content).toContain("Old summary");
  expect(readFileSync(join(request.repository, "README.md"), "utf8")).toBe(
    "A project for team onboarding.",
  );
  expect(model.requests).toHaveLength(3);
  for (const input of model.requests) {
    expect(input).toMatchObject({ model: connection.model, store: false });
    expect(input.tools.map((tool) => tool.name)).toEqual([
      "list_files",
      "search_files",
      "read_file",
    ]);
    expect(JSON.stringify(input)).not.toContain("Private note");
    expect(JSON.stringify(input)).not.toContain(request.repository);
  }
  expect(model.requests[1].input).toContainEqual(reasoning);
  expect(model.requests[1].input.find((item) => item.type === "function_call")).not.toHaveProperty(
    "namespace",
  );
  expect(JSON.stringify(model.requests[2])).toContain("A project for team onboarding.");
  expect(progress).toHaveBeenCalledWith({ phase: "reading", filesRead: 1 });
  expect(progress).toHaveBeenCalledWith({ responseId: "resp_3" });
  expect(progress).toHaveBeenLastCalledWith({ phase: "validating" });
});

it("preserves the entire document when the reviewed summary is unchanged", async () => {
  const { request } = fixture(findings.summary);
  provider((_input, index) => (index === 0 ? [readme] : [message(findings)]));
  expect(await exploreProject(request, connection)).toBe(request.document.content);
});

it("recovers a mistaken path and supports paginated reads and content search", async () => {
  const { request } = fixture();
  writeFileSync(join(request.repository, "README.md"), `${"x".repeat(12000)}Team onboarding`);
  const model = provider((_input, index) => {
    if (index === 0)
      return [call("read_file", { scope: "repository", path: "missing.md", offset: 0 })];
    if (index === 1)
      return [
        call("search_files", { scope: "repository", path: "", query: "onboarding", offset: 0 }),
      ];
    if (index === 2) return [readme];
    if (index === 3)
      return [call("read_file", { scope: "repository", path: "README.md", offset: 12000 })];
    return [message(findings)];
  });
  const progress = vi.fn();
  await exploreProject({ ...request, onProgress: progress }, connection);
  expect(JSON.stringify(model.requests[1])).toContain("Context lookup failed");
  expect(JSON.stringify(model.requests[3])).toContain('\\"nextOffset\\":12000');
  expect(JSON.stringify(model.requests[4])).toContain("Team onboarding");
  expect(progress).toHaveBeenCalledWith({ phase: "reading", filesRead: 1 });
  expect(progress).not.toHaveBeenCalledWith({ phase: "reading", filesRead: 2 });
});

it("blocks private files, escaped paths and unoffered tools without sending their contents", async () => {
  const { request, root } = fixture();
  writeFileSync(join(root, "private.md"), "private-outside-data");
  writeFileSync(join(request.repository, ".env"), "private-env-data");
  writeFileSync(join(request.repository, "access-token.txt"), "private-token-data");
  symlinkSync(join(root, "private.md"), join(request.repository, "link.md"));
  const model = provider((_input, index) =>
    index === 0
      ? [
          ...["../private.md", ".env", "access-token.txt", "link.md"].map((path) =>
            call("read_file", { scope: "repository", path, offset: 0 }, path),
          ),
          call("read_file", { scope: "profile", path: "project.md", offset: 0 }, "profile"),
          call("search_history", { query: "private" }),
          call("write_file", { path: "README.md", content: "Changed" }),
        ]
      : [message({ ...findings, complete: false })],
  );
  await expect(exploreProject(request, connection)).rejects.toMatchObject({
    diagnostic: { category: "incomplete" },
  });
  const results = model.requests[1].input.filter((item) => item.type === "function_call_output");
  expect(results).toHaveLength(7);
  expect(results.every((item) => item.output?.includes("Context lookup failed"))).toBe(true);
  expect(JSON.stringify(model.requests)).not.toMatch(/private-(outside|env|token)-data/);
  expect(readFileSync(join(request.repository, "README.md"), "utf8")).toContain("team onboarding");
});

it.each([
  ["unread evidence", findings, false, "incomplete"],
  ["unfinished review", { ...findings, complete: false }, true, "incomplete"],
  ["invented citations", { ...findings, sources: ["repository/invented.md"] }, true, "incomplete"],
  ["empty summary", { ...findings, summary: " " }, true, "invalid-output"],
  ["injected markers", { ...findings, summary: start }, true, "invalid-output"],
  ["invalid structure", { text: "not a summary" }, true, "invalid-output"],
])("rejects %s without changing the profile", async (_label, result, read, category) => {
  const { request } = fixture();
  const before = request.document.content;
  provider((_input, index) => (index === 0 && read ? [readme] : [message(result)]));
  await expect(exploreProject(request, connection)).rejects.toMatchObject({
    diagnostic: { category },
  });
  expect(request.document.content).toBe(before);
});

it("retains provider status without exposing response bodies or retrying", async () => {
  const { request } = fixture();
  const model = provider(() =>
    Response.json({ error: { message: "sensitive-provider-body" } }, { status: 503 }),
  );
  const failure = await exploreProject(request, connection).catch((error) => error);
  expect(failure.diagnostic).toMatchObject({ category: "provider", statusCode: 503 });
  expect(failure.message).toContain("HTTP 503");
  expect(JSON.stringify(failure)).not.toContain("sensitive-provider-body");
  expect(model.fetch).toHaveBeenCalledTimes(1);
});

it("rejects incomplete provider responses", async () => {
  const { request } = fixture();
  provider(() =>
    Response.json({ id: "resp_incomplete", object: "response", status: "incomplete", output: [] }),
  );
  await expect(exploreProject(request, connection)).rejects.toMatchObject({
    diagnostic: { category: "incomplete" },
  });
});

it("caps tool calls and rejects a provider that continues after finalization", async () => {
  const { request } = fixture();
  const model = provider((_input, index) => [
    call("read_file", { scope: "repository", path: "README.md", offset: 0 }, `read_${index}`),
  ]);
  await expect(exploreProject(request, connection)).rejects.toMatchObject({
    diagnostic: { category: "tool-limit" },
  });
  expect(model.requests).toHaveLength(explorationLimits.calls + 1);
  expect(model.requests.at(-1)?.tool_choice).toBe("none");
});

it("stops oversized context before sending it to the provider", async () => {
  const { request } = fixture("x".repeat(explorationLimits.contextCharacters));
  const model = provider(() => [message(findings)]);
  await expect(exploreProject(request, connection)).rejects.toMatchObject({
    diagnostic: { category: "context-limit" },
  });
  expect(model.fetch).not.toHaveBeenCalled();
});

it("does not apply a response arriving after the discovery deadline", async () => {
  vi.useFakeTimers();
  const { request } = fixture();
  provider(async () => {
    await vi.advanceTimersByTimeAsync(explorationLimits.milliseconds);
    return Response.json({
      id: "resp_late",
      object: "response",
      status: "completed",
      output: [message(findings)],
    });
  });
  await expect(exploreProject(request, connection)).rejects.toMatchObject({
    diagnostic: { category: "timeout" },
  });
});

it("wires discovery to saved credentials and applies only a validated summary", async () => {
  const { request, root } = fixture();
  execFileSync("git", ["init", request.repository], { stdio: "ignore" });
  const profile = new Profile(join(root, "profile"));
  profile.initialize();
  const settings = new SettingsStore({
    ...config,
    dataDir: join(root, "data"),
    profileDir: profile.root,
    apiKey: "wrong-default",
    keyFile: "",
  });
  settings.saveValidated(connection, connection.baseURL);
  settings.saveProjectRoots([root]);
  const model = provider((_input, index) => (index === 0 ? [readme] : [message(findings)]));
  const scanner = createProjectScanner(settings);
  await scanner.run();
  expect(scanner.status().error).toBeNull();
  expect(scanner.status().projects[0]).toMatchObject({
    outcome: "updated",
    model: connection.model,
    filesRead: 1,
    responseId: "resp_2",
  });
  expect(profile.documents().find((doc) => doc.type === "Project")?.content).toContain(
    findings.summary,
  );
  await scanner.run();
  expect(model.requests).toHaveLength(2);
  expect(scanner.status().projects[0].outcome).toBe("unchanged");
});
