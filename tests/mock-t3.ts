import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export function mockT3() {
  const projects: {
    id: string;
    workspaceRoot: string;
    defaultModelSelection: null;
  }[] = [];
  const commands = new Map<string, Record<string, unknown>>();
  const threads = new Map<
    string,
    { projectId: string; deletedAt: null; latestTurn: object; messages: { id: string }[] }
  >();
  let lostResponse = false;
  const server = createServer(async (request, response) => {
    const send = (data: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.url === "/.well-known/t3/environment")
      return send({ environmentId: "fixture", serverVersion: "0.0.42" });
    if (request.url === "/test/commands") return send([...commands.values()]);
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/oauth/token") {
      if (new URLSearchParams(body).get("subject_token") !== "fixture-pairing")
        return send({}, 401);
      return send({
        access_token: "fixture-t3-secret",
        token_type: "Bearer",
        scope: "orchestration:read orchestration:operate",
      });
    }
    if (request.headers.authorization !== "Bearer fixture-t3-secret") return send({}, 401);
    if (request.url === "/api/auth/websocket-ticket") return send({ ticket: "fixture-ticket" });
    if (request.url?.startsWith("/api/orchestration/threads/")) {
      const thread = threads.get(request.url.split("/").at(-1) ?? "");
      return thread ? send({ thread }) : send({}, 404);
    }
    if (request.url === "/api/orchestration/shell") return send({ projects });
    if (request.url === "/api/orchestration/dispatch") {
      const command = JSON.parse(body);
      if (command.type !== "project.create") return send({}, 400);
      if (!commands.has(command.commandId)) {
        commands.set(command.commandId, command);
        if (command.type === "project.create")
          projects.push({
            id: command.projectId,
            workspaceRoot: command.workspaceRoot,
            defaultModelSelection: null,
          });
      }
      return send({ sequence: commands.size });
    }
    return send({}, 404);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws?wsTicket=fixture-ticket") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      websocket.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message._tag === "Ping") {
          websocket.send(JSON.stringify({ _tag: "Pong" }));
          return;
        }
        const command = message.payload;
        if (
          message._tag !== "Request" ||
          message.tag !== "orchestration.dispatchCommand" ||
          !Array.isArray(message.headers) ||
          command.type !== "thread.turn.start" ||
          !command.bootstrap.prepareWorktree.requireWorktree
        ) {
          websocket.send(JSON.stringify({ _tag: "ClientProtocolError" }));
          return;
        }
        commands.set(command.commandId, command);
        threads.set(command.threadId, {
          projectId: command.bootstrap.createThread.projectId,
          deletedAt: null,
          latestTurn: { state: "running" },
          messages: [{ id: command.message.messageId }],
        });
        if (!lostResponse) {
          lostResponse = true;
          websocket.close();
          return;
        }
        websocket.send(
          JSON.stringify([
            {
              _tag: "Exit",
              requestId: message.id,
              exit: { _tag: "Success", value: { sequence: commands.size } },
            },
          ]),
        );
      });
    });
  });
  server.on("close", () => sockets.close());
  return server;
}
