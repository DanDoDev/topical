import assert from "node:assert/strict";
import { mkdtemp, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HistoryStore } from "../src/history-store.js";

test("durable history pages past event 100 with a stable high-water cursor", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-history-test-"));
  const history = new HistoryStore(root);
  await history.initialize();
  t.after(() => history.close());

  for (let index = 0; index < 130; index += 1) {
    await history.append({
      topic: index % 2 ? "alpha" : "beta",
      at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      action: index % 3 ? "update_file" : "create_file",
      path: `notes/${index}.md`,
      description: `Recorded generated event ${index}.`
    });
  }

  const first = await history.list({ limit: 50 });
  assert.equal(first.events.length, 50);
  assert.equal(first.page.total, 130);
  assert.ok(first.page.nextCursor);

  const appended = await history.append({ topic: "alpha", action: "update_file", path: "late.md", description: "Appended after paging began." });
  const seen = [...first.events];
  let cursor = first.page.nextCursor;
  while (cursor) {
    const next = await history.list({ cursor, limit: 50 });
    seen.push(...next.events);
    cursor = next.page.nextCursor;
  }
  assert.equal(seen.length, 130);
  assert.ok(!seen.some((event) => event.id === appended.id), "new events must not shift an in-progress traversal");
  assert.deepEqual(seen.map((event) => event.sequence), [...seen.map((event) => event.sequence)].sort((left, right) => right - left));

  const filtered = await history.list({ topic: "alpha", action: "update_file", pathQuery: "notes/", limit: 100 });
  assert.ok(filtered.events.length > 0);
  assert.ok(filtered.events.every((event) => event.topic === "alpha" && event.action === "update_file" && event.path.startsWith("notes/")));
  await assert.rejects(() => history.list({ topic: "beta", cursor: first.page.nextCursor }), /cursor is invalid or incompatible/);

  const shards = await readdir(path.join(root, ".topical-history", "events"));
  assert.ok(shards.length >= 2, "durable events should be split into bounded shards");
});

test("the SQLite history lookup rebuilds from durable events and legacy imports are idempotent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-history-rebuild-test-"));
  const history = new HistoryStore(root);
  await history.initialize();
  const legacy = [
    { at: "2026-01-01T00:00:00.000Z", action: "create_topic", path: "context.md", description: "Created legacy topic." },
    { at: "2026-01-02T00:00:00.000Z", action: "update_file", path: "context.md", description: "Updated legacy topic." }
  ];
  assert.deepEqual(await history.importLegacy("legacy-topic", legacy), { imported: 2 });
  assert.deepEqual(await history.importLegacy("legacy-topic", legacy), { imported: 0 });
  await history.close();

  await unlink(path.join(root, ".topical-history", "history.sqlite"));
  const rebuilt = new HistoryStore(root);
  t.after(() => rebuilt.close());
  await rebuilt.initialize();
  const page = await rebuilt.list({ topic: "legacy-topic", limit: 10 });
  const health = await rebuilt.health();
  assert.equal(page.events.length, 2);
  assert.equal(page.events[0].description, "Updated legacy topic.");
  assert.equal(health.eventCount, 2);
  assert.equal(health.indexedEvents, 2);
  assert.equal(health.pendingEvents, 0);
});

test("startup recovers an event left in the pending journal before a crash", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-history-pending-test-"));
  const initial = new HistoryStore(root);
  await initial.initialize();
  await initial.close();
  const event = { sequence: 1, id: "pending-fixture", topic: "recovered-topic", at: "2026-01-01T00:00:00.000Z", action: "update_file", path: "notes.md", description: "Recovered pending audit event." };
  await writeFile(path.join(root, ".topical-history", "pending", "pending-fixture.json"), `${JSON.stringify(event)}\n`, "utf8");

  const recovered = new HistoryStore(root);
  t.after(() => recovered.close());
  await recovered.initialize();
  const page = await recovered.list({ topic: "recovered-topic", limit: 10 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].id, "pending-fixture");
  assert.deepEqual(await readdir(path.join(root, ".topical-history", "pending")), []);
});
