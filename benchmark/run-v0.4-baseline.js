import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import { TopicalStore } from "../src/store.js";
import { BENCHMARK_DOCUMENT_COUNTS, generateBenchmarkFixture, materializeBenchmarkFixture } from "../test/fixtures/generated-corpus.js";
import { auditLegacyIndexes } from "./legacy-index-audit.js";

function elapsed(start) {
  return Number((performance.now() - start).toFixed(3));
}

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))];
  return {
    medianMs: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3))
  };
}

async function benchmark(documentCount) {
  const root = await mkdtemp(path.join(os.tmpdir(), `topical-v04-${documentCount}-`));
  let store;
  try {
    await materializeBenchmarkFixture(root, generateBenchmarkFixture(documentCount));
    store = new TopicalStore(root);
    let start = performance.now();
    await store.initialize();
    const coldRebuildMs = elapsed(start);
    const index = await auditLegacyIndexes(root);
    await store.close();
    store = new TopicalStore(root);
    start = performance.now();
    await store.initialize();
    const warmStartupMs = elapsed(start);

    const mutationTarget = { topic: "benchmark-topic-001", filePath: "notes/document-001.md" };
    const before = await store.readTopicFile(mutationTarget);
    start = performance.now();
    await store.updateTopicFile({
      ...mutationTarget,
      mode: "replace",
      content: `${before.content.trim()}\n\nMutation benchmark marker.\n`,
      expectedHash: before.hash,
      description: "Recorded the v0.4 SQLite mutation benchmark."
    });
    const mutationMs = elapsed(start);

    const queries = ["backup recovery", "publication architecture", "recuperation continuite"];
    const querySamples = [];
    for (let round = 0; round < 7; round += 1) {
      for (const query of queries) {
        start = performance.now();
        await store.searchTopics({ query, limit: 10 });
        querySamples.push(elapsed(start));
      }
    }
    return { documentCount, coldRebuildMs, warmStartupMs, mutationMs, query: distribution(querySamples), index };
  } finally {
    await store?.close();
    if (root.startsWith(`${os.tmpdir()}${path.sep}topical-v04-`)) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

const requested = process.argv.find((argument) => argument.startsWith("--sizes="));
const sizes = requested
  ? requested.slice("--sizes=".length).split(",").map(Number)
  : [...BENCHMARK_DOCUMENT_COUNTS];
if (!sizes.length || sizes.some((size) => !BENCHMARK_DOCUMENT_COUNTS.includes(size))) {
  throw new RangeError(`--sizes must contain only ${BENCHMARK_DOCUMENT_COUNTS.join(", ")}.`);
}

const results = [];
for (const size of sizes) results.push(await benchmark(size));
process.stdout.write(`${JSON.stringify({
  recordedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  implementation: "v0.4 SQLite FTS5 derived search cache",
  results
}, null, 2)}\n`);
