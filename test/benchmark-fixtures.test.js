import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TopicalStore } from "../src/store.js";
import { auditLegacyIndexes } from "../benchmark/legacy-index-audit.js";
import { BENCHMARK_DOCUMENT_COUNTS, generateBenchmarkFixture, materializeBenchmarkFixture } from "./fixtures/generated-corpus.js";

test("generated benchmark fixtures contain exactly 100, 1,000, and 10,000 documents", () => {
  for (const documentCount of BENCHMARK_DOCUMENT_COUNTS) {
    const fixture = generateBenchmarkFixture(documentCount);
    assert.equal(fixture.topics.flatMap((topic) => topic.files).length, documentCount);
    assert.equal(fixture.topicCount, Math.ceil(documentCount / 100));
    assert.ok(fixture.topics.every((topic) => topic.files[0].path === "context.md"));
    assert.ok(fixture.topics.every((topic) => topic.files[0].content.includes("tags: []")));
  }
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
