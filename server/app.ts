import { isAbsolute } from "node:path";
import Fastify from "fastify";
import { ZodError, z } from "zod";
import { entraSchema } from "../shared/people.js";
import { projectActionSchema } from "../shared/projects.js";
import { clarificationAnswersSchema, itemPatchSchema } from "../shared/schema.js";
import { t3ConnectionSchema, t3ImplementationSchema, t3OverridesSchema } from "../shared/t3.js";
import type { Application } from "./application/application.js";
import { connectionSchema } from "./application/connection.js";
import { ApplicationError, ProfileCommitError } from "./application/errors.js";

export function createHttpApp(services: Application, port: number) {
  const { notes, captures, profiles, conversation, preferences, scanner, peopleSync } = services;
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      return reply.code(403).send({ error: "Only localhost requests are accepted." });
    }
    const origin = request.headers.origin;
    if (
      origin &&
      ![
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ].includes(origin)
    ) {
      return reply.code(403).send({ error: "Cross-origin access is not allowed." });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApplicationError)
      return reply
        .code({ invalid: 400, conflict: 409, "not-found": 404, unavailable: 503 }[error.code])
        .send({ error: error.message });
    if (error instanceof ProfileCommitError) return reply.code(409).send({ error: error.message });
    if (error instanceof ZodError)
      return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    const message = error instanceof Error ? error.message : "Unexpected error";
    if (message.includes("changed")) return reply.code(409).send({ error: message });
    if (message.includes("not found")) return reply.code(404).send({ error: message });
    if (
      message.includes("Choose an existing") ||
      message.includes("OKF concepts") ||
      message.startsWith("Profile index reconciliation failed:")
    )
      return reply.code(400).send({ error: message });
    return reply
      .code(500)
      .send({ error: "The operation failed. Your saved captures are preserved." });
  });

  app.get("/api/settings", async () => preferences.status());
  app.post("/api/settings/directory", async (request, reply) => {
    if (!request.headers["content-type"]?.startsWith("application/json"))
      return reply.code(415).send({ error: "Use a JSON request to open the folder chooser." });
    return preferences.chooseDirectory();
  });
  app.get("/api/settings/t3", async () => services.t3.status());
  app.put("/api/settings/t3/auto-start", async (request) =>
    services.t3.saveAutoStart(z.object({ autoStart: z.boolean() }).parse(request.body).autoStart),
  );
  app.get("/api/settings/t3/defaults", async () => services.t3.defaults());
  app.put("/api/settings/t3/defaults", async (request) =>
    services.t3.saveDefaults(t3ImplementationSchema.parse(request.body)),
  );
  app.get("/api/completion-reviews", async () => services.t3.completionReviews());
  app.post<{ Params: { id: string } }>("/api/items/:id/completion-review", async (request) => {
    const input = z
      .object({
        implementationId: z.string().min(1).max(200),
        head: z.string().min(1).max(200),
        revision: z.number().int().nonnegative(),
        decision: z.enum(["confirm", "keep_open"]),
      })
      .parse(request.body);
    return services.t3.reviewCompletion(request.params.id, input);
  });
  app.put("/api/settings/t3", async (request) =>
    services.t3.connect(t3ConnectionSchema.parse(request.body)),
  );
  app.post("/api/settings/t3/test", async () => services.t3.test());
  app.delete("/api/settings/t3", async () => services.t3.disconnect());
  app.get<{ Params: { id: string } }>("/api/items/:id/implementation", async (request) =>
    services.t3.options(request.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/items/:id/implementation", async (request) => {
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        repositoryId: z.string().max(200).optional(),
        previousAttemptId: z.string().max(200).optional(),
      })
      .parse(request.body);
    return services.t3.implement(request.params.id, input);
  });
  app.post<{ Params: { id: string } }>("/api/items/:id/implementation/refresh", async (request) =>
    services.t3.refresh(request.params.id),
  );
  app.get("/api/people", async () => peopleSync.status());
  app.get("/api/settings/entra/tenant", async () => preferences.detectTenant());
  app.put("/api/settings/entra", async (request) => {
    const input = entraSchema.parse(request.body);
    return preferences.saveEntra(input);
  });
  app.post("/api/people/sync", async (_request, reply) => {
    return reply.code(202).send(peopleSync.request());
  });
  app.get("/api/projects", async () => scanner.status());
  app.get("/api/project-workspace", async () => services.projects.list());
  app.post("/api/project-workspace/refresh", async (_request, reply) =>
    reply.code(202).send(services.projects.refresh()),
  );
  app.get<{ Params: { id: string } }>("/api/project-workspace/:id", async (request) =>
    services.projects.detail(request.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/project-workspace/:id/actions", async (request) =>
    services.projects.action(request.params.id, projectActionSchema.parse(request.body)),
  );
  app.patch<{ Params: { id: string } }>("/api/project-workspace/:id", async (request) => {
    const input = z
      .object({
        returnToDefault: z.boolean().optional(),
        hidden: z.boolean().optional(),
        t3: t3OverridesSchema.optional(),
        document: z.string().nullable().optional(),
      })
      .parse(request.body);
    return services.projects.update(request.params.id, input);
  });
  app.put("/api/settings/projects", async (request) => {
    const { roots } = z
      .object({
        roots: z
          .array(z.string().min(1).refine(isAbsolute, "Use absolute directory paths."))
          .min(1)
          .max(30),
      })
      .parse(request.body);
    return preferences.projectRoots(roots);
  });
  app.post("/api/projects/scan", async (request, reply) => {
    const { scheduled, projectIds } = z
      .object({
        scheduled: z.boolean().default(false),
        projectIds: z.array(z.string()).min(1).max(500).optional(),
      })
      .parse(request.body ?? {});
    return reply.code(202).send(scanner.request(scheduled, projectIds));
  });
  app.post("/api/settings/models", async (request) => {
    return preferences.discover(request.body ? connectionSchema.parse(request.body) : undefined);
  });
  app.put("/api/settings/connection", async (request) => {
    const input = connectionSchema.parse(request.body);
    return preferences.connect(input);
  });
  app.post("/api/settings/profile", async (request) => {
    preferences.checkProfileChange();
    const input = z
      .object({
        mode: z.enum(["create", "connect"]),
        path: z.string().min(1).refine(isAbsolute, "Use an absolute directory path."),
        timezone: z.string().refine((value) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: value });
            return true;
          } catch {
            return false;
          }
        }, "Use a valid timezone."),
        name: z.string().max(200).default(""),
        role: z.string().max(3000).default(""),
        company: z.string().max(5000).default(""),
        team: z.string().max(3000).default(""),
        teamPurpose: z.string().max(5000).default(""),
      })
      .parse(request.body);
    return preferences.profile(input);
  });
  app.get("/api/profile/enrichment", async () => profiles.enrichment());
  app.get("/api/profile/learning", async () => services.profileLearning.status());
  app.post("/api/profile/learning", async (_request, reply) =>
    reply.code(202).send(services.profileLearning.request()),
  );
  app.get("/api/items", async () => captures.list());
  app.get("/api/today", async () => captures.today());
  app.post("/api/captures", async (request, reply) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(30000) }).parse(request.body);
    const item = captures.capture(text);
    return reply.code(201).send(item);
  });
  app.post<{ Params: { id: string } }>("/api/items/:id/process", async (request) => {
    const input = z
      .object({
        resetReferences: z.boolean().default(false),
        revision: z.number().int().nonnegative().optional(),
      })
      .parse(request.body ?? {});
    return captures.retry(request.params.id, input);
  });
  app.post<{ Params: { id: string } }>("/api/items/:id/refined", async (request) => {
    const { revision } = z.object({ revision: z.number().int().nonnegative() }).parse(request.body);
    return captures.markRefined(request.params.id, revision);
  });
  app.patch<{ Params: { id: string } }>("/api/items/:id/clarifications", async (request) =>
    captures.answer(request.params.id, clarificationAnswersSchema.parse(request.body)),
  );
  app.post<{ Params: { id: string } }>("/api/items/:id/profile", async (request) => {
    const { revision } = z.object({ revision: z.number().int().nonnegative() }).parse(request.body);
    return notes.add(request.params.id, revision);
  });
  app.patch<{ Params: { id: string } }>("/api/items/:id", async (request) => {
    const { revision, ...fields } = itemPatchSchema
      .extend({ revision: z.number().int().nonnegative() })
      .parse(request.body);
    return captures.edit(request.params.id, fields, revision);
  });
  app.get<{ Params: { id: string } }>("/api/items/:id/history", async (request) =>
    captures.history(request.params.id),
  );
  app.get("/api/profile", async () => profiles.documents());
  app.put("/api/profile", async (request) => {
    const { path, content, hash } = z
      .object({ path: z.string(), content: z.string().max(50000), hash: z.string() })
      .parse(request.body);
    return profiles.edit(path, content, hash);
  });
  app.post("/api/profile", async (request, reply) => {
    const { title, type, body } = z
      .object({
        title: z.string().trim().min(1).max(200),
        type: z.string().trim().min(1).max(100),
        body: z.string().max(30000),
      })
      .parse(request.body);
    const created = profiles.create(title, type, body);
    return reply.code(201).send(created);
  });
  app.get("/api/messages", async () => conversation.messages());
  app.post("/api/ask", async (request) => {
    const { text, sessionEvidence } = z
      .object({
        text: z.string().trim().min(1).max(10000),
        sessionEvidence: z.string().max(30000).default(""),
      })
      .parse(request.body);
    return conversation.ask(text, sessionEvidence);
  });
  app.post("/api/sessions/search", async (request) => {
    const { query } = z.object({ query: z.string().trim().min(1).max(500) }).parse(request.body);
    return conversation.search(query);
  });
  app.addHook("onClose", () => services.close());
  return app;
}
