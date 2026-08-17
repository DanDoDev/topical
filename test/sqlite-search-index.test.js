import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { queryWithRelaxedFallback, SEARCH_MATCH_MODE } from "../src/search-index.js";
import { SEARCH_SCHEMA_VERSION, SqliteSearchIndex } from "../src/sqlite-search-index.js";
import {
  RELAXED_RELEVANCE_CASE,
  RELEVANCE_DOCUMENTS,
  RELEVANCE_EVALUATION_CASES,
  STRICT_RELEVANCE_CASES
} from "./fixtures/relevance.js";
import { evaluateRelevance } from "./support/relevance-evaluator.js";
import { relevanceSnapshot } from "./support/relevance-snapshot.js";

test("SQLite FTS5 cache capability-tests, rebuilds, and reports health", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-sqlite-index-"));
  const index = new SqliteSearchIndex(root);
  t.after(() => index.close());

  const missing = await index.health();
  assert.equal(missing.status, "missing");
  const rebuilt = await index.rebuild(relevanceSnapshot());
  assert.deepEqual(
    { status: rebuilt.status, schemaVersion: rebuilt.schemaVersion, fts5: rebuilt.fts5 },
    { status: "ready", schemaVersion: SEARCH_SCHEMA_VERSION, fts5: true }
  );
  assert.equal(rebuilt.topics, new Set(RELEVANCE_DOCUMENTS.map((document) => document.topic)).size);
  assert.equal(rebuilt.documents, RELEVANCE_DOCUMENTS.length);
  assert.ok(rebuilt.cacheBytes > 0);
});

test("SQLite FTS5 passes English/French grouped strict and explicit relaxed relevance gates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-sqlite-relevance-"));
  const index = new SqliteSearchIndex(root);
  t.after(() => index.close());
  await index.rebuild(relevanceSnapshot());

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

test("SQLite FTS5 reports deterministic pre-upgrade relevance metrics and known misses", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-sqlite-evaluation-"));
  const index = new SqliteSearchIndex(root);
  t.after(() => index.close());
  await index.rebuild(relevanceSnapshot());

  const evaluation = await evaluateRelevance(
    (query) => queryWithRelaxedFallback(index, { query, limit: 10 }),
    RELEVANCE_EVALUATION_CASES
  );

  for (const outcome of evaluation.outcomes) {
    assert.equal(outcome.actualMode, outcome.expectedMode, outcome.id);
    assert.equal(outcome.actualFirst, outcome.expectedFirst, outcome.id);
    assert.equal(outcome.forbiddenReturned.length, 0, outcome.id);
    const fixture = RELEVANCE_EVALUATION_CASES.find((entry) => entry.id === outcome.id);
    for (const field of fixture.expectedFirstFields || []) {
      assert.ok(outcome.firstFields.includes(field), `${outcome.id}: missing ${field}`);
    }
  }

  assert.deepEqual(evaluation.metrics, {
    cases: RELEVANCE_EVALUATION_CASES.length,
    positiveCases: 18,
    negativeCases: 2,
    firstResultAccuracy: 1,
    negativeAccuracy: 1,
    meanReciprocalRank: 1,
    recallAt3: 1,
    strictHitRate: 0.8,
    fallbackRate: 0.15,
    expandedHitRate: 0.05,
    falsePositiveRate: 0
  });
});

test("SQLite FTS5 exposes conservative edit expansions only after exact passes are empty", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-sqlite-expansion-"));
  const index = new SqliteSearchIndex(root);
  t.after(() => index.close());
  await index.rebuild(relevanceSnapshot());

  const expanded = await queryWithRelaxedFallback(index, { query: "projet validation", limit: 10 });
  assert.equal(expanded.matchMode, SEARCH_MATCH_MODE.EXPANDED);
  assert.deepEqual(expanded.expansions, [
    { from: "projet", to: "projets", distance: 1 },
    { from: "validation", to: "validations", distance: 1 }
  ]);
  assert.equal(expanded.topics[0].topic, "morphology-reference");

  const exact = await queryWithRelaxedFallback(index, { query: "projets validations", limit: 10 });
  assert.equal(exact.matchMode, SEARCH_MATCH_MODE.STRICT);
  assert.equal(exact.expansions, undefined);
});

test("SQLite FTS5 explains exact titles and same-file versus distributed term evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-sqlite-explanations-"));
  const index = new SqliteSearchIndex(root);
  t.after(() => index.close());
  await index.rebuild(relevanceSnapshot());

  const title = await queryWithRelaxedFallback(index, { query: "Solar Archive Blueprint", limit: 10 });
  assert.equal(title.topics[0].topic, "solar-archive-blueprint");
  assert.equal(title.topics[0].exactTitle, true);

  const evidence = await queryWithRelaxedFallback(index, { query: "amber falcon", limit: 10 });
  assert.equal(evidence.topics[0].termCohesion, "same_file");
  const distributed = evidence.topics.find((topic) => topic.topic === "distributed-evidence");
  assert.equal(distributed.termCohesion, "distributed");
  assert.deepEqual(distributed.files.map((file) => file.matchedTerms.sort()).sort(), [["amber"], ["falcon"]]);
});

test("SQLite FTS5 reads do not change the cache database", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-sqlite-readonly-"));
  const index = new SqliteSearchIndex(root);
  t.after(() => index.close());
  await index.rebuild(relevanceSnapshot());
  const cachePath = path.join(root, ".topical-cache", "search.sqlite");
  const before = { content: await readFile(cachePath), modified: (await stat(cachePath)).mtimeMs };

  await queryWithRelaxedFallback(index, { query: "publication architecture", limit: 10 });
  await index.health();

  const after = { content: await readFile(cachePath), modified: (await stat(cachePath)).mtimeMs };
  assert.equal(Buffer.compare(after.content, before.content), 0);
  assert.equal(after.modified, before.modified);
});
