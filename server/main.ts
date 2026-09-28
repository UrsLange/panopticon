import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createHttpApp } from "./app.js";
import { createApplication } from "./bootstrap.js";
import { config } from "./config.js";
import { startPeopleScheduler } from "./people-scheduler.js";
import { startProfileLearningScheduler } from "./profile-learning-scheduler.js";
import { startProjectScheduler, startWorkspaceScheduler } from "./project-scheduler.js";
import { startT3Scheduler } from "./t3-scheduler.js";

const services = createApplication();
const app = createHttpApp(services, config.port);
const client = resolve("dist/client");
if (existsSync(client)) {
  await app.register(fastifyStatic, { root: client });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Route not found" });
    return reply.sendFile("index.html");
  });
}
await app.listen({ host: "127.0.0.1", port: config.port });
const stopScheduler = startProjectScheduler(services.scanner);
const stopWorkspaceScheduler = startWorkspaceScheduler(services.projects);
const stopPeopleScheduler = startPeopleScheduler(services.peopleSync);
const stopT3Scheduler = startT3Scheduler(services.t3);
const stopProfileLearningScheduler = startProfileLearningScheduler(services.profileLearning);
console.log(`Personal assistant API: http://127.0.0.1:${config.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopScheduler();
    stopWorkspaceScheduler();
    stopPeopleScheduler();
    stopT3Scheduler();
    stopProfileLearningScheduler();
    void app.close();
  });
