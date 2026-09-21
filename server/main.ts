import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createHttpApp } from "./app.js";
import { createApplication } from "./bootstrap.js";
import { config } from "./config.js";
import { startPeopleScheduler } from "./people-scheduler.js";
import { startProjectScheduler } from "./project-scheduler.js";

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
const stopPeopleScheduler = startPeopleScheduler(services.peopleSync);
console.log(`Personal assistant API: http://127.0.0.1:${config.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopScheduler();
    stopPeopleScheduler();
    void app.close();
  });
