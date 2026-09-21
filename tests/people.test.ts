import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Assistant, AssistantContext } from "../server/application/assistant.js";
import { createApp } from "../server/bootstrap.js";
import { config } from "../server/config.js";
import { createPeopleSync, detectEntraTenant, entraToken, fetchPeople } from "../server/people.js";
import { Profile } from "../server/profile.js";
import { SettingsStore } from "../server/settings.js";
import { Store } from "../server/store.js";
import { defaultEntra, type EntraConfig, entraSchema, type Person } from "../shared/people.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
it("detects only a valid tenant from Azure CLI and handles unavailable logins", async () => {
  const bin = mkdtempSync(join(tmpdir(), "pa-tenant-cli-"));
  const cli = join(bin, "az");
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write("${tenantId}\\n");\n`, {
      mode: 0o700,
    });
    expect(await detectEntraTenant()).toBe(tenantId);
    writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write("not-a-tenant");\n`);
    expect(await detectEntraTenant()).toBeNull();
    writeFileSync(
      cli,
      `#!${process.execPath}\nprocess.stderr.write("private authentication details"); process.exit(1);\n`,
    );
    expect(await detectEntraTenant()).toBeNull();
  } finally {
    process.env.PATH = originalPath;
  }
});
const clientId = "22222222-2222-4222-8222-222222222222";
const input: EntraConfig = {
  ...defaultEntra,
  enabled: true,
  tenantId,
  clientId: "",
  myEmail: "me@example.com",
};
const me: Person = {
  prename: "Sam",
  lastname: "Self",
  email: "me@example.com",
  role: "Lead",
  team: "Engineering",
  unit: "Product",
  subdivision: "",
  division: "Technology",
  company: "Example",
};
const anna: Person = {
  ...me,
  prename: "Anna",
  lastname: "Müller",
  email: "anna@example.com",
  role: "Coach | R&D <team>",
};
const headers = { host: "127.0.0.1:4317" };
const groups = [
  { displayName: "Engineering", onPremisesSamAccountName: "t_engineering" },
  { displayName: "Product", onPremisesSamAccountName: "u_product" },
  { displayName: "Technology", onPremisesSamAccountName: "d_technology" },
];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture(
  load = async () => ({ people: [me, anna], skipped: 2 }),
  now = () => new Date("2026-09-17T12:00:00Z"),
) {
  const root = mkdtempSync(join(tmpdir(), "pa-people-"));
  const defaults = {
    ...config,
    dataDir: root,
    profileDir: join(root, "profile"),
    keyFile: "",
    apiKey: "",
  };
  const settings = new SettingsStore(defaults);
  const profile = new Profile(defaults.profileDir);
  profile.initialize();
  settings.saveProfile(profile.root, "Europe/Berlin");
  settings.saveEntra(input);
  const store = new Store(join(root, "assistant.sqlite"));
  cleanup.push(async () => store.db.close());
  return {
    root,
    defaults,
    profile,
    settings,
    store,
    sync: createPeopleSync(settings, store, load, now),
  };
}

it("imports every user and group page, derives hierarchy from the path, preserves field values, and excludes unsuitable accounts", async () => {
  const user = {
    givenName: "Anna",
    surname: "Müller",
    mail: "ANNA@example.com",
    jobTitle: anna.role,
    userType: "Member",
    accountEnabled: true,
    department: "Wrong team",
    companyName: "Example",
    employeeOrgData: { division: "Wrong division" },
    onPremisesDistinguishedName:
      "CN=Anna Müller,OU=Engineering,OU=Product,OU=Technology,OU=Example,OU=Organisation,DC=example,DC=com",
  };
  const next = "https://graph.microsoft.com/v1.0/users?$skiptoken=second";
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        value: groups.slice(0, 1),
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/groups?$skiptoken=second",
      }),
    )
    .mockResolvedValueOnce(Response.json({ value: groups.slice(1) }))
    .mockResolvedValueOnce(
      Response.json({
        value: [
          user,
          { ...user, mail: "guest@example.com", userType: "Guest" },
          { ...user, accountEnabled: false },
          { ...user, mail: null },
          { ...user, givenName: null },
        ],
        "@odata.nextLink": next,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ value: [{ ...user, givenName: "Sam", surname: "Self", mail: me.email }] }),
    );
  const result = await fetchPeople("private-token", request);
  expect(result.skipped).toBe(4);
  expect(result.people).toHaveLength(2);
  expect(result.people[0]).toMatchObject({
    email: anna.email,
    unit: "Product",
    subdivision: "",
    team: "Engineering",
    division: "Technology",
  });
  expect(result.warnings).toEqual([]);
  expect(request.mock.calls[3][0]).toBe(next);
  expect(request.mock.calls[0][1]).toMatchObject({
    redirect: "error",
    headers: { Authorization: "Bearer private-token" },
  });
  expect(String(request.mock.calls[0][0])).toContain("onPremisesSamAccountName");
  expect(String(request.mock.calls[2][0])).toContain("onPremisesDistinguishedName");
  const { profile, store } = fixture();
  store.replacePeople(profile.root, tenantId, result.people, "2026-09-17T12:00:00Z");
  const context = store.peopleContext(profile.root, "Ask Anna Müller.", me.email, tenantId);
  expect(context?.candidates[0].role).toBe(anna.role);
  expect(context?.self?.email).toBe(me.email);
});

it("never forwards a token to a foreign nextLink or follows redirects and rejects duplicate email keys", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ value: [], "@odata.nextLink": "https://evil.example/users" }),
    );
  await expect(fetchPeople("secret", request)).rejects.toThrow("invalid directory page");
  expect(request).toHaveBeenCalledTimes(1);
  request
    .mockReset()
    .mockResolvedValueOnce(Response.json({ value: groups }))
    .mockResolvedValue(
      Response.json({
        value: [
          {
            givenName: "A",
            surname: "B",
            mail: "a@example.com",
            userType: "Member",
            accountEnabled: true,
          },
          {
            givenName: "C",
            surname: "D",
            mail: "A@example.com",
            userType: "Member",
            accountEnabled: true,
          },
        ],
      }),
    );
  await expect(fetchPeople("secret", request)).rejects.toThrow("Duplicate email");
});

it("uses the client credential flow without leaking provider error bodies", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ access_token: "access" }));
  const credentials = {
    ...input,
    authMode: "client-secret" as const,
    clientId,
    clientSecret: "secret&+value",
  };
  expect(await entraToken(credentials, request)).toBe("access");
  expect(String(request.mock.calls[0][0])).toBe(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
  );
  const options = request.mock.calls[0][1];
  expect(options?.redirect).toBe("error");
  expect(new URLSearchParams(String(options?.body)).get("client_secret")).toBe("secret&+value");
  request.mockResolvedValue(Response.json({ error: "sensitive provider detail" }, { status: 401 }));
  await expect(entraToken(credentials, request)).rejects.toThrow("Entra authentication failed");
});

it("preserves the last directory when a later group page is denied", async () => {
  const { profile, settings, sync, store } = fixture();
  await sync.run();
  const before = store.peopleContext(profile.root, "Anna", me.email, tenantId);
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        value: groups,
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/groups?$skiptoken=second",
      }),
    )
    .mockResolvedValueOnce(Response.json({ error: "private provider details" }, { status: 403 }));
  const failing = createPeopleSync(settings, store, () => fetchPeople("token", request));
  expect((await failing.run()).error).toContain("GroupMember.Read.All");
  expect(store.peopleContext(profile.root, "Anna", me.email, tenantId)).toEqual(before);
  expect(request).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(failing.status())).not.toContain("private provider details");
});

it("reports unresolved hierarchy nodes in persisted sync status", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ value: groups }))
    .mockResolvedValueOnce(
      Response.json({
        value: [
          {
            givenName: "A",
            surname: "B",
            mail: "a@example.com",
            userType: "Member",
            accountEnabled: true,
            companyName: "Example",
            onPremisesDistinguishedName:
              "CN=A B,OU=Unknown Team,OU=Technology,OU=Example,OU=Organisation,DC=example",
          },
        ],
      }),
    );
  const { settings, store } = fixture();
  const sync = createPeopleSync(settings, store, () => fetchPeople("token", request));
  const status = await sync.run();
  expect(status.error).toBeNull();
  expect(status.warnings).toHaveLength(1);
  expect(status.warnings[0]).toContain("Unknown Team");
  expect(createPeopleSync(settings, store).status().warnings).toEqual(status.warnings);
});

it("writes a persistent SQL directory and preserves it when later pages fail", async () => {
  const load = vi.fn().mockResolvedValue({ people: [me, anna], skipped: 2 });
  const { root, profile, sync, settings, store } = fixture(load);
  expect(await sync.run()).toMatchObject({ count: 2, skipped: 2, error: null, running: false });
  const path = join(profile.root, "people.md");
  const before = store.peopleContext(profile.root, "Anna", me.email, tenantId);
  expect(existsSync(path)).toBe(false);
  for (const file of ["assistant.sqlite", "assistant.sqlite-wal", "assistant.sqlite-shm"])
    expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
  expect(profile.documents().some((doc) => doc.path === "people.md")).toBe(false);
  load.mockRejectedValue(new Error("Directory request failed (HTTP 429). Retry the sync later."));
  expect((await sync.run()).error).toContain("HTTP 429");
  const reopened = new Store(join(root, "assistant.sqlite"));
  cleanup.push(async () => reopened.db.close());
  expect(reopened.peopleContext(profile.root, "Anna", me.email, tenantId)).toEqual(before);
  expect(createPeopleSync(settings, reopened).status()).toMatchObject({
    count: 2,
    lastSuccess: "2026-09-17T12:00:00.000Z",
  });
});

it("leaves unmanaged files and symlinks alone while syncing to SQL", async () => {
  const { profile, sync, settings, store } = fixture();
  const path = join(profile.root, "people.md");
  writeFileSync(path, "My own people list");
  createPeopleSync(settings, store);
  expect((await sync.run()).error).toBeNull();
  expect(readFileSync(path, "utf8")).toBe("My own people list");
  const other = fixture();
  symlinkSync(path, join(other.profile.root, "people.md"));
  createPeopleSync(other.settings, other.store);
  expect((await other.sync.run()).error).toBeNull();
  expect(readFileSync(path, "utf8")).toBe("My own people list");
});

it("deduplicates concurrent work and schedules daily refreshes with 15-minute failure retries", async () => {
  let clock = new Date("2026-09-17T12:00:00Z");
  const load = vi.fn(async () => ({ people: [me], skipped: 0 }));
  const { sync } = fixture(load, () => clock);
  const one = sync.run(true);
  expect(sync.run()).toBe(one);
  await one;
  await sync.run(true);
  expect(load).toHaveBeenCalledTimes(1);
  clock = new Date("2026-09-18T12:00:00Z");
  load.mockRejectedValueOnce(new Error("Network offline"));
  await sync.run(true);
  await sync.run(true);
  expect(load).toHaveBeenCalledTimes(2);
  clock = new Date("2026-09-18T12:15:00Z");
  await sync.run(true);
  expect(load).toHaveBeenCalledTimes(3);
  load.mockRejectedValueOnce(new Error("Network offline"));
  await sync.run();
  clock = new Date("2026-09-18T12:30:00Z");
  await sync.run(true);
  expect(load).toHaveBeenCalledTimes(5);
});

const legacyDirectory = `---
type: People directory
title: People
generated_by: personal-assistant-entra
tenant_id: ${tenantId}
synced_at: 2026-09-17T12:00:00.000Z
---

# People

| prename | lastname | email | role | team | unit | subdivision | division | company |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Anna | Müller | anna@example.com | Coach &#124; R&amp;D &lt;team&gt; | Engineering | Product | | Technology | Example |
`;

it("migrates the generated table without Entra access and archives the original outside the profile", () => {
  const { root, settings, profile, store } = fixture();
  const path = join(profile.root, "people.md");
  profile.change("import legacy directory", () => {
    profile.prepareWrite("people.md");
    writeFileSync(path, legacyDirectory);
  });
  expect(profile.enrichmentPrompt()).not.toContain("people.md");
  const sync = createPeopleSync(settings, store);
  expect(sync.status()).toMatchObject({
    count: 1,
    lastSuccess: "2026-09-17T12:00:00.000Z",
    error: null,
  });
  expect(store.person(profile.root, tenantId, anna.email)).toEqual(anna);
  expect(existsSync(path)).toBe(false);
  const backup = readdirSync(root).find(
    (file) => file.startsWith("people-") && file.endsWith(".md"),
  );
  expect(backup).toBeDefined();
  expect(readFileSync(join(root, String(backup)), "utf8")).toBe(legacyDirectory);
  expect(statSync(join(root, String(backup))).mode & 0o777).toBe(0o600);
  expect(profile.documents().some((doc) => doc.path === "people.md")).toBe(false);
  expect(createPeopleSync(settings, store).status()).toEqual(sync.status());
});

it("does not replace a newer SQL snapshot when a legacy file reappears", async () => {
  const { settings, profile, store, sync } = fixture();
  await sync.run();
  writeFileSync(join(profile.root, "people.md"), legacyDirectory);
  createPeopleSync(settings, store);
  expect(store.person(profile.root, tenantId, me.email)).toEqual(me);
  expect(store.peopleContext(profile.root, "Anna", me.email, tenantId)?.self).toEqual(me);
});

it("preserves invalid legacy tables and reports migration failures without exposing them as profile context", () => {
  const { settings, profile, store } = fixture();
  const path = join(profile.root, "people.md");
  const invalid = legacyDirectory.replace("| prename |", "| unexpected |");
  writeFileSync(path, invalid);
  const sync = createPeopleSync(settings, store);
  expect(sync.status().error).toContain("migration failed");
  expect(readFileSync(path, "utf8")).toBe(invalid);
  expect(store.peopleSyncedAt(profile.root, tenantId)).toBeNull();
  expect(profile.context("Anna").documents).toEqual([]);
  expect(profile.enrichmentPrompt()).not.toContain("people.md");
});

it("rolls back directory rows and timestamp together when a replacement fails", async () => {
  const load = vi.fn().mockResolvedValue({ people: [me, anna], skipped: 0 });
  let clock = new Date("2026-09-17T12:00:00Z");
  const { profile, sync, store } = fixture(load, () => clock);
  await sync.run();
  const before = store.peopleContext(profile.root, "Anna", me.email, tenantId);
  clock = new Date("2026-09-18T12:00:00Z");
  load.mockResolvedValue({ people: [anna, anna], skipped: 0 });
  expect((await sync.run()).error).toContain("previous directory is preserved");
  expect(store.peopleContext(profile.root, "Anna", me.email, tenantId)).toEqual(before);
  load.mockResolvedValue({ people: [anna], skipped: 0 });
  expect((await sync.run()).error).toBeNull();
  expect(store.person(profile.root, tenantId, me.email)).toBeNull();
  load.mockResolvedValue({ people: [], skipped: 2 });
  expect((await sync.run()).count).toBe(0);
  expect(store.peopleContext(profile.root, "Anna", me.email, tenantId)).toMatchObject({
    candidates: [],
    self: null,
    totalMatches: 0,
    syncedAt: clock.toISOString(),
  });
});

it("isolates directory snapshots by profile and tenant", () => {
  const { profile, store } = fixture();
  store.replacePeople(profile.root, tenantId, [me], "2026-09-17");
  store.replacePeople(profile.root, clientId, [anna], "2026-09-18");
  store.replacePeople("/another-profile", tenantId, [anna], "2026-09-19");
  expect(store.person(profile.root, tenantId, anna.email)).toBeNull();
  expect(store.person(profile.root, clientId, me.email)).toBeNull();
  expect(store.person("/another-profile", tenantId, me.email)).toBeNull();
  expect(store.peopleContext("/missing-profile", "Anna", me.email, tenantId)).toBeNull();
  expect(store.peopleSyncedAt(profile.root, tenantId)).toBe("2026-09-17");
  expect(store.person(profile.root, clientId, anna.email)).toEqual(anna);
});

it("preserves Unicode matching, literal punctuation, and identity precedence in SQL lookups", () => {
  const { profile, store } = fixture();
  const other = { ...anna, lastname: "Other", email: "other@example.com" };
  const quoted = { ...anna, prename: "O'Neil", lastname: "A+B", email: "oneil@example.com" };
  store.replacePeople(profile.root, tenantId, [me, anna, other, quoted], "2026-09-17");
  expect(
    store.peopleContext(profile.root, "ＡＮＮＡ Mu\u0308ller", me.email, tenantId)?.candidates,
  ).toEqual([anna]);
  expect(
    store.peopleContext(profile.root, "Anna Müller and Anna", me.email, tenantId)?.candidates,
  ).toEqual([anna, other]);
  expect(store.peopleContext(profile.root, "O'Neil A+B", me.email, tenantId)?.candidates).toEqual([
    quoted,
  ]);
  expect(
    store.peopleContext(profile.root, "'; DROP TABLE people; --", me.email, tenantId)?.totalMatches,
  ).toBe(0);
  expect(store.person(profile.root, tenantId, "ANNA@EXAMPLE.COM")).toEqual(anna);
  expect(
    store.peopleContext(profile.root, "AnnaX notanna@example.com", me.email, tenantId)
      ?.totalMatches,
  ).toBe(0);
});

it("bounds ambiguous matches, prioritizes exact identities, and never adds the whole directory to profile retrieval", async () => {
  const people = [
    me,
    ...Array.from({ length: 30 }, (_, index) => ({
      ...anna,
      lastname: `Person${index}`,
      email: `anna${index}@example.com`,
    })),
  ];
  const { sync, profile, store } = fixture(async () => ({ people, skipped: 0 }));
  await sync.run();
  expect(store.peopleContext(profile.root, "Ask ANNA", me.email, tenantId)).toMatchObject({
    totalMatches: 30,
  });
  expect(
    store.peopleContext(profile.root, "Ask ANNA", me.email, tenantId)?.candidates,
  ).toHaveLength(10);
  expect(
    store.peopleContext(profile.root, "Ask anna29@example.com", me.email, tenantId)?.candidates[0]
      .email,
  ).toBe("anna29@example.com");
  expect(
    store.peopleContext(profile.root, "Ask Anna Person29", me.email, tenantId)?.totalMatches,
  ).toBe(1);
  expect(
    store.peopleContext(profile.root, "Annapolis announcement", me.email, tenantId)?.candidates,
  ).toHaveLength(0);
  expect(store.peopleContext(profile.root, "Anna", me.email, clientId)).toBeNull();
  expect(profile.context("Anna Engineering").documents).toEqual([]);
  expect(profile.context("Anna").directory.some((entry) => entry.path === "people.md")).toBe(false);
});

it("stores credentials privately, never returns them, and does not reuse a secret across identities", async () => {
  const { settings, defaults, root } = fixture();
  const store = new Store(":memory:");
  const app = createApp({ settings, store });
  cleanup.push(async () => {
    await app.close();
    store.db.close();
  });
  const credentials = {
    ...input,
    authMode: "client-secret",
    clientId,
    clientSecret: "private-client-secret",
  };
  const result = await app.inject({
    method: "PUT",
    url: "/api/settings/entra",
    headers,
    payload: credentials,
  });
  expect(result.statusCode).toBe(200);
  expect(result.body).not.toContain("private-client-secret");
  expect(result.json().entra.hasClientSecret).toBe(true);
  expect((await app.inject({ url: "/api/settings", headers })).body).not.toContain(
    "private-client-secret",
  );
  expect(new SettingsStore(defaults).entraCredentials()?.clientSecret).toBe(
    "private-client-secret",
  );
  expect(statSync(join(root, "settings.json")).mode & 0o777).toBe(0o600);
  const { clientSecret: _secret, ...withoutSecret } = credentials;
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/settings/entra",
        headers,
        payload: withoutSecret,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/settings/entra",
        headers,
        payload: { ...withoutSecret, tenantId: clientId },
      })
    ).statusCode,
  ).toBe(400);
  expect(settings.entraCredentials()?.tenantId).toBe(tenantId);
  expect(entraSchema.safeParse({ ...input, tenantId: "../evil" }).success).toBe(false);
});

it("includes selected people for captures and conversation follow-ups, and records the directory source", async () => {
  const { settings, sync, store } = fixture(async () => ({
    people: [
      me,
      anna,
      ...Array.from({ length: 20 }, (_, index) => ({
        ...anna,
        lastname: `Other${index}`,
        email: `anna${index}@example.com`,
      })),
    ],
    skipped: 0,
  }));
  await sync.run();
  const contexts: AssistantContext[] = [];
  const assistant: Assistant = {
    interpret: async (_text, context) => {
      contexts.push(context);
      return {
        title: "Ask Anna",
        kind: "commitment",
        project: "",
        dueDate: null,
        priority: "normal",
        relatedId: null,
        rationale: "Anna from Engineering",
        needsClarification: false,
        updateProfile: false,
        referenceIds: [],
        refinedDescription: "",
        sources: ["people"],
      };
    },
    ask: async (_text, context) => {
      contexts.push(context);
      return { answer: "Anna is in Engineering", sources: ["people"] };
    },
    updateProfile: async () => {
      throw new Error("Unexpected profile update");
    },
  };
  const app = createApp({ settings, store, assistant, peopleSync: sync });
  cleanup.push(async () => {
    await app.close();
  });
  const item = store.capture("Ask Anna Müller about onboarding");
  await app.inject({ method: "POST", url: `/api/items/${item.id}/process`, headers });
  expect(contexts[0].people?.candidates.map((row) => row.email)).toEqual([anna.email]);
  expect(store.get(item.id)?.sourcePaths).toContain("people");
  await app.inject({ method: "POST", url: "/api/ask", headers, payload: { text: "Who is Anna?" } });
  expect(contexts[1].people?.totalMatches).toBe(21);
  await app.inject({
    method: "POST",
    url: "/api/ask",
    headers,
    payload: { text: "I mean anna@example.com" },
  });
  expect(contexts[2].people?.totalMatches).toBe(1);
  await app.inject({
    method: "POST",
    url: "/api/ask",
    headers,
    payload: { text: "Which team is she in?" },
  });
  expect(contexts[3].people?.totalMatches).toBe(1);
  expect(contexts[3].people?.candidates[0].email).toBe(anna.email);
  expect(contexts[3].profile.documents).toEqual([]);
});

it("clarifies ambiguous people through existing review and persists a corrected identity with fresh relationships", async () => {
  const michael = { ...anna, prename: "Michael", lastname: "First", email: "first@example.com" };
  const { settings, sync, store, profile } = fixture(async () => ({
    people: [
      { ...me, role: "Team Lead" },
      michael,
      { ...michael, lastname: "Second", email: "second@example.com" },
    ],
    skipped: 0,
  }));
  await sync.run();
  const contexts: AssistantContext[] = [];
  const assistant: Assistant = {
    interpret: async (_text, context) => {
      contexts.push(context);
      return {
        title: "Ask Michael",
        kind: "commitment",
        project: "",
        dueDate: null,
        priority: "normal",
        relatedId: null,
        rationale: "",
        needsClarification: false,
        updateProfile: false,
        referenceIds: context.candidates.slice(0, 1).map((candidate) => candidate.id),
        refinedDescription: "Discuss onboarding.",
        sources: ["people"],
      };
    },
    ask: async () => ({ answer: "", sources: [] }),
    updateProfile: async () => {
      throw new Error("Unexpected profile update");
    },
  };
  const app = createApp({ settings, store, assistant, peopleSync: sync });
  cleanup.push(async () => {
    await app.close();
  });
  const item = store.capture("Ask Michael about onboarding");
  const process = () =>
    app.inject({ method: "POST", url: `/api/items/${item.id}/process`, headers });
  await process();
  expect(store.get(item.id)).toMatchObject({
    processing: "review",
    references: [],
    body: item.body,
  });
  expect(store.get(item.id)?.rationale).toContain("Please clarify");
  const edit = await app.inject({
    method: "PATCH",
    url: `/api/items/${item.id}`,
    headers,
    payload: { revision: store.get(item.id)?.revision, body: "Ask Michael First about onboarding" },
  });
  expect(edit.statusCode).toBe(200);
  await process();
  expect(store.get(item.id)).toMatchObject({
    processing: "ready",
    references: [{ target: michael.email, mention: "Michael First" }],
  });
  expect(contexts.at(-1)?.people?.relationships[0].userLeadsAt).toEqual(["team"]);
  const references = store.get(item.id)?.references;
  store.replacePeople(
    profile.root,
    tenantId,
    [
      { ...me, role: "Team Lead" },
      { ...michael, team: "Other" },
    ],
    "2026-09-22",
  );
  await process();
  expect(store.get(item.id)?.references).toEqual(references);
  expect(contexts.at(-1)?.people?.relationships[0].userLeadsAt).toEqual([]);
});

it("blocks settings and profile changes while syncing and stops scheduled work when disabled", async () => {
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const load = vi.fn(async () => {
    await gate;
    return { people: [me], skipped: 0 };
  });
  const { settings, sync, store } = fixture(load);
  const app = createApp({ settings, store, peopleSync: sync });
  cleanup.push(async () => {
    finish();
    await app.close();
  });
  expect((await app.inject({ method: "POST", url: "/api/people/sync", headers })).statusCode).toBe(
    202,
  );
  expect(
    (await app.inject({ method: "PUT", url: "/api/settings/entra", headers, payload: input }))
      .statusCode,
  ).toBe(409);
  expect(
    (await app.inject({ method: "POST", url: "/api/settings/profile", headers, payload: {} }))
      .statusCode,
  ).toBe(409);
  finish();
  await sync.close();
  settings.saveEntra({ ...input, enabled: false });
  await sync.run(true);
  expect(load).toHaveBeenCalledTimes(1);
});
