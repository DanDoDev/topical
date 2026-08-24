import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { TopicalError } from "./errors.js";

const HISTORY_SCHEMA_VERSION = 1;
const HISTORY_DIRECTORY = ".topical-history";
const EVENTS_PER_SHARD = 128;
const MAX_HISTORY_PAGE = 100;

async function exists(target) {
  try { await lstat(target); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertInsideRoot(root, target) {
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new TopicalError("History storage must stay inside TOPICAL_ROOT.", { code: "INTEGRITY_ERROR" });
  }
}

async function assertRealPath(root, target, expectedType) {
  assertInsideRoot(root, target);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    if (!await exists(current)) return;
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new TopicalError("Symbolic links are not permitted in Topical history storage.", { code: "INTEGRITY_ERROR" });
    }
  }
  if (!await exists(target)) return;
  const details = await lstat(target);
  if (expectedType === "directory" && !details.isDirectory()) {
    throw new TopicalError("Topical history storage must be a real directory.", { code: "INTEGRITY_ERROR" });
  }
  if (expectedType === "file" && !details.isFile()) {
    throw new TopicalError("Topical history storage must be a real file.", { code: "INTEGRITY_ERROR" });
  }
}

async function writeAtomic(root, target, content) {
  assertInsideRoot(root, target);
  await mkdir(path.dirname(target), { recursive: true });
  await assertRealPath(root, path.dirname(target), "directory");
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

function configure(database) {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("journal_mode = DELETE");
  database.pragma("synchronous = FULL");
}

function createSchema(database, { eventCount = 0, maxSequence = 0 } = {}) {
  configure(database);
  database.exec(`
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL,
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      path TEXT,
      description TEXT NOT NULL
    ) STRICT;

    CREATE INDEX events_topic_sequence ON events(topic, sequence DESC);
    CREATE INDEX events_action_sequence ON events(action, sequence DESC);
  `);
  const insert = database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");
  insert.run("schema_version", String(HISTORY_SCHEMA_VERSION));
  insert.run("event_count", String(eventCount));
  insert.run("max_sequence", String(maxSequence));
  insert.run("built_at", new Date().toISOString());
}

function eventValues(event) {
  return {
    sequence: event.sequence,
    id: event.id,
    topic: event.topic,
    at: event.at,
    action: event.action,
    path: event.path ?? null,
    description: event.description
  };
}

function insertEvent(database, event) {
  database.prepare(`
    INSERT OR IGNORE INTO events(sequence, id, topic, at, action, path, description)
    VALUES (@sequence, @id, @topic, @at, @action, @path, @description)
  `).run(eventValues(event));
}

function validateEvent(value) {
  if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return false;
  if (typeof value.id !== "string" || !value.id) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.topic || "")) return false;
  if (typeof value.at !== "string" || typeof value.action !== "string" || typeof value.description !== "string") return false;
  return value.path === null || value.path === undefined || typeof value.path === "string";
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify({ version: 1, ...value }), "utf8").toString("base64url");
}

function decodeCursor(cursor, scope) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (value?.version !== 1 || value.scope !== scope) throw new Error();
    if (!Number.isSafeInteger(value.high) || value.high < 0) throw new Error();
    if (!Number.isSafeInteger(value.before) || value.before < 1) throw new Error();
    return value;
  } catch {
    throw new TopicalError("cursor is invalid or incompatible.", { code: "INVALID_CURSOR" });
  }
}

function legacyEventId(topic, event) {
  return `legacy-${createHash("sha256").update(JSON.stringify([
    topic,
    event.at,
    event.action,
    event.path ?? null,
    event.description
  ])).digest("hex")}`;
}

export class HistoryStore {
  #database = null;
  #initialized = false;
  #initializePromise = null;

  constructor(root) {
    this.root = path.resolve(root);
    this.directory = path.join(this.root, HISTORY_DIRECTORY);
    this.eventsDirectory = path.join(this.directory, "events");
    this.pendingDirectory = path.join(this.directory, "pending");
    this.manifestPath = path.join(this.directory, "manifest.json");
    this.databasePath = path.join(this.directory, "history.sqlite");
  }

  async initialize() {
    if (this.#initialized) return this;
    if (this.#initializePromise) return this.#initializePromise;
    this.#initializePromise = this.#initialize();
    try { return await this.#initializePromise; }
    finally { this.#initializePromise = null; }
  }

  async #initialize() {
    await assertRealPath(this.root, this.directory, "directory");
    await mkdir(this.eventsDirectory, { recursive: true });
    await mkdir(this.pendingDirectory, { recursive: true });
    await assertRealPath(this.root, this.eventsDirectory, "directory");
    await assertRealPath(this.root, this.pendingDirectory, "directory");

    let manifest = await this.#readManifest();
    const pending = await readdir(this.pendingDirectory, { withFileTypes: true });
    if (pending.some((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
      for (const entry of pending) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const pendingPath = path.join(this.pendingDirectory, entry.name);
        const event = JSON.parse(await readFile(pendingPath, "utf8"));
        if (!validateEvent(event)) throw new TopicalError("Pending audit history is invalid.", { code: "INTEGRITY_ERROR" });
        const destination = this.#eventPath(event);
        if (!await exists(destination)) await writeAtomic(this.root, destination, `${JSON.stringify(event)}\n`);
      }
      manifest = await this.#rebuild();
      for (const entry of pending) {
        if (entry.isFile() && entry.name.endsWith(".json")) await unlink(path.join(this.pendingDirectory, entry.name));
      }
    } else if (!await this.#openCompatibleDatabase(manifest)) {
      manifest = await this.#rebuild();
    }
    this.#initialized = true;
    return manifest;
  }

  async close() {
    this.#database?.close();
    this.#database = null;
    this.#initialized = false;
  }

  async #readManifest() {
    if (!await exists(this.manifestPath)) {
      const manifest = { version: HISTORY_SCHEMA_VERSION, eventCount: 0, nextSequence: 1, updatedAt: new Date().toISOString() };
      await writeAtomic(this.root, this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return manifest;
    }
    await assertRealPath(this.root, this.manifestPath, "file");
    try {
      const manifest = JSON.parse(await readFile(this.manifestPath, "utf8"));
      if (manifest?.version !== HISTORY_SCHEMA_VERSION || !Number.isSafeInteger(manifest.eventCount) || manifest.eventCount < 0) throw new Error();
      if (!Number.isSafeInteger(manifest.nextSequence) || manifest.nextSequence < 1) throw new Error();
      return manifest;
    } catch {
      throw new TopicalError("Topical audit-history manifest is invalid.", { code: "INTEGRITY_ERROR" });
    }
  }

  async #writeManifest(manifest) {
    const value = { ...manifest, version: HISTORY_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
    await writeAtomic(this.root, this.manifestPath, `${JSON.stringify(value, null, 2)}\n`);
    return value;
  }

  #eventPath(event) {
    const shard = String(Math.floor((event.sequence - 1) / EVENTS_PER_SHARD)).padStart(8, "0");
    const filename = `${String(event.sequence).padStart(16, "0")}-${event.id}.json`;
    return path.join(this.eventsDirectory, shard, filename);
  }

  async #openCompatibleDatabase(manifest) {
    if (!await exists(this.databasePath)) return false;
    await assertRealPath(this.root, this.databasePath, "file");
    let database;
    try {
      database = new Database(this.databasePath);
      configure(database);
      const integrity = database.pragma("quick_check", { simple: true });
      const metadata = Object.fromEntries(database.prepare("SELECT key, value FROM metadata").all().map((row) => [row.key, row.value]));
      if (integrity !== "ok" || Number(metadata.schema_version) !== HISTORY_SCHEMA_VERSION) throw new Error();
      if (Number(metadata.event_count) !== manifest.eventCount || Number(metadata.max_sequence) !== manifest.nextSequence - 1) throw new Error();
      this.#database = database;
      return true;
    } catch {
      database?.close();
      return false;
    }
  }

  async #readDurableEvents() {
    const events = [];
    for (const shard of await readdir(this.eventsDirectory, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^\d{8}$/.test(shard.name)) continue;
      const shardPath = path.join(this.eventsDirectory, shard.name);
      await assertRealPath(this.root, shardPath, "directory");
      for (const entry of await readdir(shardPath, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const value = JSON.parse(await readFile(path.join(shardPath, entry.name), "utf8"));
        if (!validateEvent(value)) throw new TopicalError("A durable audit event is invalid.", { code: "INTEGRITY_ERROR" });
        events.push(value);
      }
    }
    events.sort((left, right) => left.sequence - right.sequence);
    const sequences = new Set();
    const ids = new Set();
    for (const event of events) {
      if (sequences.has(event.sequence) || ids.has(event.id)) {
        throw new TopicalError("Durable audit history contains duplicate identities.", { code: "INTEGRITY_ERROR" });
      }
      sequences.add(event.sequence);
      ids.add(event.id);
    }
    return events;
  }

  async #rebuild() {
    const events = await this.#readDurableEvents();
    const maxSequence = events.at(-1)?.sequence || 0;
    const manifest = await this.#writeManifest({ eventCount: events.length, nextSequence: maxSequence + 1 });
    const temporaryPath = `${this.databasePath}.${randomUUID()}.tmp`;
    let database;
    try {
      database = new Database(temporaryPath);
      createSchema(database, { eventCount: events.length, maxSequence });
      database.transaction((values) => {
        for (const event of values) insertEvent(database, event);
      })(events);
      const integrity = database.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error(`History lookup rebuild failed integrity check: ${integrity}`);
      database.close();
      database = null;
      this.#database?.close();
      this.#database = null;
      await rename(temporaryPath, this.databasePath);
      if (!await this.#openCompatibleDatabase(manifest)) throw new Error("Rebuilt history lookup is incompatible.");
      return manifest;
    } finally {
      database?.close();
      if (await exists(temporaryPath)) await unlink(temporaryPath);
    }
  }

  #requireDatabase() {
    if (!this.#database) throw new TopicalError("Topical audit history is unavailable.", { code: "INTEGRITY_ERROR" });
    return this.#database;
  }

  async append({ topic, at = new Date().toISOString(), action, path: eventPath = null, description }) {
    await this.initialize();
    const manifest = await this.#readManifest();
    const event = {
      sequence: manifest.nextSequence,
      id: randomUUID(),
      topic,
      at,
      action,
      path: eventPath ?? null,
      description
    };
    if (!validateEvent(event)) throw new TopicalError("Audit event is invalid.", { code: "INVALID_INPUT" });
    const pendingPath = path.join(this.pendingDirectory, `${event.id}.json`);
    await writeAtomic(this.root, pendingPath, `${JSON.stringify(event)}\n`);
    await writeAtomic(this.root, this.#eventPath(event), `${JSON.stringify(event)}\n`);
    const nextManifest = await this.#writeManifest({ eventCount: manifest.eventCount + 1, nextSequence: event.sequence + 1 });
    try {
      const database = this.#requireDatabase();
      database.transaction(() => {
        insertEvent(database, event);
        database.prepare("UPDATE metadata SET value = ? WHERE key = 'event_count'").run(String(nextManifest.eventCount));
        database.prepare("UPDATE metadata SET value = ? WHERE key = 'max_sequence'").run(String(event.sequence));
        database.prepare("UPDATE metadata SET value = ? WHERE key = 'built_at'").run(new Date().toISOString());
      })();
    } catch {
      this.#database?.close();
      this.#database = null;
      await this.#rebuild();
    }
    await unlink(pendingPath);
    return event;
  }

  async importLegacy(topic, values) {
    return this.importLegacyEntries((values || []).map((event) => ({ topic, event })));
  }

  async importLegacyEntries(entries) {
    await this.initialize();
    if (!Array.isArray(entries) || !entries.length) return { imported: 0 };
    const database = this.#requireDatabase();
    const existing = database.prepare("SELECT 1 FROM events WHERE id = ? LIMIT 1");
    const manifest = await this.#readManifest();
    const additions = [];
    const plannedIds = new Set();
    let nextSequence = manifest.nextSequence;
    for (const entry of entries) {
      const { topic, event: value } = entry;
      const id = typeof value.id === "string" && value.id ? value.id : legacyEventId(topic, value);
      if (existing.get(id) || plannedIds.has(id)) continue;
      const event = {
        sequence: nextSequence,
        id,
        topic,
        at: value.at,
        action: value.action,
        path: value.path ?? null,
        description: value.description
      };
      if (!validateEvent(event)) throw new TopicalError("Legacy audit history is invalid.", { code: "INTEGRITY_ERROR" });
      additions.push(event);
      plannedIds.add(id);
      nextSequence += 1;
    }
    if (!additions.length) return { imported: 0 };
    for (const event of additions) {
      await writeAtomic(this.root, path.join(this.pendingDirectory, `${event.id}.json`), `${JSON.stringify(event)}\n`);
      await writeAtomic(this.root, this.#eventPath(event), `${JSON.stringify(event)}\n`);
    }
    const nextManifest = await this.#writeManifest({ eventCount: manifest.eventCount + additions.length, nextSequence });
    try {
      database.transaction((events) => {
        for (const event of events) insertEvent(database, event);
        database.prepare("UPDATE metadata SET value = ? WHERE key = 'event_count'").run(String(nextManifest.eventCount));
        database.prepare("UPDATE metadata SET value = ? WHERE key = 'max_sequence'").run(String(nextSequence - 1));
        database.prepare("UPDATE metadata SET value = ? WHERE key = 'built_at'").run(new Date().toISOString());
      })(additions);
    } catch {
      this.#database?.close();
      this.#database = null;
      await this.#rebuild();
    }
    for (const event of additions) await unlink(path.join(this.pendingDirectory, `${event.id}.json`));
    return { imported: additions.length };
  }

  async list({ topic, action, pathQuery = "", cursor, limit = 50 } = {}) {
    await this.initialize();
    const database = this.#requireDatabase();
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, MAX_HISTORY_PAGE));
    const normalizedPath = String(pathQuery || "").trim();
    const scope = JSON.stringify({ topic: topic || null, action: action || null, pathQuery: normalizedPath });
    const decoded = decodeCursor(cursor, scope);
    const conditions = [];
    const parameters = {};
    if (topic) { conditions.push("topic = @topic"); parameters.topic = topic; }
    if (action) { conditions.push("action = @action"); parameters.action = action; }
    if (normalizedPath) { conditions.push("instr(COALESCE(path, ''), @pathQuery) > 0"); parameters.pathQuery = normalizedPath; }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const high = decoded?.high ?? Number(database.prepare(`SELECT COALESCE(MAX(sequence), 0) FROM events ${where}`).pluck().get(parameters));
    const before = decoded?.before ?? high + 1;
    const pageConditions = [...conditions, "sequence <= @high", "sequence < @before"];
    const rows = database.prepare(`
      SELECT sequence, id, topic, at, action, path, description
      FROM events
      WHERE ${pageConditions.join(" AND ")}
      ORDER BY sequence DESC
      LIMIT @pageLimit
    `).all({ ...parameters, high, before, pageLimit: boundedLimit + 1 });
    const items = rows.slice(0, boundedLimit);
    const hasMore = rows.length > boundedLimit;
    const total = Number(database.prepare(`SELECT COUNT(*) FROM events ${where}${where ? " AND" : " WHERE"} sequence <= @high`).pluck().get({ ...parameters, high }));
    return {
      events: items,
      page: {
        limit: boundedLimit,
        total,
        nextCursor: hasMore && items.length ? encodeCursor({ scope, high, before: items.at(-1).sequence }) : null
      }
    };
  }

  async health() {
    await this.initialize();
    const database = this.#requireDatabase();
    const manifest = await this.#readManifest();
    return {
      status: "ready",
      schemaVersion: HISTORY_SCHEMA_VERSION,
      durable: true,
      eventCount: manifest.eventCount,
      maxSequence: manifest.nextSequence - 1,
      lookupBytes: (await stat(this.databasePath)).size,
      pendingEvents: (await readdir(this.pendingDirectory)).filter((name) => name.endsWith(".json")).length,
      indexedEvents: Number(database.prepare("SELECT COUNT(*) FROM events").pluck().get())
    };
  }
}
