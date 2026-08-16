import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TopicalStore } from "../src/store.js";
import { auditLegacyIndexes } from "../benchmark/legacy-index-audit.js";
import {
  BENCHMARK_DOCUMENT_COUNTS,
  BENCHMARK_FIXTURE_ID,
  BENCHMARK_TOPIC_STRESS,
  generateBenchmarkFixture,
  materializeBenchmarkFixture
} from "./fixtures/generated-corpus.js";

test("generated benchmark fixtures contain exactly 100, 1,000, and 10,000 documents", () => {
  assert.equal(BENCHMARK_FIXTURE_ID, "generated-corpus-v1");
  for (const documentCount of BENCHMARK_DOCUMENT_COUNTS) {
    const fixture = generateBenchmarkFixture(documentCount);
    assert.equal(fixture.topics.flatMap((topic) => topic.files).length, documentCount);
    assert.equal(fixture.topicCount, Math.ceil(documentCount / 100));
    assert.equal(fixture.documentsPerTopic, 100);
    assert.ok(fixture.topics.every((topic) => topic.files[0].path === "context.md"));
    assert.ok(fixture.topics.every((topic) => topic.files[0].content.includes("tags: []")));
  }
});

test("the optional topic-count stress fixture keeps document count fixed", () => {
  const fixture = generateBenchmarkFixture(BENCHMARK_TOPIC_STRESS.documentCount, {
    documentsPerTopic: BENCHMARK_TOPIC_STRESS.documentsPerTopic
  });
  assert.equal(fixture.documentCount, BENCHMARK_TOPIC_STRESS.documentCount);
  assert.equal(fixture.topicCount, BENCHMARK_TOPIC_STRESS.topicCount);
  assert.equal(fixture.topics.length, BENCHMARK_TOPIC_STRESS.topicCount);
  assert.ok(fixture.topics.every((topic) => topic.files.length === 1));
});

test("the index audit captures the simplified catalogues and SQLite cache without writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-audit-test-"));
  await materializeBenchmarkFixture(root, generateBenchmarkFixture(100));
  const store = new TopicalStore(root);
  await store.initialize();
  await store.reindex();
  const rootIndexPath = path.join(root, "index.json");
  const before = await readFile(rootIndexPath, "utf8");
  const audit = await auditLegacyIndexes(root);
  const after = await readFile(rootIndexPath, "utf8");

  assert.equal(audit.rootDocuments, 100);
  assert.equal(audit.topicDocuments, 100);
  assert.equal(audit.rootTermEntries, 0);
  assert.equal(audit.topicTermEntries, 0);
  assert.equal(audit.duplicatedTermCopiesAcrossIndexes, 0);
  assert.ok(audit.indexBytes.searchCache > 0);
  assert.equal(audit.tags.assignments, 0);
  assert.equal(after, before, "auditing derived indexes must be read-only");
});
