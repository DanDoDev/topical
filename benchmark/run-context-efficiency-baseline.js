import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { HistoryStore } from "../src/history-store.js";

const ALLOWED_SIZES = [100, 1_000, 10_000];

function elapsed(start) {
  return Number((performance.now() - start).toFixed(3));
}

function generatedEvents(count) {
  return Array.from({ length: count }, (_, index) => ({
    at: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
    action: index === 0 ? "create_topic" : "update_file",
    path: index === 0 ? "context.md" : `notes/generated-${String(index).padStart(5, "0")}.md`,
    description: `Generated audit event ${index}.`
  }));
}

async function benchmark(size) {
  const root = await mkdtemp(path.join(os.tmpdir(), `topical-history-benchmark-${size}-`));
  const history = new HistoryStore(root);
  try {
    await history.initialize();
    let start = performance.now();
    await history.importLegacy("generated-history", generatedEvents(size));
    const migrationMs = elapsed(start);

    start = performance.now();
    const first = await history.list({ topic: "generated-history", limit: 50 });
    const firstPageMs = elapsed(start);
    let traversed = first.events.length;
    let pages = 1;
    let cursor = first.page.nextCursor;
    start = performance.now();
    while (cursor) {
      const page = await history.list({ topic: "generated-history", limit: 100, cursor });
      traversed += page.events.length;
      pages += 1;
      cursor = page.page.nextCursor;
    }
    const remainingTraversalMs = elapsed(start);
    const health = await history.health();
    return { size, migrationMs, firstPageMs, remainingTraversalMs, pages, traversed, lookupBytes: health.lookupBytes };
  } finally {
    await history.close();
    await rm(root, { recursive: true, force: true });
  }
}

const requested = process.argv.find((argument) => argument.startsWith("--sizes="));
const sizes = requested ? requested.slice("--sizes=".length).split(",").map(Number) : ALLOWED_SIZES;
if (!sizes.length || sizes.some((size) => !ALLOWED_SIZES.includes(size))) throw new RangeError(`--sizes must contain only ${ALLOWED_SIZES.join(", ")}.`);

const results = [];
for (const size of sizes) results.push(await benchmark(size));
process.stdout.write(`${JSON.stringify({
  recordedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  fixture: "generated-history-v1",
  results
}, null, 2)}\n`);
