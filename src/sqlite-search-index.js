import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { TopicalError } from "./errors.js";
import {
  analyzeQuery,
  boundedEditDistance,
  canonicalTagKey,
  normalizeSearchText,
  technicalAliasEntries
} from "./normalization.js";
import { SearchIndex, SEARCH_MATCH_MODE } from "./search-index.js";

export const SEARCH_SCHEMA_VERSION = 6;
const CACHE_DIRECTORY = ".topical-cache";
const CACHE_FILENAME = "search.sqlite";
const MAX_FILE_HITS = 3;

function ftsToken(token) {
  return `"${String(token).replaceAll('"', '""')}"`;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function aliasText(entries) {
  return entries.map((entry) => entry.alias).join("\n");
}

function encodeFileCursor(scope, offset) {
  return Buffer.from(JSON.stringify({ version: 1, scope, offset }), "utf8").toString("base64url");
}

function decodeFileCursor(cursor, scope) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (value?.version !== 1 || value.scope !== scope || !Number.isInteger(value.offset) || value.offset < 0) throw new Error();
    return value.offset;
  } catch {
    throw new TopicalError("cursor is invalid or incompatible.", { code: "INVALID_CURSOR" });
  }
}

async function pathExists(target) {
  try { await lstat(target); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertInsideRoot(root, target) {
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Search cache path must stay inside TOPICAL_ROOT.");
  }
}

async function assertRealPath(root, target, expectedType) {
  assertInsideRoot(root, target);
  if (!await pathExists(target)) return;
  const details = await lstat(target);
  if (details.isSymbolicLink()) throw new Error("Symbolic links are not permitted in Topical's search cache path.");
  if (expectedType === "directory" && !details.isDirectory()) throw new Error("Topical's search cache directory must be a real directory.");
  if (expectedType === "file" && !details.isFile()) throw new Error("Topical's search cache database must be a real file.");
}

function capabilityTest() {
  const database = new Database(":memory:");
  try {
    const enabled = database.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get()?.enabled;
    if (enabled !== 1) throw new Error("The installed SQLite binding does not include FTS5.");
    database.exec(`
      CREATE VIRTUAL TABLE capability_test USING fts5(
        body,
        content='',
        contentless_delete=1,
        detail=column,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
  } finally {
    database.close();
  }
}

function configure(database) {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("journal_mode = DELETE");
  database.pragma("synchronous = FULL");
}

function createSchema(database) {
  configure(database);
  database.exec(`
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE topics (
      topic TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      last_action_json TEXT
    ) STRICT;

    CREATE TABLE topic_tags (
      topic TEXT NOT NULL REFERENCES topics(topic) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      display_tag TEXT NOT NULL,
      PRIMARY KEY (topic, tag)
    ) STRICT;

    CREATE TABLE topic_alias_terms (
      topic TEXT NOT NULL REFERENCES topics(topic) ON DELETE CASCADE,
      term TEXT NOT NULL,
      PRIMARY KEY (topic, term)
    ) STRICT;

    CREATE INDEX topic_alias_terms_term ON topic_alias_terms(term);

    CREATE TABLE records (
      id INTEGER PRIMARY KEY,
      record_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('topic', 'document')),
      topic TEXT NOT NULL REFERENCES topics(topic) ON DELETE CASCADE,
      path TEXT,
      headings_json TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      hash TEXT,
      size INTEGER,
      updated_at TEXT,
      body TEXT NOT NULL
    ) STRICT;

    CREATE INDEX records_topic_path ON records(topic, path);

    CREATE TABLE tasks (
      record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      offset INTEGER NOT NULL,
      line INTEGER NOT NULL,
      text TEXT NOT NULL,
      heading TEXT NOT NULL,
      completed INTEGER NOT NULL CHECK(completed IN (0, 1)),
      PRIMARY KEY(record_id, offset)
    ) STRICT;
    CREATE INDEX tasks_completion ON tasks(completed, record_id);

    CREATE VIRTUAL TABLE search USING fts5(
      title,
      summary,
      tags,
      path,
      headings,
      body,
      aliases,
      content='',
      contentless_delete=1,
      detail=column,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE topic_search USING fts5(
      title,
      summary,
      tags,
      path,
      headings,
      body,
      aliases,
      content='',
      contentless_delete=1,
      detail=column,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE topic_vocab USING fts5vocab(topic_search, 'row');
  `);
  database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("schema_version", String(SEARCH_SCHEMA_VERSION));
  database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("built_at", new Date().toISOString());
}

function deleteTopic(database, topic) {
  const rows = database.prepare("SELECT id, kind FROM records WHERE topic = ?").all(topic);
  const deleteSearch = database.prepare("DELETE FROM search WHERE rowid = ?");
  const deleteTopicSearch = database.prepare("DELETE FROM topic_search WHERE rowid = ?");
  for (const row of rows) {
    deleteSearch.run(row.id);
    if (row.kind === "topic") deleteTopicSearch.run(row.id);
  }
  database.prepare("DELETE FROM topics WHERE topic = ?").run(topic);
}

function insertTopic(database, snapshot) {
  const topic = snapshot.topic;
  database.prepare(`
    INSERT INTO topics(topic, title, summary, tags_json, created_at, updated_at, file_count, last_action_json)
    VALUES (@id, @title, @summary, @tagsJson, @createdAt, @updatedAt, @fileCount, @lastActionJson)
  `).run({
    id: topic.id,
    title: topic.title || topic.id,
    summary: topic.summary || "",
    tagsJson: JSON.stringify(topic.tags || []),
    createdAt: topic.createdAt || null,
    updatedAt: topic.updatedAt || new Date(0).toISOString(),
    fileCount: snapshot.documents.length,
    lastActionJson: topic.lastAction ? JSON.stringify(topic.lastAction) : null
  });

  const insertTag = database.prepare("INSERT OR IGNORE INTO topic_tags(topic, tag, display_tag) VALUES (?, ?, ?)");
  for (const displayTag of topic.tags || []) {
    insertTag.run(topic.id, canonicalTagKey(displayTag), String(displayTag));
  }

  const insertRecord = database.prepare(`
    INSERT INTO records(record_key, kind, topic, path, headings_json, excerpt, hash, size, updated_at, body)
    VALUES (@recordKey, @kind, @topic, @path, @headingsJson, @excerpt, @hash, @size, @updatedAt, @body)
  `);
  const insertSearch = database.prepare(`
    INSERT INTO search(rowid, title, summary, tags, path, headings, body, aliases)
    VALUES (@rowid, @title, @summary, @tags, @path, @headings, @body, @aliases)
  `);
  const insertTopicSearch = database.prepare(`
    INSERT INTO topic_search(rowid, title, summary, tags, path, headings, body, aliases)
    VALUES (@rowid, @title, @summary, @tags, @path, @headings, @body, @aliases)
  `);

  const topicRecord = insertRecord.run({
    recordKey: `topic:${topic.id}`,
    kind: "topic",
    topic: topic.id,
    path: null,
    headingsJson: "[]",
    excerpt: "",
    hash: null,
    size: null,
    updatedAt: null,
    body: ""
  });
  const metadataAliasEntries = technicalAliasEntries([topic.title, topic.summary, ...(topic.tags || [])].join("\n"));
  const topicAliasEntries = [...metadataAliasEntries];
  const explanationAliasEntries = [...metadataAliasEntries];
  insertSearch.run({
    rowid: topicRecord.lastInsertRowid,
    title: topic.title || topic.id,
    summary: topic.summary || "",
    tags: (topic.tags || []).join(" "),
    path: "",
    headings: "",
    body: "",
    aliases: aliasText(metadataAliasEntries)
  });

  const aggregatePaths = [];
  const aggregateHeadings = [];
  const aggregateBodies = [];
  for (const document of snapshot.documents) {
    aggregatePaths.push(document.path);
    aggregateHeadings.push(...(document.headings || []));
    aggregateBodies.push(document.body || "");
    const pathAliasEntries = technicalAliasEntries(document.path);
    const contentAliasEntries = technicalAliasEntries([...(document.headings || []), document.body || ""].join("\n"));
    const documentAliasEntries = [...pathAliasEntries, ...contentAliasEntries].slice(0, 200);
    for (const entry of documentAliasEntries) {
      if (topicAliasEntries.length >= 200) break;
      topicAliasEntries.push(entry);
    }
    for (const entry of documentAliasEntries) {
      if (explanationAliasEntries.length >= 200) break;
      explanationAliasEntries.push(entry);
    }
    const record = insertRecord.run({
      recordKey: `document:${topic.id}:${document.path}`,
      kind: "document",
      topic: topic.id,
      path: document.path,
      headingsJson: JSON.stringify(document.headings || []),
      excerpt: document.excerpt || "",
      hash: document.hash || null,
      size: document.size ?? null,
      updatedAt: document.updatedAt || null,
      body: document.body || ""
    });
    insertTasks(database, record.lastInsertRowid, document.tasks);
    insertSearch.run({
      rowid: record.lastInsertRowid,
      title: "",
      summary: "",
      tags: "",
      path: document.path,
      headings: (document.headings || []).join("\n"),
      body: document.body || "",
      aliases: aliasText(documentAliasEntries)
    });
  }
  insertTopicSearch.run({
    rowid: topicRecord.lastInsertRowid,
    title: topic.title || topic.id,
    summary: topic.summary || "",
    tags: (topic.tags || []).join(" "),
    path: aggregatePaths.join("\n"),
    headings: aggregateHeadings.join("\n"),
    body: aggregateBodies.join("\n"),
    aliases: aliasText(topicAliasEntries)
  });
  const insertAliasTerm = database.prepare("INSERT OR IGNORE INTO topic_alias_terms(topic, term) VALUES (?, ?)");
  for (const entry of explanationAliasEntries) {
    for (const term of entry.alias.match(/[\p{L}\p{N}]+/gu) || []) {
      insertAliasTerm.run(topic.id, normalizeSearchText(term));
    }
  }
}

function updateTopicMetadataRows(database, topic, fileCount) {
  database.prepare(`
    UPDATE topics
    SET title = @title, summary = @summary, tags_json = @tagsJson, created_at = @createdAt,
        updated_at = @updatedAt, file_count = @fileCount, last_action_json = @lastActionJson
    WHERE topic = @id
  `).run({
    id: topic.id,
    title: topic.title || topic.id,
    summary: topic.summary || "",
    tagsJson: JSON.stringify(topic.tags || []),
    createdAt: topic.createdAt || null,
    updatedAt: topic.updatedAt || new Date(0).toISOString(),
    fileCount,
    lastActionJson: topic.lastAction ? JSON.stringify(topic.lastAction) : null
  });
  database.prepare("DELETE FROM topic_tags WHERE topic = ?").run(topic.id);
  const insertTag = database.prepare("INSERT OR IGNORE INTO topic_tags(topic, tag, display_tag) VALUES (?, ?, ?)");
  for (const displayTag of topic.tags || []) insertTag.run(topic.id, canonicalTagKey(displayTag), String(displayTag));

  const topicRow = database.prepare("SELECT id FROM records WHERE topic = ? AND kind = 'topic'").get(topic.id);
  if (!topicRow) throw new Error(`Search topic '${topic.id}' is missing its topic record.`);
  database.prepare("DELETE FROM search WHERE rowid = ?").run(topicRow.id);
  const metadataAliases = technicalAliasEntries([topic.title, topic.summary, ...(topic.tags || [])].join("\n"));
  database.prepare(`INSERT INTO search(rowid, title, summary, tags, path, headings, body, aliases) VALUES (?, ?, ?, ?, '', '', '', ?)`)
    .run(topicRow.id, topic.title || topic.id, topic.summary || "", (topic.tags || []).join(" "), aliasText(metadataAliases));
  return topicRow.id;
}

function replaceDocumentRows(database, topic, documentPath, document) {
  const current = database.prepare("SELECT id FROM records WHERE topic = ? AND kind = 'document' AND path = ?").get(topic, documentPath);
  if (current) {
    database.prepare("DELETE FROM search WHERE rowid = ?").run(current.id);
    database.prepare("DELETE FROM records WHERE id = ?").run(current.id);
  }
  if (!document) return;
  const aliases = [...technicalAliasEntries(document.path), ...technicalAliasEntries([...(document.headings || []), document.body || ""].join("\n"))].slice(0, 200);
  const record = database.prepare(`
    INSERT INTO records(record_key, kind, topic, path, headings_json, excerpt, hash, size, updated_at, body)
    VALUES (?, 'document', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`document:${topic}:${document.path}`, topic, document.path, JSON.stringify(document.headings || []), document.excerpt || "", document.hash || null, document.size ?? null, document.updatedAt || null, document.body || "");
  insertTasks(database, record.lastInsertRowid, document.tasks);
  database.prepare(`INSERT INTO search(rowid, title, summary, tags, path, headings, body, aliases) VALUES (?, '', '', '', ?, ?, ?, ?)`)
    .run(record.lastInsertRowid, document.path, (document.headings || []).join("\n"), document.body || "", aliasText(aliases));
}

function insertTasks(database, recordId, tasks = []) {
  const insert = database.prepare("INSERT INTO tasks(record_id, offset, line, text, heading, completed) VALUES (?, ?, ?, ?, ?, ?)");
  for (const task of tasks) insert.run(recordId, task.offset, task.line, task.text, task.heading, Number(task.completed));
}

function refreshTopicAggregate(database, topic, topicRowId) {
  const documents = database.prepare("SELECT path, headings_json, body FROM records WHERE topic = ? AND kind = 'document' ORDER BY path").all(topic.id);
  const metadataAliases = technicalAliasEntries([topic.title, topic.summary, ...(topic.tags || [])].join("\n"));
  const topicAliases = [...metadataAliases];
  const explanationAliases = [...metadataAliases];
  const paths = [];
  const headings = [];
  const bodies = [];
  for (const document of documents) {
    const documentHeadings = parseJson(document.headings_json, []);
    paths.push(document.path); headings.push(...documentHeadings); bodies.push(document.body || "");
    const aliases = [...technicalAliasEntries(document.path), ...technicalAliasEntries([...documentHeadings, document.body || ""].join("\n"))].slice(0, 200);
    for (const entry of aliases) { if (topicAliases.length >= 200) break; topicAliases.push(entry); }
    for (const entry of aliases) { if (explanationAliases.length >= 200) break; explanationAliases.push(entry); }
  }
  database.prepare("DELETE FROM topic_search WHERE rowid = ?").run(topicRowId);
  database.prepare(`INSERT INTO topic_search(rowid, title, summary, tags, path, headings, body, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(topicRowId, topic.title || topic.id, topic.summary || "", (topic.tags || []).join(" "), paths.join("\n"), headings.join("\n"), bodies.join("\n"), aliasText(topicAliases));
  database.prepare("DELETE FROM topic_alias_terms WHERE topic = ?").run(topic.id);
  const insertAliasTerm = database.prepare("INSERT OR IGNORE INTO topic_alias_terms(topic, term) VALUES (?, ?)");
  for (const entry of explanationAliases) {
    for (const term of entry.alias.match(/[\p{L}\p{N}]+/gu) || []) insertAliasTerm.run(topic.id, normalizeSearchText(term));
  }
}

function fieldBoost(fields) {
  const weights = { title: 30, summary: 20, tags: 15, headings: 12, path: 8, body: 3, aliases: 1 };
  return fields.reduce((score, field) => score + (weights[field] || 0), 0);
}

export class SqliteSearchIndex extends SearchIndex {
  #database = null;
  #status = "unknown";
  #statusMessage = null;

  constructor(root) {
    super();
    this.root = path.resolve(root);
    this.cacheDirectory = path.join(this.root, CACHE_DIRECTORY);
    this.cachePath = path.join(this.cacheDirectory, CACHE_FILENAME);
  }

  async #preparePaths() {
    await assertRealPath(this.root, this.cacheDirectory, "directory");
    await mkdir(this.cacheDirectory, { recursive: true });
    await assertRealPath(this.root, this.cacheDirectory, "directory");
    await assertRealPath(this.root, this.cachePath, "file");
  }

  async #inspect() {
    if (this.#status !== "unknown") return;
    capabilityTest();
    await this.#preparePaths();
    if (!await pathExists(this.cachePath)) {
      this.#status = "missing";
      this.#statusMessage = "Search cache does not exist and must be rebuilt.";
      return;
    }
    try {
      const database = new Database(this.cachePath);
      configure(database);
      const integrity = database.pragma("quick_check", { simple: true });
      const schemaVersion = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").pluck().get();
      if (integrity !== "ok" || Number(schemaVersion) !== SEARCH_SCHEMA_VERSION) {
        database.close();
        this.#status = "incompatible";
        this.#statusMessage = "Search cache is corrupt or uses an incompatible schema.";
        return;
      }
      database.prepare("SELECT rowid FROM search LIMIT 1").get();
      database.prepare("SELECT rowid FROM topic_search LIMIT 1").get();
      database.prepare("SELECT term FROM topic_vocab LIMIT 1").get();
      database.prepare("SELECT term FROM topic_alias_terms LIMIT 1").get();
      this.#database = database;
      this.#status = "ready";
      this.#statusMessage = null;
    } catch (error) {
      this.#database?.close();
      this.#database = null;
      this.#status = "corrupt";
      this.#statusMessage = `Search cache could not be opened: ${error.message}`;
    }
  }

  #requireReady() {
    if (this.#status !== "ready" || !this.#database) {
      throw new Error(this.#statusMessage || "Search cache is not ready; rebuild it from Markdown.");
    }
    return this.#database;
  }

  async rebuild({ topics }) {
    capabilityTest();
    await this.#preparePaths();
    const temporaryPath = path.join(this.cacheDirectory, `search-${randomUUID()}.sqlite`);
    const previousPath = path.join(this.cacheDirectory, `search-${randomUUID()}.previous`);
    assertInsideRoot(this.root, temporaryPath);
    assertInsideRoot(this.root, previousPath);
    let temporary = null;
    try {
      temporary = new Database(temporaryPath);
      createSchema(temporary);
      const insertAll = temporary.transaction((snapshots) => {
        for (const snapshot of snapshots) insertTopic(temporary, snapshot);
      });
      insertAll(topics);
      temporary.pragma("optimize");
      temporary.prepare("INSERT INTO search(search) VALUES ('integrity-check')").run();
      temporary.prepare("INSERT INTO topic_search(topic_search) VALUES ('integrity-check')").run();
      const integrity = temporary.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error(`Rebuilt search cache failed integrity check: ${integrity}`);
      temporary.close();
      temporary = null;
      await this.close();
      try {
        await rename(temporaryPath, this.cachePath);
      } catch (error) {
        if (!await pathExists(this.cachePath)) throw error;
        await rename(this.cachePath, previousPath);
        try {
          await rename(temporaryPath, this.cachePath);
          await unlink(previousPath);
        } catch (replacementError) {
          if (await pathExists(previousPath) && !await pathExists(this.cachePath)) {
            await rename(previousPath, this.cachePath);
          }
          throw replacementError;
        }
      }
      this.#status = "unknown";
      this.#statusMessage = null;
      await this.#inspect();
      return this.health();
    } finally {
      if (temporary?.open) temporary.close();
      if (await pathExists(temporaryPath)) await unlink(temporaryPath);
    }
  }

  async replace(snapshot) {
    await this.#inspect();
    const database = this.#requireReady();
    database.transaction((value) => {
      deleteTopic(database, value.topic.id);
      insertTopic(database, value);
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'built_at'").run(new Date().toISOString());
    })(snapshot);
    return this.health();
  }

  async replaceDocument({ topic, path: documentPath, document }) {
    await this.#inspect();
    const database = this.#requireReady();
    database.transaction(() => {
      if (!database.prepare("SELECT 1 FROM topics WHERE topic = ?").get(topic.id)) throw new Error(`Search topic '${topic.id}' is missing.`);
      replaceDocumentRows(database, topic.id, documentPath, document);
      const fileCount = Number(database.prepare("SELECT COUNT(*) FROM records WHERE topic = ? AND kind = 'document'").pluck().get(topic.id));
      const topicRowId = updateTopicMetadataRows(database, topic, fileCount);
      refreshTopicAggregate(database, topic, topicRowId);
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'built_at'").run(new Date().toISOString());
    })();
    return this.health();
  }

  async updateTopic({ topic }) {
    await this.#inspect();
    const database = this.#requireReady();
    database.transaction(() => {
      if (!database.prepare("SELECT 1 FROM topics WHERE topic = ?").get(topic.id)) throw new Error(`Search topic '${topic.id}' is missing.`);
      const fileCount = Number(database.prepare("SELECT COUNT(*) FROM records WHERE topic = ? AND kind = 'document'").pluck().get(topic.id));
      const topicRowId = updateTopicMetadataRows(database, topic, fileCount);
      refreshTopicAggregate(database, topic, topicRowId);
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'built_at'").run(new Date().toISOString());
    })();
    return this.health();
  }

  async remove({ topic }) {
    await this.#inspect();
    const database = this.#requireReady();
    database.transaction(() => {
      deleteTopic(database, topic);
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'built_at'").run(new Date().toISOString());
    })();
    return this.health();
  }

  async listTasks({ topic, pathPrefix = "", status = "open", cursor, limit = 50 } = {}) {
    await this.#inspect();
    const database = this.#requireReady();
    if (!["open", "completed", "all"].includes(status)) throw new TopicalError("Invalid task status.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TopicalError("limit must be between 1 and 100.");
    if (typeof pathPrefix !== "string" || pathPrefix.length > 1000) throw new TopicalError("Invalid task path prefix.");
    const scope = JSON.stringify([topic || null, pathPrefix, status]);
    const offset = decodeFileCursor(cursor, scope);
    const clauses = ["r.kind = 'document'"];
    const values = [];
    if (topic) { clauses.push("r.topic = ?"); values.push(topic); }
    if (pathPrefix) {
      const prefix = pathPrefix.replace(/\/$/, "");
      clauses.push("(r.path = ? OR substr(r.path, 1, ?) = ?)");
      values.push(prefix, prefix.length + 1, prefix + "/");
    }
    const from = "FROM tasks t JOIN records r ON r.id = t.record_id JOIN topics p ON p.topic = r.topic";
    const where = clauses.join(" AND ");
    const counts = database.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(t.completed), 0) AS completed, COUNT(DISTINCT r.topic) AS topics ${from} WHERE ${where}`).get(...values);
    const filtered = where + (status === "all" ? "" : ` AND t.completed = ${status === "completed" ? 1 : 0}`);
    const total = status === "all" ? counts.total : status === "completed" ? counts.completed : counts.total - counts.completed;
    const rows = database.prepare(`SELECT r.topic, p.title AS topicTitle, r.path, r.hash AS sourceHash, t.offset, t.line, t.text, t.heading, t.completed ${from} WHERE ${filtered} ORDER BY r.topic, r.path, t.offset LIMIT ? OFFSET ?`).all(...values, limit, offset);
    return {
      tasks: rows.map((row) => ({ ...row, completed: Boolean(row.completed) })),
      counts: { ...counts, open: counts.total - counts.completed },
      page: { limit, total, nextCursor: offset + rows.length < total ? encodeFileCursor(scope, offset + rows.length) : null },
      freshness: { indexedAt: database.prepare("SELECT value FROM metadata WHERE key = 'built_at'").pluck().get(), externalEdits: "Run reindex after external Markdown edits." }
    };
  }

  #allowedTopics(tags) {
    if (!tags?.length) return null;
    const database = this.#requireReady();
    let allowed = null;
    const select = database.prepare("SELECT topic FROM topic_tags WHERE tag = ?").pluck();
    for (const tag of tags) {
      const matches = new Set(select.all(canonicalTagKey(tag)));
      allowed = allowed === null ? matches : new Set([...allowed].filter((topic) => matches.has(topic)));
    }
    return allowed || new Set();
  }

  #expandedAnalysis(database, analysis) {
    const lookupExact = database.prepare("SELECT term FROM topic_vocab WHERE term = ? LIMIT 1").pluck();
    const lookupPrefix = database.prepare("SELECT term FROM topic_vocab WHERE term >= ? AND term < ? ORDER BY term LIMIT 250").pluck();
    const expansions = [];
    const terms = [];
    for (const term of analysis.terms) {
      if (lookupExact.get(term.normalized)) {
        terms.push({ ...term, source: term.normalized });
        continue;
      }
      const characters = [...term.normalized];
      if (characters.length < 5) return null;
      const prefix = characters.slice(0, 2).join("");
      const candidates = lookupPrefix.all(prefix, `${prefix}\u{10ffff}`)
        .filter((candidate) => Math.abs([...candidate].length - characters.length) <= 1)
        .filter((candidate) => boundedEditDistance(term.normalized, candidate, 1) === 1);
      if (candidates.length !== 1) return null;
      const corrected = candidates[0];
      expansions.push({ from: term.normalized, to: corrected, distance: 1 });
      terms.push({ source: corrected, normalized: corrected });
    }
    if (!expansions.length) return null;
    return { ...analysis, terms, normalized: terms.map((term) => term.normalized).join(" "), expansions };
  }

  async query({ query, analysis, tags = [], limit = 10, matchMode = SEARCH_MATCH_MODE.STRICT }) {
    await this.#inspect();
    const database = this.#requireReady();
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const allowed = this.#allowedTopics(tags);
    let queryAnalysis = analysis || analyzeQuery(query);
    if (matchMode === SEARCH_MATCH_MODE.EXPANDED) {
      queryAnalysis = this.#expandedAnalysis(database, queryAnalysis);
      if (!queryAnalysis) return [];
    }
    const terms = queryAnalysis.terms;
    if (!terms.length) {
      const rows = database.prepare(`
        SELECT topic, title, summary, tags_json, updated_at
        FROM topics
        ORDER BY updated_at DESC, title COLLATE NOCASE, topic
      `).all();
      return rows
        .filter((row) => allowed === null || allowed.has(row.topic))
        .slice(0, boundedLimit)
        .map((row) => ({
          topic: row.topic,
          title: row.title,
          summary: row.summary,
          tags: parseJson(row.tags_json, []),
          score: 0,
          matchedTerms: [],
          matchedFields: [],
          files: []
        }));
    }

    const topicQuery = database.prepare(`
      SELECT DISTINCT records.topic
      FROM topic_search JOIN records ON records.id = topic_search.rowid
      WHERE topic_search MATCH ?
    `).pluck();
    const aliasTopicQuery = database.prepare("SELECT topic FROM topic_alias_terms WHERE term = ?").pluck();
    const candidateQuery = database.prepare(`
      SELECT records.topic, topics.title, topics.summary, topics.tags_json, topics.updated_at,
             bm25(topic_search, 10.0, 7.0, 6.0, 4.0, 5.0, 1.0, 0.5) AS rank
      FROM topic_search
      JOIN records ON records.id = topic_search.rowid
      JOIN topics ON topics.topic = records.topic
      WHERE topic_search MATCH ?
      ORDER BY rank
    `);
    const candidateExpression = terms.map((term) => ftsToken(term.source))
      .join(matchMode === SEARCH_MATCH_MODE.RELAXED ? " OR " : " AND ");
    const candidateRows = candidateQuery.all(candidateExpression)
      .filter((row) => allowed === null || allowed.has(row.topic));
    if (!candidateRows.length) return [];
    const topicSets = terms.map((term) => new Set(topicQuery.all(ftsToken(term.source))));

    const grouped = new Map(candidateRows.map((row) => {
      const matched = terms.filter((_term, index) => topicSets[index].has(row.topic)).map((term) => term.normalized);
      const normalizedTitle = normalizeSearchText(row.title).trim();
      const exactTitle = normalizedTitle === queryAnalysis.normalized.trim();
      const titlePhrase = terms.length > 1 && normalizedTitle.includes(queryAnalysis.normalized.trim());
      return [row.topic, {
        topic: row.topic,
        title: row.title,
        summary: row.summary,
        tags: parseJson(row.tags_json, []),
        updatedAt: row.updated_at,
        score: matched.length * 100
          + (exactTitle ? 5_000 : 0)
          + (titlePhrase && !exactTitle ? 250 : 0)
          + Math.max(0, -Number(row.rank || 0) * 1000),
        exactTitle,
        titlePhrase,
        termCohesion: terms.length <= 1 ? "single_term" : "distributed",
        matchedTerms: new Set(matched),
        aliasMatchedTerms: new Set(),
        matchedFields: new Set(),
        files: new Map()
      }];
    }));

    for (const [termIndex, term] of terms.entries()) {
      const pathMatches = new Set(topicQuery.all(`path:${ftsToken(term.source)}`));
      const headingMatches = new Set(topicQuery.all(`headings:${ftsToken(term.source)}`));
      const aliasMatches = new Set(aliasTopicQuery.all(term.normalized));
      for (const topic of grouped.values()) {
        if (!topicSets[termIndex].has(topic.topic)) continue;
        const metadataFields = [];
        if (normalizeSearchText(topic.title).includes(term.normalized)) metadataFields.push("title");
        if (normalizeSearchText(topic.summary).includes(term.normalized)) metadataFields.push("summary");
        if (topic.tags.some((tag) => normalizeSearchText(tag).includes(term.normalized))) metadataFields.push("tags");
        if (pathMatches.has(topic.topic)) metadataFields.push("path");
        if (headingMatches.has(topic.topic)) metadataFields.push("headings");
        if (aliasMatches.has(topic.topic)) {
          metadataFields.push("aliases");
          topic.aliasMatchedTerms.add(term.normalized);
        }
        if (!metadataFields.length) metadataFields.push("body");
        metadataFields.forEach((field) => topic.matchedFields.add(field));
        topic.score += fieldBoost(metadataFields);
      }
    }

    const finalists = [...grouped.values()]
      .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt) || left.topic.localeCompare(right.topic))
      .slice(0, boundedLimit);
    const fileExpression = terms.map((term) => ftsToken(term.source)).join(" OR ");
    const finalistByTopic = new Map(finalists.map((topic) => [topic.topic, topic]));
    const placeholders = finalists.map(() => "?").join(", ");
    const fileHitQuery = database.prepare(`
      SELECT records.id, records.topic, records.path, records.hash,
             bm25(search, 10.0, 7.0, 6.0, 4.0, 5.0, 1.0, 0.5) AS rank
      FROM search
      JOIN records ON records.id = search.rowid
      WHERE search MATCH ? AND records.topic IN (${placeholders}) AND records.kind = 'document'
      ORDER BY rank
    `);
    const rawFileHits = [];
    const hitCounts = new Map();
    for (const row of fileHitQuery.all(fileExpression, ...finalistByTopic.keys())) {
      const count = (hitCounts.get(row.topic) || 0) + 1;
      hitCounts.set(row.topic, count);
      if (count > MAX_FILE_HITS) continue;
      rawFileHits.push(row);
    }
    const filePlaceholders = rawFileHits.map(() => "?").join(", ");
    const matchingRowIds = rawFileHits.length
      ? database.prepare(`SELECT rowid FROM search WHERE search MATCH ? AND rowid IN (${filePlaceholders})`).pluck()
      : null;
    const hitIds = rawFileHits.map((row) => row.id);
    const fileTermRows = terms.map((term) => new Set(matchingRowIds ? matchingRowIds.all(ftsToken(term.source), ...hitIds) : []));
    for (const row of rawFileHits) {
      const topic = finalistByTopic.get(row.topic);
      const fileMatchedTerms = terms
        .filter((_term, index) => fileTermRows[index].has(row.id))
        .map((term) => term.normalized);
      if (terms.length > 1 && fileMatchedTerms.length === terms.length && topic.termCohesion !== "same_file") {
        topic.termCohesion = "same_file";
        topic.score += 100;
      }
      topic.files.set(row.path, {
        path: row.path,
        hash: row.hash,
        score: fileMatchedTerms.length * 10 + Math.max(0, -Number(row.rank || 0) * 1000),
        matchedTerms: new Set(fileMatchedTerms),
        matchedFields: new Set()
      });
    }

    const contextRecord = database.prepare("SELECT path, hash FROM records WHERE topic = ? AND path = 'context.md'");
    return finalists
      .map((topic) => {
        let files = [...topic.files.values()]
          .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
          .slice(0, MAX_FILE_HITS);
        if (!files.length) {
          const context = contextRecord.get(topic.topic);
          if (context) files = [{ path: context.path, hash: context.hash, score: 0, matchedTerms: new Set(), matchedFields: new Set() }];
        }
        return {
          topic: topic.topic,
          title: topic.title,
          summary: topic.summary,
          tags: topic.tags,
          score: Number(topic.score.toFixed(6)),
          exactTitle: topic.exactTitle,
          titlePhrase: topic.titlePhrase,
          termCohesion: topic.termCohesion,
          queryExpansions: queryAnalysis.expansions || [],
          aliasMatchedTerms: [...topic.aliasMatchedTerms],
          matchedTerms: [...topic.matchedTerms],
          matchedFields: [...topic.matchedFields],
          fileMatchCount: hitCounts.get(topic.topic) || 0,
          files: files.map((file) => ({
            ...file,
            matchedTerms: [...file.matchedTerms],
            matchedFields: [...file.matchedFields]
          })),
          updatedAt: topic.updatedAt
        };
      })
      .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt) || left.topic.localeCompare(right.topic))
      .map(({ updatedAt: _updatedAt, ...topic }) => topic);
  }

  async queryFiles({ query, analysis, topic, matchMode = SEARCH_MATCH_MODE.STRICT, cursor, limit = 50 }) {
    await this.#inspect();
    const database = this.#requireReady();
    let queryAnalysis = analysis || analyzeQuery(query);
    if (matchMode === SEARCH_MATCH_MODE.EXPANDED) {
      queryAnalysis = this.#expandedAnalysis(database, queryAnalysis);
      if (!queryAnalysis) return { files: [], page: { limit: Math.max(1, Math.min(Number(limit) || 50, 100)), total: 0, nextCursor: null } };
    }
    const terms = queryAnalysis.terms;
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const scope = JSON.stringify({ topic, query: queryAnalysis.normalized, matchMode });
    const offset = decodeFileCursor(cursor, scope);
    if (!terms.length) {
      const total = Number(database.prepare("SELECT COUNT(*) FROM records WHERE topic = ? AND kind = 'document'").pluck().get(topic));
      const rows = database.prepare(`
        SELECT id, path, hash
        FROM records
        WHERE topic = ? AND kind = 'document'
        ORDER BY path
        LIMIT ? OFFSET ?
      `).all(topic, boundedLimit, offset);
      return {
        files: rows.map((row) => ({ path: row.path, hash: row.hash, score: 0, matchedTerms: [], matchedFields: [] })),
        page: { limit: boundedLimit, total, nextCursor: offset + rows.length < total ? encodeFileCursor(scope, offset + rows.length) : null }
      };
    }
    const expression = terms.map((term) => ftsToken(term.source)).join(" OR ");
    const total = Number(database.prepare(`
      SELECT COUNT(*)
      FROM search JOIN records ON records.id = search.rowid
      WHERE search MATCH ? AND records.topic = ? AND records.kind = 'document'
    `).pluck().get(expression, topic));
    const rows = database.prepare(`
      SELECT records.id, records.path, records.hash,
             bm25(search, 10.0, 7.0, 6.0, 4.0, 5.0, 1.0, 0.5) AS rank
      FROM search JOIN records ON records.id = search.rowid
      WHERE search MATCH ? AND records.topic = ? AND records.kind = 'document'
      ORDER BY rank, records.path
      LIMIT ? OFFSET ?
    `).all(expression, topic, boundedLimit, offset);
    const rowIds = rows.map((row) => row.id);
    const placeholders = rowIds.map(() => "?").join(", ");
    const matching = rowIds.length
      ? database.prepare(`SELECT rowid FROM search WHERE search MATCH ? AND rowid IN (${placeholders})`).pluck()
      : null;
    const termRows = terms.map((term) => new Set(matching ? matching.all(ftsToken(term.source), ...rowIds) : []));
    return {
      files: rows.map((row) => ({
        path: row.path,
        hash: row.hash,
        score: Number(Math.max(0, -Number(row.rank || 0) * 1000).toFixed(6)),
        matchedTerms: terms.filter((_term, index) => termRows[index].has(row.id)).map((term) => term.normalized),
        matchedFields: []
      })),
      page: {
        limit: boundedLimit,
        total,
        nextCursor: offset + rows.length < total ? encodeFileCursor(scope, offset + rows.length) : null
      }
    };
  }

  async health() {
    await this.#inspect();
    let cacheBytes = 0;
    if (await pathExists(this.cachePath)) cacheBytes = (await stat(this.cachePath)).size;
    if (this.#status !== "ready" || !this.#database) {
      return {
        status: this.#status,
        schemaVersion: SEARCH_SCHEMA_VERSION,
        cacheBytes,
        message: this.#statusMessage
      };
    }
    return {
      status: "ready",
      schemaVersion: SEARCH_SCHEMA_VERSION,
      sqliteVersion: this.#database.prepare("SELECT sqlite_version()").pluck().get(),
      fts5: true,
      topics: this.#database.prepare("SELECT count(*) FROM topics").pluck().get(),
      documents: this.#database.prepare("SELECT count(*) FROM records WHERE kind = 'document'").pluck().get(),
      cacheBytes,
      builtAt: this.#database.prepare("SELECT value FROM metadata WHERE key = 'built_at'").pluck().get()
    };
  }

  async close() {
    if (this.#database?.open) this.#database.close();
    this.#database = null;
    this.#status = "closed";
    this.#statusMessage = "Search cache is closed.";
  }
}
