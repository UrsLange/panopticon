import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  type ExplorationDiagnostic,
  ExplorationError,
  type ProjectExploration,
} from "./application/exploration.js";
import { renderPrompt } from "./prompts.js";

const execute = promisify(execFile);
const eventSchema = z.object({
  type: z.string(),
  sessionID: z.string().optional(),
  error: z.object({ data: z.object({ statusCode: z.number().optional() }).optional() }).optional(),
  part: z
    .object({
      reason: z.string().optional(),
      tool: z.string().optional(),
      state: z
        .object({
          status: z.string().optional(),
          input: z.object({ filePath: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});
export function resolveProjectModel(selected: string, available: string[]) {
  if (available.includes(selected)) return selected;
  const matches = available.filter((model) => model.slice(model.indexOf("/") + 1) === selected);
  if (matches.length === 1) return matches[0];
  throw new Error(
    "OpenCode cannot uniquely match the selected model. Configure that model in OpenCode, then retry.",
  );
}

export async function exploreProject({
  repository,
  document,
  model,
  onProgress,
}: ProjectExploration) {
  onProgress?.({ phase: "connecting", model });
  repository = await realpath(repository);
  document = await realpath(document);
  if (/[?*]/.test(repository + document))
    throw new Error("OpenCode discovery paths cannot contain wildcard characters.");
  // OpenCode matches read/edit rules against paths relative to the repository.
  const permission = {
    "*": "deny",
    read: {
      "*": "allow",
      "../*": "deny",
      [relative(repository, document)]: "allow",
      "*.env*": "deny",
      "*.key": "deny",
      "*.pem": "deny",
      "*.p12": "deny",
      "*.pfx": "deny",
      "*.git/*": "deny",
      "*token*": "deny",
      "*credential*": "deny",
      "*secret*": "deny",
    },
    glob: "allow",
    edit: { "*": "deny", [relative(repository, document)]: "allow" },
    external_directory: { "*": "deny", [`${dirname(document)}/*`]: "allow" },
  };
  const env = {
    ...process.env,
    PATH: `${process.env.PATH ?? "/usr/bin:/bin"}:${join(process.env.MISE_DATA_DIR ?? join(homedir(), ".local/share/mise"), "shims")}`,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      share: "disabled",
      formatter: false,
      lsp: false,
      permission,
      agent: {
        "profile-discovery": {
          mode: "primary",
          description: "Explore a repository and update its profile document",
          permission,
        },
      },
    }),
  };
  let available: string[];
  try {
    const result = await execute("opencode", ["models", "--pure"], {
      env,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    available = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    throw new ExplorationError({
      category: "model-discovery",
      message: "OpenCode could not list models. Check its installation and provider configuration.",
      exitCode: failure.code,
    });
  }
  const selected = resolveProjectModel(model, available);
  onProgress?.({ model: selected });
  const prompt = renderPrompt("project-exploration", {
    repository: JSON.stringify(repository),
    document: JSON.stringify(document),
  });
  const reads = new Set<string>();
  let stopped = false;
  let diagnostic: ExplorationDiagnostic | undefined;
  let pending = "";
  const consume = (line: string) => {
    if (!line.startsWith("{")) return;
    let event: z.infer<typeof eventSchema>;
    try {
      event = eventSchema.parse(JSON.parse(line));
    } catch {
      diagnostic = {
        category: "invalid-output",
        message: "OpenCode returned malformed event data.",
      };
      return;
    }
    if (typeof event.sessionID === "string") onProgress?.({ sessionId: event.sessionID });
    if (event.type === "error") {
      const statusCode = event.error?.data?.statusCode;
      diagnostic = {
        category: "provider",
        message:
          typeof statusCode === "number"
            ? `The OpenCode provider returned HTTP ${statusCode}. Check provider availability and access.`
            : "OpenCode reported an error. Inspect the OpenCode session for details.",
        ...(typeof statusCode === "number" ? { statusCode } : {}),
      };
    }
    if (event.type === "tool_use" && event.part?.state?.status === "completed") {
      const tool = event.part.tool;
      const filePath = event.part.state.input?.filePath;
      if (tool === "read" && typeof filePath === "string") {
        reads.add(resolve(repository, filePath));
        onProgress?.({ phase: "reading", filesRead: reads.size });
      } else if (tool && ["edit", "write", "apply_patch"].includes(tool)) {
        onProgress?.({ phase: "updating" });
      }
    }
    if (event.type === "step_finish" && event.part?.reason === "stop") stopped = true;
  };
  try {
    const run = execute(
      "opencode",
      [
        "run",
        "--pure",
        "--dir",
        repository,
        "--agent",
        "profile-discovery",
        "--model",
        selected,
        "--format",
        "json",
        prompt,
      ],
      { env, timeout: 10 * 60000, maxBuffer: 16 * 1024 * 1024 },
    );
    // OpenCode consumes piped stdin before processing even an explicit prompt.
    run.child.stdin?.end();
    run.child.stdout?.setEncoding("utf8");
    run.child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    await run;
    consume(pending);
  } catch (error) {
    const failure = error as { code?: string | number; signal?: string; killed?: boolean };
    consume(pending);
    const tooLarge = failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    throw new ExplorationError({
      ...(diagnostic ?? {
        category: tooLarge ? "output-limit" : failure.killed ? "timeout" : "process",
        message: tooLarge
          ? "OpenCode exceeded the output size limit. The draft was not applied to the profile."
          : failure.killed
            ? "OpenCode exceeded the ten-minute time limit. The draft was not applied to the profile."
            : "The OpenCode process failed. Inspect its exit status and session before retrying.",
      }),
      exitCode: failure.code,
      signal: failure.signal,
    });
  }
  if (diagnostic) throw new ExplorationError(diagnostic);
  if (
    !reads.has(document) ||
    ![...reads].some((path) => path !== document && path.startsWith(`${repository}/`)) ||
    !stopped
  )
    throw new ExplorationError({
      category: "incomplete",
      message:
        "OpenCode did not confirm reading the document and repository and completing the review. The draft was not applied to the profile.",
    });
  onProgress?.({ phase: "validating" });
}
