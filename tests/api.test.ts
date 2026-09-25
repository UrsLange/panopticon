import { mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Assistant } from "../server/application/assistant.js";
import { createApp } from "../server/bootstrap.js";
import { config } from "../server/config.js";
import { Profile } from "../server/profile.js";
import { SettingsStore } from "../server/settings.js";
import { Store } from "../server/store.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function setup(assistant: Assistant | null = null) {
  const store = new Store(":memory:");
  const profile = new Profile(mkdtempSync(join(tmpdir(), "pa-api-")));
  const app = createApp({
    settings: new SettingsStore({
      ...config,
      dataDir: mkdtempSync(join(tmpdir(), "pa-settings-")),
      apiKey: "",
      keyFile: "",
    }),
    store,
    profile,
    assistant,
    timezone: "Europe/Berlin",
    now: () => new Date("2026-09-17T12:00:00Z"),
  });
  cleanup.push(async () => {
    await app.close();
    store.db.close();
  });
  return { app, store, profile };
}
const headers = { host: "127.0.0.1:4317" };

describe("local API", () => {
  it("validates interview answers and rejects stale or unknown questions without losing saved answers", async () => {
    const { app, store } = setup();
    const captured = store.capture("Plan a demo");
    const item = store.update(
      captured.id,
      { clarifications: [{ id: "0:0", question: "Which project?", answer: "", resolved: false }] },
      captured.revision,
    );
    const answer = (revision: number, id: string, text: string) =>
      app.inject({
        method: "PATCH",
        url: `/api/items/${item.id}/clarifications`,
        headers,
        payload: { revision, answers: [{ id, answer: text }] },
      });
    expect((await answer(item.revision, "0:0", "x".repeat(5001))).statusCode).toBe(400);
    expect((await answer(item.revision, "unknown", "Portal")).statusCode).toBe(400);
    expect((await answer(item.revision, "0:0", " Portal ")).statusCode).toBe(200);
    expect((await answer(item.revision, "0:0", "Stale")).statusCode).toBe(409);
    expect(store.get(item.id)?.clarifications[0].answer).toBe("Portal");
    expect(store.get(item.id)?.body).toBe("Plan a demo");
  });
  it.each(["idea", "commitment"] as const)(
    "manually accepts a %s without invoking a model",
    async (kind) => {
      const { app, store } = setup();
      const captured = store.capture("Discuss the plan with Benjamin");
      const item = store.update(
        captured.id,
        {
          kind,
          processing: "review",
          prompt: "Discuss the current plan.",
          rationale: "Which Benjamin?",
        },
        captured.revision,
      );
      const accept = (revision: number) =>
        app.inject({
          method: "POST",
          url: `/api/items/${item.id}/refined`,
          headers,
          payload: { revision },
        });
      expect((await accept(0)).statusCode).toBe(409);
      const response = await accept(item.revision);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ...item,
        revision: item.revision + 1,
        updatedAt: expect.any(String),
        processing: "ready",
        refinement: "ready",
      });
      expect(store.history(item.id)[0].item.processing).toBe("review");
    },
  );

  it("requires classification and preserves the separate note approval flow", async () => {
    const { app, store } = setup();
    let item = store.capture("A capture");
    for (const kind of ["unclassified", "note"] as const) {
      const current = store.update(item.id, { kind }, item.revision);
      item = current;
      const response = await app.inject({
        method: "POST",
        url: `/api/items/${item.id}/refined`,
        headers,
        payload: { revision: current.revision },
      });
      expect(response.statusCode).toBe(400);
      expect(store.get(item.id)?.processing).toBe("pending");
    }
  });

  it("maintains project links on creation, edits, and profile loads", async () => {
    const { app, profile } = setup();
    profile.initialize();
    const response = await app.inject({
      method: "POST",
      url: "/api/profile",
      headers,
      payload: { title: "Manual", type: "Project", body: "My project" },
    });
    expect(response.statusCode).toBe(201);
    const project = response.json();
    const index = join(profile.root, "index.md");
    expect(readFileSync(index, "utf8")).toContain(`[Manual](${project.path})`);
    const edited = await app.inject({
      method: "PUT",
      url: "/api/profile",
      headers,
      payload: {
        path: project.path,
        hash: project.hash,
        content: project.content.replace("title: Manual", "title: Renamed"),
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(readFileSync(index, "utf8")).toContain(`[Renamed](${project.path})`);
    renameSync(join(profile.root, project.path), join(profile.root, "external.md"));
    const loaded = await app.inject({ url: "/api/profile", headers });
    expect(loaded.statusCode).toBe(200);
    expect(readFileSync(index, "utf8")).toContain("[Renamed](external.md)");
    expect(readFileSync(index, "utf8")).not.toContain(project.path);
  });

  it("returns reconciled alias documents and refreshes their navigation after edits and external moves", async () => {
    const { app, profile } = setup();
    profile.initialize();
    const project = profile.create("Example", "Project", "");
    const response = await app.inject({
      method: "POST",
      url: "/api/profile",
      headers,
      payload: {
        title: "My aliases",
        type: "Aliases",
        body: `| Alias | Kind | Target |\n| --- | --- | --- |\n| example | project | ${project.path} |`,
      },
    });
    expect(response.statusCode).toBe(201);
    const registry = response.json();
    expect(registry.description).toBeTruthy();
    expect(registry.content).toContain(`[Example](${project.path})`);
    expect(registry.hash).toBe(profile.documents().find((doc) => doc.path === registry.path)?.hash);
    const index = join(profile.root, "index.md");
    expect(readFileSync(index, "utf8")).toContain(`[My aliases](${registry.path})`);
    const edited = await app.inject({
      method: "PUT",
      url: "/api/profile",
      headers,
      payload: {
        path: registry.path,
        hash: registry.hash,
        content: registry.content
          .replace("title: My aliases", "title: Renamed aliases")
          .replace(project.path, "missing.md"),
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().content).toContain("missing.md — unresolved target");
    expect(edited.json().content).not.toContain(`[Example](${project.path})`);
    expect(edited.json().hash).toBe(
      profile.documents().find((doc) => doc.path === registry.path)?.hash,
    );
    expect(readFileSync(index, "utf8")).toContain(`[Renamed aliases](${registry.path})`);
    renameSync(join(profile.root, registry.path), join(profile.root, "external-aliases.md"));
    expect((await app.inject({ url: "/api/profile", headers })).statusCode).toBe(200);
    expect(readFileSync(index, "utf8")).toContain("[Renamed aliases](external-aliases.md)");
    expect(readFileSync(index, "utf8")).not.toContain(registry.path);
  });

  it("persists aliases, retrieves their targets, and reinterprets edited input", async () => {
    const assistant: Assistant = {
      interpret: async (text, context) => {
        expect(
          context.profile.documents.some((doc) => doc.content.includes("Access details")),
        ).toBe(true);
        return {
          title: text,
          kind: "idea",
          project: "",
          dueDate: null,
          priority: "normal",
          relatedId: null,
          rationale: "Resolved",
          needsClarification: false,
          clarificationQuestions: [],
          updateProfile: false,
          referenceIds: context.candidates
            .filter((candidate) => candidate.available)
            .map((candidate) => candidate.id),
          prompt: "",
          sources: [],
        };
      },
      ask: async (_text, context) => {
        expect(context.related.some((item) => item.references.length > 0)).toBe(true);
        return { answer: "Stored references are supplied", sources: [] };
      },
      updateProfile: async () => {
        throw new Error("Unexpected profile update");
      },
    };
    const { app, store, profile } = setup(assistant);
    const project = profile.create("GitHub Access Management", "Project", "Access details");
    const registry = profile.create(
      "Aliases",
      "Aliases",
      `| Alias | Kind | Target |\n| --- | --- | --- |\n| gham | project | ${project.path} |`,
    );
    const item = store.capture("Ask about ghma");
    const process = () =>
      app.inject({ method: "POST", url: `/api/items/${item.id}/process`, headers });
    await process();
    const resolved = store.get(item.id);
    if (!resolved) throw new Error("Missing captured item");
    expect(resolved.processing).toBe("ready");
    expect(resolved.references[0]).toMatchObject({
      mention: "ghma",
      target: project.path,
      label: project.title,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ask",
          headers,
          payload: { text: "What about gham?" },
        })
      ).statusCode,
    ).toBe(200);
    profile.save(
      registry.path,
      registry.content.replace(project.path, "missing.md"),
      registry.hash,
    );
    await process();
    expect(store.get(item.id)?.references).toEqual(resolved.references);
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers,
      payload: {
        revision: store.get(item.id)?.revision,
        body: "Please ask about ghma tomorrow",
        title: "My title",
        kind: "commitment",
      },
    });
    expect(edited.statusCode).toBe(200);
    await app.close();
    const final = store.get(item.id);
    if (!final) throw new Error("Missing edited item");
    expect(final.title).toBe("Please ask about ghma tomorrow");
    expect(final.kind).toBe("idea");
    expect(final.body).toBe("Please ask about ghma tomorrow");
    expect(final.original).toBe("Ask about ghma");
    expect(final.references[0]?.target).toBe(project.path);
    expect(store.search("GitHub Access Management").map((entry) => entry.id)).toContain(item.id);
  });

  it("keeps the saved capture when the model invents a reference", async () => {
    const { app, store } = setup({
      interpret: async () => ({
        title: "Bad reference",
        kind: "note",
        project: "",
        dueDate: null,
        priority: "normal",
        relatedId: null,
        rationale: "",
        needsClarification: false,
        clarificationQuestions: [],
        updateProfile: false,
        referenceIds: ["invented"],
        prompt: "",
        sources: [],
      }),
      ask: async () => ({ answer: "", sources: [] }),
      updateProfile: async () => {
        throw new Error("Unexpected profile update");
      },
    });
    const item = store.capture("Keep this");
    await app.inject({ method: "POST", url: `/api/items/${item.id}/process`, headers });
    expect(store.get(item.id)).toMatchObject({
      original: "Keep this",
      references: [],
      processing: "pending",
    });
  });

  it("only rebinds a stored alias when explicitly requested with the current revision", async () => {
    const { app, store, profile } = setup({
      interpret: async (_text, context) => ({
        title: "Model title",
        kind: "idea",
        project: "",
        dueDate: null,
        priority: "normal",
        relatedId: null,
        rationale: "",
        needsClarification: false,
        clarificationQuestions: [],
        updateProfile: false,
        referenceIds: context.candidates.map((candidate) => candidate.id),
        prompt: "",
        sources: [],
      }),
      ask: async () => ({ answer: "", sources: [] }),
      updateProfile: async () => {
        throw new Error("Unexpected profile update");
      },
    });
    const project = profile.create("New project", "Project", "");
    profile.create(
      "Aliases",
      "Aliases",
      `| Alias | Kind | Target |\n| --- | --- | --- |\n| gham | project | ${project.path} |`,
    );
    const item = store.capture("gham");
    store.update(
      item.id,
      {
        title: "My title",
        references: [
          {
            start: 0,
            end: 4,
            mention: "gham",
            kind: "project",
            target: "old.md",
            label: "Old project",
            source: "aliases.md",
          },
        ],
      },
      0,
    );
    const request = (revision: number) =>
      app.inject({
        method: "POST",
        url: `/api/items/${item.id}/process`,
        headers,
        payload: { resetReferences: true, revision },
      });
    expect((await request(0)).statusCode).toBe(409);
    expect(store.get(item.id)?.references[0].target).toBe("old.md");
    expect((await request(1)).statusCode).toBe(200);
    expect(store.get(item.id)?.references[0].target).toBe(project.path);
    expect(store.get(item.id)?.title).toBe("My title");
  });
  it("saves immediately without a model and supports manual planning", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/captures",
      headers,
      payload: { text: "Call Anna" },
    });
    expect(response.statusCode).toBe(201);
    const item = response.json();
    expect(item.processing).toBe("pending");
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers,
      payload: { revision: 0, kind: "commitment", dueDate: "2026-09-17" },
    });
    expect(updated.statusCode).toBe(200);
    const today = await app.inject({ url: "/api/today", headers });
    expect(today.json().due).toHaveLength(1);
  });

  it("rejects invalid dates and cross-origin or DNS-rebound requests", async () => {
    const { app, store } = setup();
    const item = store.capture("Test");
    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers,
      payload: { revision: 0, dueDate: "2026-02-30" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      (
        await app.inject({
          url: "/api/items",
          headers: { ...headers, origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: "/api/items", headers: { host: "evil.example" } })).statusCode,
    ).toBe(403);
  });

  it("keeps captures recoverable when model calls fail", async () => {
    const assistant: Assistant = {
      interpret: async () => {
        throw new Error("Provider failure");
      },
      ask: async () => ({ answer: "", sources: [] }),
      updateProfile: async () => {
        throw new Error("Unexpected profile update");
      },
    };
    const { app, store } = setup(assistant);
    const item = store.capture("An idea I must not lose");
    await app.inject({ method: "POST", url: `/api/items/${item.id}/process`, headers });
    expect(store.get(item.id)?.original).toBe("An idea I must not lose");
    expect(store.get(item.id)?.processing).toBe("pending");
    expect(store.get(item.id)?.processingError).toContain("failed");
  });

  it("does not overwrite user corrections made while a model call is in flight", async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const assistant: Assistant = {
      interpret: async () => {
        await gate;
        return {
          title: "Model title",
          kind: "idea",
          project: "",
          dueDate: null,
          priority: "normal",
          relatedId: null,
          rationale: "Tentative idea",
          needsClarification: false,
          clarificationQuestions: [],
          updateProfile: false,
          referenceIds: [],
          prompt: "",
          sources: [],
        };
      },
      ask: async () => ({ answer: "", sources: [] }),
      updateProfile: async () => {
        throw new Error("Unexpected profile update");
      },
    };
    const { app, store } = setup(assistant);
    await app.ready();
    const item = store.capture("Original");
    const request = app.inject({ method: "POST", url: `/api/items/${item.id}/process`, headers });
    await new Promise((resolve) => setTimeout(resolve, 30));
    store.update(item.id, { title: "My correction", kind: "note" }, 0);
    finish?.();
    await request;
    expect(store.get(item.id)?.title).toBe("My correction");
  });
});
