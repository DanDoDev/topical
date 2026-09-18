import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SqliteSearchIndex } from "../src/sqlite-search-index.js";
import { extractTasks } from "../src/tasks.js";

const results = [];
for (const size of [100, 1000, 10000]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-task-benchmark-"));
  const index = new SqliteSearchIndex(root);
  const timestamp = "2026-01-01T00:00:00.000Z";
  try {
    const snapshots = [];
    let start = performance.now();
    for (let i = 0; i < size; i++) {
      const topicNumber = Math.floor(i / 100);
      const id = `generated-${String(topicNumber).padStart(4, "0")}`;
      const body = `# Generated issue ${i}\n\n- [ ] Check fixture ${i}\n- [x] Captured evidence\n`;
      snapshots[topicNumber] ||= { topic: { id, title: id, updatedAt: timestamp, tags: [] }, documents: [] };
      snapshots[topicNumber].documents.push({ path: `issues/${i}/context.md`, body, hash: createHash("sha256").update(body).digest("hex"), updatedAt: timestamp, size: body.length, tasks: extractTasks(body) });
    }
    const extractionMs = performance.now() - start;
    start = performance.now();
    await index.rebuild({ topics: snapshots });
    const rebuildMs = performance.now() - start;
    const timings = [];
    for (let n = 0; n < 20; n++) {
      start = performance.now();
      const result = await index.listTasks({ limit: 50 });
      timings.push(performance.now() - start);
      assert.equal(result.counts.open, size);
      assert.equal(result.tasks.length, 50);
    }
    const snapshot = snapshots[0];
    const document = { ...snapshot.documents[0], tasks: [] };
    start = performance.now();
    await index.replaceDocument({ topic: snapshot.topic, path: document.path, document });
    const mutationMs = performance.now() - start;
    assert.equal((await index.listTasks()).counts.open, size - 1);
    timings.sort((a, b) => a - b);
    results.push({ files: size, extractionMs, rebuildMs, mutationMs, queryP95Ms: timings[18], cacheBytes: (await stat(index.cachePath)).size });
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ fixture: "generated-tasks-v1", runtime: process.version, results }, null, 2));
