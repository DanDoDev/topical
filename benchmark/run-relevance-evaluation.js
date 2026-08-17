import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import { queryWithRelaxedFallback } from "../src/search-index.js";
import { SqliteSearchIndex } from "../src/sqlite-search-index.js";
import {
  RELEVANCE_EVALUATION_CASES,
  RELEVANCE_FIXTURE_ID
} from "../test/fixtures/relevance.js";
import { evaluateRelevance } from "../test/support/relevance-evaluator.js";
import { relevanceSnapshot } from "../test/support/relevance-snapshot.js";

function distribution(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    medianMs: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3))
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "topical-relevance-"));
const index = new SqliteSearchIndex(root);
try {
  await index.rebuild(relevanceSnapshot());
  const samples = [];
  const evaluation = await evaluateRelevance(async (query) => {
    const started = performance.now();
    const result = await queryWithRelaxedFallback(index, { query, limit: 10 });
    samples.push(performance.now() - started);
    return result;
  }, RELEVANCE_EVALUATION_CASES);
  const health = await index.health();

  process.stdout.write(`${JSON.stringify({
    recordedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    fixture: {
      id: RELEVANCE_FIXTURE_ID,
      topics: health.topics,
      documents: health.documents,
      cases: RELEVANCE_EVALUATION_CASES.length
    },
    search: {
      sqliteVersion: health.sqliteVersion,
      fts5: health.fts5,
      schemaVersion: health.schemaVersion,
      cacheBytes: health.cacheBytes
    },
    latency: distribution(samples),
    metrics: evaluation.metrics
  }, null, 2)}\n`);
} finally {
  await index.close();
  if (root.startsWith(`${os.tmpdir()}${path.sep}topical-relevance-`)) {
    await rm(root, { recursive: true, force: true });
  }
}
