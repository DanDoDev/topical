import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { SearchIndex, SEARCH_MATCH_MODE } from "./search-index.js";

export const SEARCH_SCHEMA_VERSION = 2;
const CACHE_DIRECTORY = ".topical-cache";
const CACHE_FILENAME = "search.sqlite";
const MAX_QUERY_TERMS = 20;

function normalize(value) {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function normalizeTag(value) {
  return normalize(value).trim();
}

function queryTerms(value) {
  const source = String(value).normalize("NFKC");
  const tokens = source.match(/[\p{L}\p{N}]+/gu) || [];
  const seen = new Set();
  const results = [];
  for (const token of tokens) {
    const normalized = normalize(token);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    results.push({ source: token, normalized });
    if (results.length >= MAX_QUERY_TERMS) break;
  }
  return results;
}

function ftsToken(token) {
  return `"${String(token).replaceAll('"', '""')}"`;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
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

    CREATE TABLE records (
      id INTEGER PRIMARY KEY,
      record_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('topic', 'document')),
      topic TEXT NOT NULL REFERENCES topics(topic) ON DELETE CASCADE,
      path TEXT,
      headings_json TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      hash TEXT,
      size INTEGER
    ) STRICT;

    CREATE INDEX records_topic_path ON records(topic, path);

    CREATE VIRTUAL TABLE search USING fts5(
      title,
      summary,
      tags,
      path,
      headings,
      body,
      content='',
      contentless_delete=1,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE topic_search USING fts5(
      title,
      summary,
      tags,
      path,
      headings,
      body,
      content='',
      contentless_delete=1,
      detail=column,
      tokenize='unicode61 remove_diacritics 2'
    );
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
    insertTag.run(topic.id, normalizeTag(displayTag), String(displayTag));
  }

  const insertRecord = database.prepare(`
    INSERT INTO records(record_key, kind, topic, path, headings_json, excerpt, hash, size)
    VALUES (@recordKey, @kind, @topic, @path, @headingsJson, @excerpt, @hash, @size)
  `);
  const insertSearch = database.prepare(`
    INSERT INTO search(rowid, title, summary, tags, path, headings, body)
    VALUES (@rowid, @title, @summary, @tags, @path, @headings, @body)
  `);
  const insertTopicSearch = database.prepare(`
    INSERT INTO topic_search(rowid, title, summary, tags, path, headings, body)
    VALUES (@rowid, @title, @summary, @tags, @path, @headings, @body)
  `);

  const topicRecord = insertRecord.run({
    recordKey: `topic:${topic.id}`,
    kind: "topic",
    topic: topic.id,
    path: null,
    headingsJson: "[]",
    excerpt: "",
    hash: null,
    size: null
  });
  insertSearch.run({
    rowid: topicRecord.lastInsertRowid,
    title: topic.title || topic.id,
    summary: topic.summary || "",
    tags: (topic.tags || []).join(" "),
    path: "",
    headings: "",
    body: ""
  });

  const aggregatePaths = [];
  const aggregateHeadings = [];
  const aggregateBodies = [];
  for (const document of snapshot.documents) {
    aggregatePaths.push(document.path);
    aggregateHeadings.push(...(document.headings || []));
    aggregateBodies.push(document.body || "");
    const record = insertRecord.run({
      recordKey: `document:${topic.id}:${document.path}`,
      kind: "document",
      topic: topic.id,
      path: document.path,
      headingsJson: JSON.stringify(document.headings || []),
      excerpt: document.excerpt || "",
      hash: document.hash || null,
      size: document.size ?? null
    });
    insertSearch.run({
      rowid: record.lastInsertRowid,
      title: "",
      summary: "",
      tags: "",
      path: document.path,
      headings: (document.headings || []).join("\n"),
      body: document.body || ""
    });
  }
  insertTopicSearch.run({
    rowid: topicRecord.lastInsertRowid,
    title: topic.title || topic.id,
    summary: topic.summary || "",
    tags: (topic.tags || []).join(" "),
    path: aggregatePaths.join("\n"),
    headings: aggregateHeadings.join("\n"),
    body: aggregateBodies.join("\n")
  });
}

function fieldBoost(fields) {
  const weights = { title: 30, summary: 20, tags: 15, headings: 12, path: 8, body: 3 };
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

  async remove({ topic }) {
    await this.#inspect();
    const database = this.#requireReady();
    database.transaction(() => {
      deleteTopic(database, topic);
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'built_at'").run(new Date().toISOString());
    })();
    return this.health();
  }

  #allowedTopics(tags) {
    if (!tags?.length) return null;
    const database = this.#requireReady();
    let allowed = null;
    const select = database.prepare("SELECT topic FROM topic_tags WHERE tag = ?").pluck();
    for (const tag of tags) {
      const matches = new Set(select.all(normalizeTag(tag)));
      allowed = allowed === null ? matches : new Set([...allowed].filter((topic) => matches.has(topic)));
    }
    return allowed || new Set();
  }

  async query({ query, tags = [], limit = 10, matchMode = SEARCH_MATCH_MODE.STRICT }) {
    await this.#inspect();
    const database = this.#requireReady();
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const allowed = this.#allowedTopics(tags);
    const terms = queryTerms(query);
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
    const documentTopicQuery = database.prepare(`
      SELECT DISTINCT records.topic
      FROM search JOIN records ON records.id = search.rowid
      WHERE search MATCH ?
    `).pluck();
    const candidateQuery = database.prepare(`
      SELECT records.topic, topics.title, topics.summary, topics.tags_json, topics.updated_at,
             bm25(topic_search, 10.0, 7.0, 6.0, 4.0, 5.0, 1.0) AS rank
      FROM topic_search
      JOIN records ON records.id = topic_search.rowid
      JOIN topics ON topics.topic = records.topic
      WHERE topic_search MATCH ?
      ORDER BY rank
    `);
    const candidateExpression = terms.map((term) => ftsToken(term.source))
      .join(matchMode === SEARCH_MATCH_MODE.STRICT ? " AND " : " OR ");
    const candidateRows = candidateQuery.all(candidateExpression)
      .filter((row) => allowed === null || allowed.has(row.topic));
    if (!candidateRows.length) return [];
    const topicSets = terms.map((term) => new Set(topicQuery.all(ftsToken(term.source))));

    const phraseTopics = new Set();
    if (terms.length > 1) {
      const phrase = `"${terms.map((term) => term.source.replaceAll('"', '""')).join(" ")}"`;
      for (const topic of documentTopicQuery.all(phrase)) phraseTopics.add(topic);
    }

    const grouped = new Map(candidateRows.map((row) => {
      const matched = terms.filter((_term, index) => topicSets[index].has(row.topic)).map((term) => term.normalized);
      return [row.topic, {
        topic: row.topic,
        title: row.title,
        summary: row.summary,
        tags: parseJson(row.tags_json, []),
        updatedAt: row.updated_at,
        score: matched.length * 100 + (phraseTopics.has(row.topic) ? 50 : 0) + Math.max(0, -Number(row.rank || 0) * 1000),
        matchedTerms: new Set(matched),
        matchedFields: new Set(),
        files: new Map()
      }];
    }));

    for (const [termIndex, term] of terms.entries()) {
      const pathMatches = new Set(topicQuery.all(`path:${ftsToken(term.source)}`));
      const headingMatches = new Set(topicQuery.all(`headings:${ftsToken(term.source)}`));
      for (const topic of grouped.values()) {
        if (!topicSets[termIndex].has(topic.topic)) continue;
        const metadataFields = [];
        if (normalize(topic.title).includes(term.normalized)) metadataFields.push("title");
        if (normalize(topic.summary).includes(term.normalized)) metadataFields.push("summary");
        if (topic.tags.some((tag) => normalize(tag).includes(term.normalized))) metadataFields.push("tags");
        if (pathMatches.has(topic.topic)) metadataFields.push("path");
        if (headingMatches.has(topic.topic)) metadataFields.push("headings");
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
      SELECT records.topic, records.path, records.hash,
             bm25(search, 10.0, 7.0, 6.0, 4.0, 5.0, 1.0) AS rank
      FROM search
      JOIN records ON records.id = search.rowid
      WHERE search MATCH ? AND records.topic IN (${placeholders}) AND records.kind = 'document'
      ORDER BY rank
    `);
    for (const row of fileHitQuery.all(fileExpression, ...finalistByTopic.keys())) {
      const topic = finalistByTopic.get(row.topic);
      if (topic.files.size >= 3) continue;
      topic.files.set(row.path, {
        path: row.path,
        hash: row.hash,
        score: 10 + Math.max(0, -Number(row.rank || 0) * 1000),
        matchedTerms: new Set(topic.matchedTerms),
        matchedFields: new Set()
      });
    }

    const contextRecord = database.prepare("SELECT path, hash FROM records WHERE topic = ? AND path = 'context.md'");
    return finalists
      .map((topic) => {
        let files = [...topic.files.values()]
          .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
          .slice(0, 3);
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
          matchedTerms: [...topic.matchedTerms],
          matchedFields: [...topic.matchedFields],
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
