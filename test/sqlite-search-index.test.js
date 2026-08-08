import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { queryWithRelaxedFallback, SEARCH_MATCH_MODE } from "../src/search-index.js";
import { SEARCH_SCHEMA_VERSION, SqliteSearchIndex } from "../src/sqlite-search-index.js";
import { RELAXED_RELEVANCE_CASE, RELEVANCE_DOCUMENTS, STRICT_RELEVANCE_CASES } from "./fixtures/relevance.js";

function snapshotFromFixtures() {
  const topics = new Map();
  for (const document of RELEVANCE_DOCUMENTS) {
    const snapshot = topics.get(document.topic) || {
      topic: {
        id: document.topic,
        title: document.title,
        summary: document.summary,
        tags: document.tags,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
        lastAction: null
      },
      documents: []
    };
    snapshot.documents.push({
      path: document.path,
      headings: document.headings,
      excerpt: document.body.slice(0, 360),
      body: document.body,
      hash: "0".repeat(64),
      size: Buffer.byteLength(document.body)
    });
    topics.set(document.topic, snapshot);
  }
  return { topics: [...topics.values()] };
}

test("SQLite FTS5 cache capability-tests, rebuilds, and reports health", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-sqlite-index-"));
  const index = new SqliteSearchIndex(root);
  t.after(() => index.close());

  const missing = await index.health();
  assert.equal(missing.status, "missing");
  const rebuilt = await index.rebuild(snapshotFromFixtures());
  assert.deepEqual(
    { status: rebuilt.status, schemaVersion: rebuilt.schemaVersion, fts5: rebuilt.fts5 },
    { status: "ready", schemaVersion: SEARCH_SCHEMA_VERSION, fts5: true }
  );
  assert.equal(rebuilt.topics, 4);
  assert.equal(rebuilt.documents, RELEVANCE_DOCUMENTS.length);
  assert.ok(rebuilt.cacheBytes > 0);
});

test("SQLite FTS5 passes English/French grouped strict and explicit relaxed relevance gates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-sqlite-relevance-"));
  const index = new SqliteSearchIndex(root);
  t.after(() => index.close());
  await index.rebuild(snapshotFromFixtures());

  for (const relevanceCase of STRICT_RELEVANCE_CASES) {
    const result = await queryWithRelaxedFallback(index, { query: relevanceCase.query, limit: 10 });
    assert.equal(result.matchMode, SEARCH_MATCH_MODE.STRICT, relevanceCase.query);
    assert.equal(result.topics[0]?.topic, relevanceCase.first, relevanceCase.query);
    assert.deepEqual(new Set(result.topics.map((topic) => topic.topic)), new Set(relevanceCase.topics), relevanceCase.query);
  }

  const relaxed = await queryWithRelaxedFallback(index, { query: RELAXED_RELEVANCE_CASE.query, limit: 10 });
  assert.equal(relaxed.matchMode, SEARCH_MATCH_MODE.RELAXED);
  assert.deepEqual(new Set(relaxed.topics.map((topic) => topic.topic)), new Set(RELAXED_RELEVANCE_CASE.topics));
});

test("SQLite FTS5 reads do not change the cache database", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-sqlite-readonly-"));
  const index = new SqliteSearchIndex(root);
  t.after(() => index.close());
  await index.rebuild(snapshotFromFixtures());
  const cachePath = path.join(root, ".topical-cache", "search.sqlite");
  const before = { content: await readFile(cachePath), modified: (await stat(cachePath)).mtimeMs };

  await queryWithRelaxedFallback(index, { query: "publication architecture", limit: 10 });
  await index.health();

  const after = { content: await readFile(cachePath), modified: (await stat(cachePath)).mtimeMs };
  assert.equal(Buffer.compare(after.content, before.content), 0);
  assert.equal(after.modified, before.modified);
});
