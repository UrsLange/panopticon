import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const core = "server/application/";

function dependencies(source: string) {
  const imports = [
    ...source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)["']([^"']+)["']/g),
  ].map((match) => match[1]);
  for (const call of source.matchAll(/\b(?:import|require)\s*\(([^)]*)\)/g)) {
    if (!/^["'][^"']+["']$/.test(call[1].trim())) imports.push("<computed import>");
  }
  return imports;
}

function allowed(file: string, dependency: string) {
  const local = dependency.startsWith(".")
    ? relative(root, resolve(root, dirname(file), dependency))
    : dependency;
  if (file.startsWith(core))
    return (
      local.startsWith(core) ||
      local.startsWith("shared/") ||
      ["zod", "yaml", "node:util"].includes(local)
    );
  if (file.startsWith("shared/")) return local.startsWith("shared/") || local === "zod";
  if (file === "server/app.ts")
    return (
      local.startsWith(core) ||
      local.startsWith("shared/") ||
      ["node:path", "fastify", "zod"].includes(local)
    );
  if (file.endsWith("-scheduler.ts")) return local.startsWith(core);
  return !["server/app.js", "server/bootstrap.js", "server/main.js"].includes(local);
}

function files(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(`${directory}/${entry.name}`)
      : entry.name.endsWith(".ts")
        ? [`${directory}/${entry.name}`]
        : [],
  );
}

it("keeps application and shared modules independent of infrastructure, and driving adapters independent of concrete adapters", () => {
  const violations: string[] = [];
  for (const file of [...files("server"), ...files("shared")]) {
    if (["server/bootstrap.ts", "server/main.ts"].includes(file)) continue;
    const source = readFileSync(join(root, file), "utf8");
    for (const dependency of dependencies(source)) {
      if (!allowed(file, dependency)) violations.push(`${file} imports ${dependency}`);
    }
    if (file.startsWith(core) || file.startsWith("shared/")) {
      for (const match of source.matchAll(
        /\b(?:process\s*\.|fetch\s*\(|require\s*\(|globalThis\s*[.[])/g,
      ))
        violations.push(`${file} uses an infrastructure global: ${match[0]}`);
    }
  }
  expect(violations).toEqual([]);
});

it("checks type-only imports, re-exports, dynamic imports, and attempted shared-module backdoors", () => {
  const imports = dependencies(`
    import type { Store } from "../store.js";
    export { Profile } from "../profile.js";
    const sqlite = import("node:sqlite");
    const sdk = require("openai");
    const dynamic = import(adapterName);
  `);
  expect(imports).toEqual([
    "../store.js",
    "../profile.js",
    "node:sqlite",
    "openai",
    "<computed import>",
  ]);
  expect(imports.every((dependency) => !allowed(`${core}example.ts`, dependency))).toBe(true);
  expect(allowed("shared/schema.ts", "../server/store.js")).toBe(false);
  expect(allowed("server/app.ts", "./store.js")).toBe(false);
  expect(allowed("server/people-scheduler.ts", "./people.js")).toBe(false);
  expect(allowed("server/store.ts", "./bootstrap.js")).toBe(false);
  expect(allowed(`${core}example.ts`, "../../shared/schema.js")).toBe(true);
});
