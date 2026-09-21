import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { type EntraConfig, type Person, peopleColumns } from "../shared/people.js";
import {
  type HierarchyLevel,
  organizationHierarchy,
  organizationName,
} from "./application/organization.js";
import type { PeopleSyncPorts } from "./application/people-ports.js";
import { PeopleSync } from "./application/people-sync.js";
import { Profile } from "./profile.js";
import type { SettingsStore } from "./settings.js";
import type { Store } from "./store.js";

const execute = promisify(execFile);
const marker = "generated_by: personal-assistant-entra";
const graph = "https://graph.microsoft.com";

export async function detectEntraTenant(): Promise<string | null> {
  try {
    const { stdout } = await execute(
      "az",
      ["account", "show", "--query", "tenantId", "--output", "tsv", "--only-show-errors"],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    const result = z.string().uuid().safeParse(stdout.trim());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function entraToken(config: EntraConfig, request = fetch): Promise<string> {
  if (config.authMode === "azure-cli") {
    try {
      const result = await execute(
        "az",
        [
          "account",
          "get-access-token",
          "--resource-type",
          "ms-graph",
          "--tenant",
          config.tenantId,
          "--query",
          "accessToken",
          "--output",
          "tsv",
          "--only-show-errors",
        ],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      const token = result.stdout.trim();
      if (!token) throw new Error();
      return token;
    } catch {
      throw new Error(
        "Azure CLI authentication failed. Ensure az is on the server PATH and sign in to the configured tenant with az login --tenant <tenant-id> --allow-no-subscriptions.",
      );
    }
  }
  try {
    const response = await request(
      `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret ?? "",
          grant_type: "client_credentials",
          scope: `${graph}/.default`,
        }),
      },
    );
    if (!response.ok) throw new Error();
    return z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
  } catch {
    throw new Error(
      "Entra authentication failed. Check the tenant, client ID, client secret, and network connection.",
    );
  }
}

async function* directoryPages(
  collection: "users" | "groups",
  select: string[],
  token: string,
  request: typeof fetch,
) {
  let url = `${graph}/v1.0/${collection}?${new URLSearchParams({ $select: select.join(","), $top: "999" })}`;
  const pages = new Set<string>();
  while (url) {
    const next = new URL(url);
    if (
      next.origin !== graph ||
      next.pathname !== `/v1.0/${collection}` ||
      next.username ||
      next.password ||
      pages.has(url)
    )
      throw new Error(
        "Graph returned an invalid directory page. The existing directory is unchanged.",
      );
    pages.add(url);
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new Error(
          "Graph denied directory access. Check the login and Microsoft Graph User.Read.All and GroupMember.Read.All permissions with administrator consent.",
        );
      throw new Error(`Directory request failed (HTTP ${response.status}). Retry the sync later.`);
    }
    const page = z
      .object({
        value: z.array(z.record(z.string(), z.unknown())),
        "@odata.nextLink": z.string().optional(),
      })
      .parse(await response.json());
    yield page.value;
    url = page["@odata.nextLink"] ?? "";
  }
}

export async function fetchPeople(token: string, request = fetch) {
  const types = new Map<string, Set<HierarchyLevel>>();
  const prefixes = { t: "team", u: "unit", sd: "subdivision", d: "division" } as const;
  for await (const page of directoryPages(
    "groups",
    ["displayName", "onPremisesSamAccountName"],
    token,
    request,
  )) {
    for (const item of page) {
      const group = z
        .object({
          displayName: z.string().max(1000).nullish(),
          onPremisesSamAccountName: z.string().max(1000).nullish(),
        })
        .parse(item);
      const prefix = group.onPremisesSamAccountName?.match(/^(t|u|sd|d)_/i)?.[1].toLowerCase() as
        | keyof typeof prefixes
        | undefined;
      if (!prefix || !group.displayName) continue;
      const name = organizationName(group.displayName);
      const levels = types.get(name) ?? new Set<HierarchyLevel>();
      levels.add(prefixes[prefix]);
      types.set(name, levels);
    }
  }
  if (!types.size)
    throw new Error(
      "Graph returned no typed organizational groups. Check group read access and synchronized group names; the previous directory is preserved.",
    );
  const people: Person[] = [];
  const emails = new Set<string>();
  const warnings = new Set<string>();
  let skipped = 0;
  for await (const page of directoryPages(
    "users",
    [
      "givenName",
      "surname",
      "mail",
      "jobTitle",
      "userType",
      "accountEnabled",
      "companyName",
      "onPremisesDistinguishedName",
    ],
    token,
    request,
  )) {
    for (const user of page) {
      const field = (path: string) => {
        const value = user[path];
        if (value == null) return "";
        return z
          .string()
          .max(1000)
          .parse(value)
          .replace(/[\r\n\t]+/g, " ")
          .trim();
      };
      const email = field("mail").toLowerCase();
      const prename = field("givenName");
      const lastname = field("surname");
      if (
        user.userType !== "Member" ||
        user.accountEnabled !== true ||
        !prename ||
        !lastname ||
        !z.email().safeParse(email).success
      ) {
        skipped++;
        continue;
      }
      if (emails.has(email))
        throw new Error(
          "Duplicate email addresses in Entra. The existing directory is unchanged; resolve the duplicates before syncing.",
        );
      emails.add(email);
      const organization = organizationHierarchy(field("onPremisesDistinguishedName"), types);
      for (const warning of organization.warnings) warnings.add(warning);
      people.push({
        prename,
        lastname,
        email,
        role: field("jobTitle"),
        ...organization.hierarchy,
        company: field("companyName"),
      });
    }
  }
  people.sort(
    (a, b) =>
      a.lastname.localeCompare(b.lastname) ||
      a.prename.localeCompare(b.prename) ||
      a.email.localeCompare(b.email),
  );
  return { people, skipped, warnings: [...warnings].sort() };
}

const decodeCell = (text: string) =>
  text
    .replaceAll("&#124;", "|")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

export function createPeopleSync(
  settings: SettingsStore,
  store: Store,
  load: PeopleSyncPorts["loadPeople"] = async (config) => fetchPeople(await entraToken(config)),
  now = () => new Date(),
) {
  const file = join(settings.dataDir, "people-sync.json");
  return new PeopleSync(
    settings,
    store,
    {
      loadPeople: load,
      loadStatus: () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}),
      saveStatus(state) {
        mkdirSync(settings.dataDir, { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
        renameSync(temporary, file);
      },
      migrate(root, selectedTenant, imported) {
        const path = join(root, "people.md");
        if (!existsSync(path) || !lstatSync(path).isFile()) return;
        const content = readFileSync(path, "utf8");
        const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
        if (!frontmatter || !content.includes(marker)) return;
        const metadata = parse(frontmatter[1]);
        if (metadata?.generated_by !== "personal-assistant-entra") return;
        const { tenant_id: tenantId, synced_at: syncedAt } = z
          .object({
            tenant_id: z.string().uuid(),
            synced_at: z.string().datetime(),
          })
          .parse(metadata);
        const lines = content.split(/\r?\n/).filter((line) => line.startsWith("| "));
        if (lines.length < 2) throw new Error("Missing directory table");
        const cells = (line: string) =>
          line
            .slice(1, -1)
            .split("|")
            .map((cell) => decodeCell(cell.trim()));
        const columns = cells(lines[0]);
        if (
          columns.length !== peopleColumns.length ||
          columns.some((column, index) => column !== peopleColumns[index])
        )
          throw new Error("Invalid directory columns");
        const people = lines.slice(2).map((line) => {
          const values = z.array(z.string()).length(peopleColumns.length).parse(cells(line));
          const person = Object.fromEntries(
            peopleColumns.map((column, index) => [column, values[index]]),
          ) as Person;
          z.string().min(1).parse(person.prename);
          z.string().min(1).parse(person.lastname);
          z.email().parse(person.email);
          return person;
        });
        if (!store.peopleSyncedAt(root, tenantId))
          store.replacePeople(root, tenantId, people, syncedAt);
        mkdirSync(settings.dataDir, { recursive: true });
        writeFileSync(join(settings.dataDir, `people-${randomUUID()}.md`), content, {
          flag: "wx",
          mode: 0o600,
        });
        if (readFileSync(path, "utf8") !== content)
          throw new Error("Directory changed during migration");
        if (tenantId === selectedTenant) {
          imported(
            store.peopleSyncedAt(root, tenantId),
            Number(
              store.db
                .prepare(
                  "SELECT COUNT(*) AS count FROM people WHERE profilePath = ? AND tenantId = ?",
                )
                .get(root, tenantId)?.count,
            ),
          );
        }
        const profile = new Profile(root);
        profile.change("migrate people directory to local storage", () => {
          profile.prepareWrite("people.md");
          unlinkSync(path);
        });
      },
    },
    now,
  );
}
