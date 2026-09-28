import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ProjectExploration } from "../server/application/exploration.js";
import { end, start } from "../server/application/project-documents.js";
import { Profile } from "../server/profile.js";
import { exploreProject } from "../server/project-exploration.js";

const connection = {
  apiKey: "discovery-key",
  baseURL: "https://provider.example/v1",
  model: "selected-model",
};
const call = (name: string, args: unknown, id = name) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: id,
  name,
  arguments: JSON.stringify(args),
  namespace: null,
});
const readme = call("read_repository_file", { scope: "repository", path: "README.md", offset: 0 });
const message = (value: unknown) => ({
  type: "message",
  id: "msg_test",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: String(value), annotations: [] }],
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
  const profile = new Profile(join(root, "profile"));
  profile.initialize();
  const document = profile.change("add project", () => profile.create("Project", "Project", ""));
  profile.change("seed project knowledge", () =>
    profile.save(
      document.path,
      content.replace(
        "custom: keep",
        "custom: keep\nrepository_id: test-project\nrepository_name: repository\nproject_discovery: true",
      ),
      document.hash,
    ),
  );
  const current = profile.documents().find((doc) => doc.path === document.path);
  assert(current);
  const request: ProjectExploration = {
    repository,
    profileRoot: profile.root,
    document: current,
    model: connection.model,
    validateSource: async () => {},
  };
  return { root, request, profile };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function successfulReview(request: ProjectExploration, reorganization = false) {
  return (_input: ModelRequest, index: number) => {
    if (index === 0) return [readme];
    if (index === 1)
      return [call("read_file", { path: request.document.path, startLine: null, endLine: null })];
    if (index === 2)
      return [
        call("write_file", {
          path: request.document.path,
          content: request.document.content
            .replace("Old summary", "## Purpose\nTeam onboarding. See README.md.")
            .replace(
              "## Personal notes",
              reorganization ? "## Working context" : "## Personal notes",
            ),
        }),
      ];
    if (index === 3) return [call("profile_diff", {})];
    if (index === 4) return [call("commit_profile", { summary: "refresh project knowledge" })];
    if (index === 5)
      return [call("complete_project_review", { sources: ["repository/README.md"] })];
    return [message("Updated project knowledge.")];
  };
}

it("researches a repository and directly edits and commits profile knowledge", async () => {
  const { request, profile } = fixture();
  const model = provider(successfulReview(request, true));
  const progress = vi.fn();
  await exploreProject({ ...request, onProgress: progress }, connection);
  const document = profile.documents().find((doc) => doc.path === request.document.path);
  assert(document);
  expect(document.content).toContain("Team onboarding. See README.md.");
  expect(document.content).toContain("## Working context\nPrivate note.");
  expect(document.content).toContain("custom: keep");
  expect(
    execFileSync("git", ["-C", profile.root, "status", "--porcelain"], { encoding: "utf8" }),
  ).toBe("");
  expect(
    execFileSync("git", ["-C", profile.root, "log", "-1", "--format=%s"], { encoding: "utf8" }),
  ).toContain("docs(profile): refresh project knowledge");
  expect(readFileSync(join(request.repository, "README.md"), "utf8")).toContain("team onboarding");
  expect(model.requests[0].tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      "list_files",
      "search_files",
      "read_repository_file",
      "edit_file",
      "commit_profile",
      "complete_project_review",
    ]),
  );
  expect(model.requests[0]).not.toHaveProperty("text");
  expect(model.requests[0]).not.toHaveProperty("max_output_tokens");
  expect(progress).toHaveBeenCalledWith({ phase: "reading", filesRead: 1 });
  expect(progress).toHaveBeenLastCalledWith({ phase: "validating" });
});

it("permits a verified no-op without making a commit", async () => {
  const { request, profile } = fixture();
  const head = execFileSync("git", ["-C", profile.root, "rev-parse", "HEAD"], { encoding: "utf8" });
  provider((_input, index) =>
    index === 0
      ? [readme]
      : index === 1
        ? [call("complete_project_review", { sources: ["repository/README.md"] })]
        : [message("Existing knowledge remains accurate.")],
  );
  await exploreProject(request, connection);
  expect(execFileSync("git", ["-C", profile.root, "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(
    head,
  );
});

it("recovers from tool errors and preserves encrypted reasoning history", async () => {
  const { request } = fixture();
  const reasoning = {
    type: "reasoning",
    id: "rs_test",
    summary: [],
    encrypted_content: "reasoning",
  };
  const model = provider((_input, index) => {
    if (index === 0)
      return [
        reasoning,
        call("read_repository_file", { scope: "repository", path: "missing.md", offset: 0 }),
      ];
    if (index === 1) return [readme];
    if (index === 2)
      return [call("complete_project_review", { sources: ["repository/README.md"] })];
    return [message("Verified existing knowledge.")];
  });
  await exploreProject(request, connection);
  expect(model.requests[1].input).toContainEqual(reasoning);
  expect(model.requests[1].input.find((item) => item.type === "function_call")).not.toHaveProperty(
    "namespace",
  );
  expect(
    model.requests[1].input.some(
      (item) => item.type === "function_call_output" && item.output?.includes("error"),
    ),
  ).toBe(true);
});

it("blocks private sources, escaped paths and repository writes", async () => {
  const { request, root } = fixture();
  writeFileSync(join(root, "private.md"), "private-outside-data");
  writeFileSync(join(request.repository, ".env"), "private-env-data");
  symlinkSync(join(root, "private.md"), join(request.repository, "link.md"));
  const model = provider((_input, index) =>
    index === 0
      ? [
          ...["../private.md", ".env", "link.md"].map((path) =>
            call("read_repository_file", { scope: "repository", path, offset: 0 }, path),
          ),
          call("write_file", { path: join(request.repository, "README.md"), content: "Changed" }),
        ]
      : [message("Unable to finish.")],
  );
  await expect(exploreProject(request, connection)).rejects.toMatchObject({
    diagnostic: { category: "incomplete" },
  });
  expect(
    model.requests[1].input
      .filter((item) => item.type === "function_call_output")
      .every((item) => item.output?.includes("error")),
  ).toBe(true);
  expect(JSON.stringify(model.requests)).not.toMatch(/private-(outside|env)-data/);
  expect(readFileSync(join(request.repository, "README.md"), "utf8")).toContain("team onboarding");
});

it.each(["unread", "invented", "unfinished"])("rejects %s completion evidence", async (failure) => {
  const { request } = fixture();
  provider((_input, index) => {
    if (index === 0 && failure !== "unread") return [readme];
    if (index <= 1 && failure !== "unfinished")
      return [
        call("complete_project_review", {
          sources: [failure === "invented" ? "repository/invented.md" : "repository/README.md"],
        }),
      ];
    return [message("Done")];
  });
  await expect(exploreProject(request, connection)).rejects.toMatchObject({
    diagnostic: { category: "incomplete" },
  });
});

it.each(["source", "profile"])(
  "preserves concurrent %s edits and rejects the stale update",
  async (target) => {
    const { request, profile } = fixture();
    let changed = false;
    const valid = successfulReview(request);
    provider((input, index) => {
      if (index === 2) {
        changed = true;
        if (target === "profile")
          writeFileSync(
            join(profile.root, request.document.path),
            `${request.document.content}External edit`,
          );
      }
      return valid(input, index);
    });
    await expect(
      exploreProject(
        {
          ...request,
          validateSource: async () => {
            if (target === "source" && changed) throw new Error("Repository changed during review");
          },
        },
        connection,
      ),
    ).rejects.toThrow();
    const committed = execFileSync(
      "git",
      ["-C", profile.root, "show", `HEAD:${request.document.path}`],
      { encoding: "utf8" },
    );
    expect(committed).toContain("Old summary");
    if (target === "profile")
      expect(readFileSync(join(profile.root, request.document.path), "utf8")).toContain(
        "External edit",
      );
  },
);

it("does not accept a final message while edits remain uncommitted", async () => {
  const { request } = fixture();
  provider((_input, index) =>
    index === 0
      ? [readme]
      : index === 1
        ? [
            call("write_file", {
              path: request.document.path,
              content: `${request.document.content}New fact`,
            }),
          ]
        : index === 2
          ? [call("complete_project_review", { sources: ["repository/README.md"] })]
          : [message("Done")],
  );
  await expect(exploreProject(request, connection)).rejects.toMatchObject({
    diagnostic: { category: "incomplete" },
  });
});

it("retains provider status without exposing response bodies or retrying", async () => {
  const { request } = fixture();
  const model = provider(() =>
    Response.json({ error: { message: "sensitive-provider-body" } }, { status: 503 }),
  );
  const failure = await exploreProject(request, connection).catch((error) => error);
  expect(failure.diagnostic).toMatchObject({ category: "provider", statusCode: 503 });
  expect(JSON.stringify(failure)).not.toContain("sensitive-provider-body");
  expect(model.fetch).toHaveBeenCalledTimes(1);
});

it("rejects incomplete provider responses", async () => {
  const { request } = fixture();
  provider(() =>
    Response.json({ id: "resp_incomplete", object: "response", status: "incomplete", output: [] }),
  );
  await expect(exploreProject(request, connection)).rejects.toThrow("did not complete");
});
