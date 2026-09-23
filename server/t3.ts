import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { pullRequestUrlSchema, type T3Connection } from "../shared/t3.js";
import { ApplicationError } from "./application/errors.js";
import type { T3Client } from "./application/t3.js";

const modelSchema = z.object({
  instanceId: z.string(),
  model: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
});
const projectsSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      workspaceRoot: z.string(),
      defaultModelSelection: modelSchema.nullable(),
    }),
  ),
});
const descriptorSchema = z.object({ environmentId: z.string(), serverVersion: z.string() });
const exec = promisify(execFile);

export async function readPullRequest(
  url: string,
  execute: (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string }> = exec,
) {
  const reference = pullRequestUrlSchema.parse(url);
  const { stdout } = await execute(
    "gh",
    ["pr", "view", reference, "--json", "url,state,isDraft,mergedAt"],
    { timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  return z
    .object({
      url: pullRequestUrlSchema,
      state: z.enum(["OPEN", "CLOSED", "MERGED"]),
      isDraft: z.boolean(),
      mergedAt: z.iso.datetime().nullable(),
    })
    .parse(JSON.parse(stdout));
}

export async function implementationWorkspace(path: string) {
  try {
    const canonical = await realpath(path);
    const { stdout: root } = await exec("git", ["-C", canonical, "rev-parse", "--show-toplevel"]);
    if ((await realpath(root.trim())) !== canonical) throw new Error();
    const { stdout: branch } = await exec("git", [
      "-C",
      canonical,
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    return { path: canonical, branch: branch.trim() };
  } catch {
    throw new ApplicationError(
      "invalid",
      "The selected repository must exist locally and have a commit before creating a worktree.",
    );
  }
}

async function dispatchT3Socket(url: URL, command: object) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      socket.close();
      if (error) reject(new ApplicationError("unavailable", error));
      else resolve();
    };
    const timeout = setTimeout(
      () => finish("T3 Code has not confirmed setup yet. Retry to check the same thread."),
      30000,
    );
    const heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ _tag: "Ping" }));
    }, 10000);
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: "orchestration.dispatchCommand",
          payload: command,
          headers: [],
        }),
      ),
    );
    socket.addEventListener("error", () =>
      finish("T3 Code's WebSocket connection failed. Check network access and retry."),
    );
    socket.addEventListener("close", () =>
      finish("T3 Code disconnected before confirming the handoff. Retry to check the same thread."),
    );
    socket.addEventListener("message", (event) => {
      try {
        const decoded: unknown = JSON.parse(String(event.data));
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          const result = z
            .object({
              _tag: z.string(),
              requestId: z.string().optional(),
              exit: z
                .object({ _tag: z.string(), value: z.object({ sequence: z.number() }).optional() })
                .optional(),
            })
            .safeParse(message);
          if (!result.success) {
            finish("T3 Code returned an unsupported WebSocket response.");
            return;
          }
          if (result.data._tag === "Exit" && result.data.requestId === "1") {
            finish(
              result.data.exit?._tag === "Success" && result.data.exit.value
                ? undefined
                : "T3 Code could not prepare the implementation. Check its worktree setup and provider configuration, then retry.",
            );
          } else if (["Defect", "ClientProtocolError"].includes(result.data._tag))
            finish("T3 Code rejected the WebSocket command. Check its version and reconnect.");
        }
      } catch {
        finish("T3 Code returned an invalid WebSocket response.");
      }
    });
  });
}

export function createT3Client(request = fetch): T3Client {
  async function call(
    endpoint: string,
    path: string,
    accessToken?: string,
    body?: object | URLSearchParams,
    allowNotFound = false,
  ) {
    let response: Response;
    try {
      response = await request(`${endpoint}${path}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(body
            ? {
                "Content-Type":
                  body instanceof URLSearchParams
                    ? "application/x-www-form-urlencoded"
                    : "application/json",
              }
            : {}),
        },
        body:
          body instanceof URLSearchParams
            ? body.toString()
            : body
              ? JSON.stringify(body)
              : undefined,
      });
    } catch {
      throw new ApplicationError(
        "unavailable",
        "T3 Code could not be reached. Check its endpoint and network access, then retry.",
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new ApplicationError(
        "unavailable",
        "T3 Code rejected access. Reconnect in Settings with a fresh pairing token.",
      );
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok)
      throw new ApplicationError(
        "unavailable",
        `T3 Code rejected the request (HTTP ${response.status}). Check the instance and its supported network API, then retry.`,
      );
    try {
      return await response.json();
    } catch {
      throw new ApplicationError(
        "unavailable",
        "The endpoint did not return a T3 Code API response.",
      );
    }
  }
  async function projects(connection: T3Connection) {
    const result = projectsSchema.safeParse(
      await call(connection.endpoint, "/api/orchestration/shell", connection.accessToken),
    );
    if (!result.success)
      throw new ApplicationError(
        "unavailable",
        "This T3 Code instance uses an unsupported project API. Update T3 Code and reconnect.",
      );
    return result.data.projects;
  }
  return {
    async connect(input, previous) {
      const endpoint = new URL(input.endpoint).origin;
      const descriptor = descriptorSchema.safeParse(
        await call(endpoint, "/.well-known/t3/environment"),
      );
      if (!descriptor.success)
        throw new ApplicationError(
          "invalid",
          "Use a T3 Code network endpoint with the environment HTTP API.",
        );
      let accessToken =
        previous?.endpoint === endpoint && previous.environmentId === descriptor.data.environmentId
          ? previous.accessToken
          : undefined;
      if (input.credential) {
        const token = z
          .object({
            access_token: z.string().min(1),
            token_type: z.literal("Bearer"),
            scope: z.string(),
          })
          .safeParse(
            await call(
              endpoint,
              "/oauth/token",
              undefined,
              new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                subject_token: input.credential,
                subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
                requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
                scope: "orchestration:read orchestration:operate",
                client_label: "Panopticon",
                client_device_type: "bot",
              }),
            ),
          );
        if (
          !token.success ||
          !["orchestration:read", "orchestration:operate"].every((scope) =>
            token.data.scope.split(" ").includes(scope),
          )
        )
          throw new ApplicationError(
            "invalid",
            "T3 Code did not grant the access needed to create projects and start threads.",
          );
        accessToken = token.data.access_token;
      }
      if (!accessToken)
        throw new ApplicationError(
          "invalid",
          "Enter a fresh T3 Code pairing token for this endpoint.",
        );
      const connection = {
        endpoint,
        accessToken,
        ...descriptor.data,
        defaultModel: { instanceId: input.instanceId, model: input.model },
      };
      await projects(connection);
      return connection;
    },
    projects,
    async progress(connection, entry) {
      const descriptor = descriptorSchema.safeParse(
        await call(connection.endpoint, "/.well-known/t3/environment", connection.accessToken),
      );
      if (!descriptor.success || descriptor.data.environmentId !== entry.environmentId)
        throw new ApplicationError("conflict", "Reconnect the original T3 Code instance.");
      const snapshot = z
        .object({
          thread: z.object({
            projectId: z.string(),
            deletedAt: z.string().nullable(),
            latestTurn: z
              .object({ state: z.enum(["running", "interrupted", "completed", "error"]) })
              .nullable(),
          }),
        })
        .safeParse(
          await call(
            connection.endpoint,
            `/api/orchestration/threads/${encodeURIComponent(entry.id)}`,
            connection.accessToken,
          ),
        );
      if (
        !snapshot.success ||
        snapshot.data.thread.projectId !== entry.projectId ||
        snapshot.data.thread.deletedAt
      )
        throw new ApplicationError("unavailable", "The implementation thread is unavailable.");
      return snapshot.data.thread.latestTurn?.state ?? null;
    },
    async launch(connection, entry) {
      const descriptor = descriptorSchema.safeParse(
        await call(connection.endpoint, "/.well-known/t3/environment"),
      );
      if (!descriptor.success || descriptor.data.environmentId !== entry.environmentId)
        throw new ApplicationError(
          "conflict",
          "The endpoint now belongs to a different T3 Code instance. Reconnect the original instance before retrying.",
        );
      const existing = await projects(connection);
      const project = existing.find((project) => project.id === entry.projectId);
      if (project && project.workspaceRoot !== entry.workspaceRoot)
        throw new ApplicationError(
          "conflict",
          "The T3 project workspace changed. Restore its original repository before retrying.",
        );
      const dispatch = async (command: object) => {
        const result = z
          .object({ sequence: z.number() })
          .safeParse(
            await call(
              connection.endpoint,
              "/api/orchestration/dispatch",
              connection.accessToken,
              command,
            ),
          );
        if (!result.success)
          throw new ApplicationError(
            "unavailable",
            "T3 Code did not confirm the command. Retry to check the same thread.",
          );
      };
      if (!project)
        await dispatch({
          type: "project.create",
          commandId: `${entry.id}-project`,
          projectId: entry.projectId,
          title: entry.workspaceRoot.split("/").at(-1),
          workspaceRoot: entry.workspaceRoot,
          createdAt: entry.createdAt,
        });
      const snapshot = await call(
        connection.endpoint,
        `/api/orchestration/threads/${encodeURIComponent(entry.id)}`,
        connection.accessToken,
        undefined,
        true,
      );
      if (snapshot !== null) {
        const existingThread = z
          .object({
            thread: z.object({
              projectId: z.string(),
              deletedAt: z.string().nullable(),
              latestTurn: z.unknown(),
              messages: z.array(z.object({ id: z.string() })),
            }),
          })
          .safeParse(snapshot);
        if (!existingThread.success)
          throw new ApplicationError(
            "unavailable",
            "T3 Code returned an unsupported thread snapshot.",
          );
        const thread = existingThread.data.thread;
        if (!thread.deletedAt) {
          if (
            thread.projectId === entry.projectId &&
            thread.latestTurn &&
            thread.messages.some((message) => message.id === `${entry.id}-message`)
          )
            return;
          throw new ApplicationError(
            "unavailable",
            "The T3 thread already exists and may still be preparing. Check it in T3 Code, then retry to confirm submission.",
          );
        }
      }
      const ticket = z
        .object({ ticket: z.string().min(1) })
        .safeParse(
          await call(connection.endpoint, "/api/auth/websocket-ticket", connection.accessToken, {}),
        );
      if (!ticket.success)
        throw new ApplicationError(
          "unavailable",
          "T3 Code did not issue a WebSocket ticket. Reconnect in Settings.",
        );
      const socketUrl = new URL("/ws", connection.endpoint);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.searchParams.set("wsTicket", ticket.data.ticket);
      // The HTTP dispatcher does not run thread/worktree bootstrap.
      await dispatchT3Socket(socketUrl, {
        type: "thread.turn.start",
        commandId: `${entry.id}-turn`,
        threadId: entry.id,
        message: {
          messageId: `${entry.id}-message`,
          role: "user",
          text: entry.prompt,
          attachments: [],
        },
        modelSelection: entry.model,
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: entry.createdAt,
        bootstrap: {
          createThread: {
            projectId: entry.projectId,
            title: entry.title,
            modelSelection: entry.model,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: entry.createdAt,
          },
          prepareWorktree: {
            projectCwd: entry.workspaceRoot,
            baseBranch: entry.baseBranch,
            branch: `panopticon/${entry.id}`,
            requireWorktree: true,
          },
          runSetupScript: true,
        },
      });
    },
  };
}
