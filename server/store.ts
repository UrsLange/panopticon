import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { type PeopleContext, type Person, peopleColumns } from "../shared/people.js";
import type { Project } from "../shared/projects.js";
import type { Item, ItemFields } from "../shared/schema.js";
import type { Implementation } from "../shared/t3.js";
import {
  assertItemLink,
  assertRevision,
  capturedItem,
  dailyCommitments,
  relatedItems,
  revisedItem,
} from "./application/items.js";
import { peopleRelationships } from "./application/people-relationships.js";
import type {
  ProfileActivity,
  ProfileActivityKind,
  ProfileLearningState,
} from "./application/profile-learning-model.js";
import type { GitHubCacheEntry } from "./github-api.js";

const personPattern = (value: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_@.])${value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_@])`,
    "gu",
  );

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(file)) chmodSync(file, 0o600);
      }
    }
    this.db.function("person_match", { deterministic: true }, (value, query) =>
      Number(personPattern(String(value)).test(String(query))),
    );
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        profileRoot TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT NOT NULL,
        PRIMARY KEY (profileRoot, id)
      );
      CREATE TABLE IF NOT EXISTS github_cache (key TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, original TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        project TEXT NOT NULL, dueDate TEXT, priority TEXT NOT NULL,
        relatedId TEXT REFERENCES items(id), createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        processing TEXT NOT NULL, processingError TEXT,
        rationale TEXT NOT NULL, sourcePaths TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_deadlines ON items(status, kind, dueDate);
      CREATE TABLE IF NOT EXISTS implementations (
        id TEXT PRIMARY KEY, itemId TEXT NOT NULL REFERENCES items(id),
        profileRoot TEXT NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS implementations_item ON implementations(itemId, profileRoot);
      CREATE TABLE IF NOT EXISTS item_history (
        id INTEGER PRIMARY KEY, itemId TEXT NOT NULL REFERENCES items(id),
        snapshot TEXT NOT NULL, changedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL,
        sources TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_activity (
        id INTEGER PRIMARY KEY, profileRoot TEXT NOT NULL,
        kind TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS profile_activity_profile ON profile_activity(profileRoot, id);
      CREATE TABLE IF NOT EXISTS profile_learning (
        profileRoot TEXT PRIMARY KEY, snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS people_directories (
        profilePath TEXT NOT NULL, tenantId TEXT NOT NULL, syncedAt TEXT NOT NULL,
        PRIMARY KEY (profilePath, tenantId)
      );
      CREATE TABLE IF NOT EXISTS people (
        profilePath TEXT NOT NULL, tenantId TEXT NOT NULL, position INTEGER NOT NULL,
        prename TEXT NOT NULL, lastname TEXT NOT NULL, email TEXT NOT NULL,
        role TEXT NOT NULL, team TEXT NOT NULL, unit TEXT NOT NULL,
        subdivision TEXT NOT NULL, division TEXT NOT NULL, company TEXT NOT NULL,
        PRIMARY KEY (profilePath, tenantId, email),
        FOREIGN KEY (profilePath, tenantId) REFERENCES people_directories(profilePath, tenantId)
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(items)").all();
    if (!columns.some((column) => column.name === "clarifications"))
      this.db.exec("ALTER TABLE items ADD COLUMN clarifications TEXT NOT NULL DEFAULT '[]'");
    if (!columns.some((column) => column.name === "noProject")) {
      this.db.exec("ALTER TABLE items ADD COLUMN noProject INTEGER NOT NULL DEFAULT 0");
      this.db.exec(
        `UPDATE item_history SET snapshot = json_set(snapshot, '$.noProject', json('false'))`,
      );
    }
    this.db.exec(`UPDATE projects SET snapshot = json_set(snapshot, '$.hidden', json('false'))
      WHERE json_type(snapshot, '$.hidden') IS NULL`);
    if (!columns.some((column) => column.name === "repositoryId"))
      this.db.exec("ALTER TABLE items ADD COLUMN repositoryId TEXT");
    if (!columns.some((column) => column.name === "prompt")) {
      this.db.exec(
        columns.some((column) => column.name === "refinedDescription")
          ? "ALTER TABLE items RENAME COLUMN refinedDescription TO prompt"
          : "ALTER TABLE items ADD COLUMN prompt TEXT NOT NULL DEFAULT ''",
      );
    }
    this.db.exec(`UPDATE item_history SET snapshot = json_remove(
      json_set(snapshot, '$.prompt', COALESCE(json_extract(snapshot, '$.refinedDescription'), '')),
      '$.refinedDescription'
    ) WHERE json_type(snapshot, '$.prompt') IS NULL`);
    if (
      !this.db
        .prepare("PRAGMA table_info(items)")
        .all()
        .some((column) => column.name === "references")
    ) {
      this.db.exec(`ALTER TABLE items ADD COLUMN "references" TEXT NOT NULL DEFAULT '[]'`);
    }
    if (
      !this.db
        .prepare("PRAGMA table_info(items)")
        .all()
        .some((column) => column.name === "profilePath")
    ) {
      this.db.exec("ALTER TABLE items ADD COLUMN profilePath TEXT");
      for (const item of this.list().filter(
        (item) => item.kind === "note" && item.status === "done",
      )) {
        this.update(item.id, { status: "open", processing: "review" }, item.revision);
      }
    }
  }

  recordProfileActivity(profileRoot: string, kind: ProfileActivityKind, evidence: unknown) {
    this.db
      .prepare(
        "INSERT INTO profile_activity(profileRoot, kind, content, createdAt) VALUES (?, ?, ?, ?)",
      )
      .run(profileRoot, kind, JSON.stringify(evidence), new Date().toISOString());
  }

  profileActivity(profileRoot: string, after: number): ProfileActivity[] {
    return this.db
      .prepare(
        "SELECT id, kind, content, createdAt FROM profile_activity WHERE profileRoot = ? AND id > ? ORDER BY id LIMIT 100",
      )
      .all(profileRoot, after) as ProfileActivity[];
  }

  profileLearningState(profileRoot: string): ProfileLearningState | undefined {
    const row = this.db
      .prepare("SELECT snapshot FROM profile_learning WHERE profileRoot = ?")
      .get(profileRoot);
    return row ? (JSON.parse(String(row.snapshot)) as ProfileLearningState) : undefined;
  }

  profileConversation(profileRoot: string): { role: string; content: string }[] {
    return this.db
      .prepare(
        "SELECT content FROM profile_activity WHERE profileRoot = ? AND kind = 'conversation' ORDER BY id DESC LIMIT 4",
      )
      .all(profileRoot)
      .reverse()
      .map((row) => {
        const { role, content } = JSON.parse(String(row.content));
        return { role, content };
      });
  }

  saveProfileLearningState(profileRoot: string, state: ProfileLearningState) {
    this.db
      .prepare(`INSERT INTO profile_learning(profileRoot, snapshot) VALUES (?, ?)
      ON CONFLICT(profileRoot) DO UPDATE SET snapshot = excluded.snapshot`)
      .run(profileRoot, JSON.stringify(state));
  }

  githubCache(key: string): GitHubCacheEntry | undefined {
    const row = this.db.prepare("SELECT snapshot FROM github_cache WHERE key = ?").get(key);
    return row ? (JSON.parse(String(row.snapshot)) as GitHubCacheEntry) : undefined;
  }

  saveGithubCache(key: string, entry: GitHubCacheEntry) {
    this.db
      .prepare(`INSERT INTO github_cache (key, snapshot) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET snapshot = excluded.snapshot`)
      .run(key, JSON.stringify(entry));
  }

  projects(profileRoot: string): Project[] {
    return this.db
      .prepare("SELECT snapshot FROM projects WHERE profileRoot = ? ORDER BY id")
      .all(profileRoot)
      .map((row) => JSON.parse(String(row.snapshot)) as Project);
  }

  saveProject(project: Project) {
    this.db
      .prepare(`INSERT INTO projects (profileRoot, id, snapshot) VALUES (?, ?, ?)
      ON CONFLICT(profileRoot, id) DO UPDATE SET snapshot = excluded.snapshot`)
      .run(project.profileRoot, project.id, JSON.stringify(project));
  }

  peopleSyncedAt(profilePath: string, tenantId: string): string | null {
    const row = this.db
      .prepare("SELECT syncedAt FROM people_directories WHERE profilePath = ? AND tenantId = ?")
      .get(profilePath, tenantId);
    return row ? String(row.syncedAt) : null;
  }

  latestImplementation(itemId: string, profileRoot: string): Implementation | null {
    const row = this.db
      .prepare(
        "SELECT snapshot FROM implementations WHERE itemId = ? AND profileRoot = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(itemId, profileRoot);
    return row ? (JSON.parse(String(row.snapshot)) as Implementation) : null;
  }

  saveImplementation(entry: Implementation) {
    const previous = this.latestImplementation(entry.itemId, entry.profileRoot);
    this.db
      .prepare(`INSERT INTO implementations (id, itemId, profileRoot, snapshot) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot`)
      .run(entry.id, entry.itemId, entry.profileRoot, JSON.stringify(entry));
    if (
      previous?.id !== entry.id ||
      previous.state !== entry.state ||
      previous.progress?.turnState !== entry.progress?.turnState ||
      previous.mergedCommit !== entry.mergedCommit ||
      previous.completionReview?.head !== entry.completionReview?.head
    ) {
      const item = this.get(entry.itemId);
      this.recordProfileActivity(entry.profileRoot, "implementation", {
        itemId: entry.itemId,
        originalCapture: item?.original,
        state: entry.state,
        turnState: entry.progress?.turnState ?? null,
        mergedCommit: entry.mergedCommit ?? null,
        taskStatus: item?.status,
      });
    }
  }

  replacePeople(profilePath: string, tenantId: string, people: Person[], syncedAt: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`INSERT INTO people_directories (profilePath, tenantId, syncedAt) VALUES (?, ?, ?)
          ON CONFLICT (profilePath, tenantId) DO UPDATE SET syncedAt = excluded.syncedAt`)
        .run(profilePath, tenantId, syncedAt);
      this.db
        .prepare("DELETE FROM people WHERE profilePath = ? AND tenantId = ?")
        .run(profilePath, tenantId);
      const insert = this.db.prepare(`INSERT INTO people
        (profilePath, tenantId, position, ${peopleColumns.join(", ")})
        VALUES (?, ?, ?, ${peopleColumns.map(() => "?").join(", ")})`);
      people.forEach((person, position) => {
        insert.run(
          profilePath,
          tenantId,
          position,
          ...peopleColumns.map((column) => person[column]),
        );
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  person(profilePath: string, tenantId: string, email: string): Person | null {
    return (
      (this.db
        .prepare(`SELECT ${peopleColumns.join(", ")} FROM people
        WHERE profilePath = ? AND tenantId = ? AND email = ?`)
        .get(profilePath, tenantId, email.toLowerCase()) as Person | undefined) ?? null
    );
  }

  peopleContext(
    profilePath: string,
    query: string,
    myEmail: string,
    tenantId: string,
  ): PeopleContext | null {
    const syncedAt = this.peopleSyncedAt(profilePath, tenantId);
    if (!syncedAt) return null;
    const normalized = query.normalize("NFKC").toLocaleLowerCase();
    const exactScore = `CASE WHEN person_match(email, ?) THEN 4
      WHEN person_match(prename || ' ' || lastname, ?) THEN 3 ELSE 0 END`;
    const exact = this.db
      .prepare(`SELECT email, prename, lastname, ${exactScore} AS score
      FROM people WHERE profilePath = ? AND tenantId = ? AND score > 0 ORDER BY position`)
      .all(normalized, normalized, profilePath, tenantId);
    let remaining = normalized;
    for (const person of exact) {
      remaining = remaining.replace(
        personPattern(
          person.score === 4 ? String(person.email) : `${person.prename} ${person.lastname}`,
        ),
        " ",
      );
    }
    const matches = this.db
      .prepare(`WITH ranked AS (
      SELECT ${peopleColumns.join(", ")}, position,
        CASE WHEN person_match(email, ?) THEN 4
          WHEN person_match(prename || ' ' || lastname, ?) THEN 3
          WHEN person_match(lastname, ?) THEN 2
          WHEN person_match(prename, ?) THEN 1 ELSE 0 END AS score
      FROM people WHERE profilePath = ? AND tenantId = ?
    ) SELECT ${peopleColumns.join(", ")}, COUNT(*) OVER () AS totalMatches
      FROM ranked WHERE score > 0 ORDER BY score DESC, position LIMIT 10`)
      .all(normalized, normalized, remaining, remaining, profilePath, tenantId);
    const self = this.person(profilePath, tenantId, myEmail);
    const candidates = matches.map(({ totalMatches, ...person }) => person as Person);
    return {
      source: "people",
      syncedAt,
      self,
      candidates,
      totalMatches: Number(matches[0]?.totalMatches ?? 0),
      searchTruncated: Number(matches[0]?.totalMatches ?? 0) > candidates.length,
      relationships: peopleRelationships(self, candidates),
    };
  }

  list(): Item[] {
    return this.db
      .prepare("SELECT * FROM items ORDER BY createdAt DESC, id")
      .all()
      .map((row) => ({
        ...row,
        noProject: Boolean(row.noProject),
        sourcePaths: JSON.parse(String(row.sourcePaths)),
        references: JSON.parse(String(row.references)),
        clarifications: JSON.parse(String(row.clarifications)),
      })) as Item[];
  }

  get(id: string): Item | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id);
    return row
      ? ({
          ...row,
          noProject: Boolean(row.noProject),
          sourcePaths: JSON.parse(String(row.sourcePaths)),
          references: JSON.parse(String(row.references)),
          clarifications: JSON.parse(String(row.clarifications)),
        } as Item)
      : undefined;
  }

  capture(text: string): Item {
    const now = new Date().toISOString();
    const item = capturedItem(text, randomUUID(), now);
    this.db
      .prepare(`INSERT INTO items
      (id, original, title, body, kind, status, project, dueDate, priority, relatedId,
       createdAt, updatedAt, revision, processing, processingError, rationale, sourcePaths, "references", profilePath, prompt, repositoryId, clarifications, noProject)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ...Object.values({
          ...item,
          noProject: Number(item.noProject),
          sourcePaths: JSON.stringify(item.sourcePaths),
          references: JSON.stringify(item.references),
          clarifications: JSON.stringify(item.clarifications),
        }),
      );
    return item;
  }

  update(
    id: string,
    fields: Partial<ItemFields> &
      Partial<
        Pick<
          Item,
          | "processing"
          | "processingError"
          | "rationale"
          | "sourcePaths"
          | "references"
          | "profilePath"
          | "repositoryId"
          | "clarifications"
        >
      >,
    revision: number,
  ): Item {
    const current = this.get(id);
    assertRevision(current, revision);
    assertItemLink(id, fields.relatedId, !fields.relatedId || !!this.get(fields.relatedId));
    const next = revisedItem(current, fields, revision, new Date().toISOString());
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO item_history(itemId, snapshot, changedAt) VALUES (?, ?, ?)")
        .run(id, JSON.stringify(current), next.updatedAt);
      this.db
        .prepare(`UPDATE items SET title=?, body=?, kind=?, status=?, project=?, dueDate=?,
        priority=?, relatedId=?, updatedAt=?, revision=?, processing=?, processingError=?,
        rationale=?, sourcePaths=?, "references"=?, profilePath=?, prompt=?, repositoryId=?, clarifications=?, noProject=? WHERE id=?`)
        .run(
          next.title,
          next.body,
          next.kind,
          next.status,
          next.project,
          next.dueDate,
          next.priority,
          next.relatedId,
          next.updatedAt,
          next.revision,
          next.processing,
          next.processingError,
          next.rationale,
          JSON.stringify(next.sourcePaths),
          JSON.stringify(next.references),
          next.profilePath,
          next.prompt,
          next.repositoryId,
          JSON.stringify(next.clarifications),
          Number(next.noProject),
          id,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return next;
  }

  history(id: string) {
    return this.db
      .prepare("SELECT snapshot, changedAt FROM item_history WHERE itemId=? ORDER BY id DESC")
      .all(id)
      .map((row) => ({
        item: JSON.parse(String(row.snapshot)) as Item,
        changedAt: String(row.changedAt),
      }));
  }

  today(date: string) {
    return dailyCommitments(this.list(), date);
  }
  search(query: string, limit = 8) {
    return relatedItems(this.list(), query, limit);
  }

  addMessage(role: "user" | "assistant", content: string, sources: string[] = []) {
    this.db
      .prepare("INSERT INTO messages(role, content, sources, createdAt) VALUES (?, ?, ?, ?)")
      .run(role, content, JSON.stringify(sources), new Date().toISOString());
  }

  messages() {
    return this.db
      .prepare("SELECT * FROM messages ORDER BY id")
      .all()
      .map((row) => ({
        id: Number(row.id),
        role: String(row.role),
        content: String(row.content),
        sources: JSON.parse(String(row.sources)) as string[],
      }));
  }
}
