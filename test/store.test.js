import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TopicalError, TopicalStore } from "../src/store.js";

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-test-"));
  const store = new TopicalStore(root);
  await store.initialize();
  return { root, store };
}

test("creates a Markdown topic and indexes its metadata", async () => {
  const { root, store } = await createStore();
  const created = await store.createTopic({
    title: "Hue Lighting Effects",
    summary: "Implementation decisions for Hue light effects.",
    tags: ["hue", "lighting"],
    initialContent: "# Decisions\n\nAdd reusable effects with device capability checks.",
    description: "Created the Hue lighting effects topic."
  });

  assert.equal(created.topic, "hue-lighting-effects");
  const context = await readFile(path.join(root, "hue-lighting-effects", "context.md"), "utf8");
  assert.match(context, /title: "Hue Lighting Effects"/);
  assert.match(context, /# Decisions/);

  const { topics } = await store.listTopics({ tags: ["hue"] });
  assert.deepEqual(topics.map((topic) => topic.id), ["hue-lighting-effects"]);
  const rootIndex = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  assert.equal(rootIndex.topics[0].lastAction.description, "Created the Hue lighting effects topic.");
});

test("searches Markdown content, tags, and topic metadata", async () => {
  const { store } = await createStore();
  await store.createTopic({ title: "Authentication", summary: "OAuth redesign notes.", tags: ["security"], description: "Created the authentication topic." });
  await store.createTopicFile({ topic: "authentication", filePath: "research.md", content: "Token rotation needs a seven-day grace period.", description: "Added token rotation research." });

  const contentResult = await store.searchTopics({ query: "grace period" });
  assert.equal(contentResult.matchMode, "strict");
  assert.equal(contentResult.topics[0].files[0].path, "research.md");
  const tagResult = await store.searchTopics({ query: "security" });
  assert.equal(tagResult.topics[0].topic, "authentication");
});

test("uses incremental indexes for list and search, and provides bounded topic overviews", async () => {
  const { root, store } = await createStore();
  await store.createTopic({
    title: "Performance",
    summary: "Search index design.",
    tags: ["architecture"],
    initialContent: "# Current state\n\nThe lookup cache is ready.",
    description: "Created the performance topic."
  });
  await store.createTopicFile({
    topic: "performance",
    filePath: "research.md",
    content: "# Retrieval\n\nUse a lexical index before reading full Markdown files.",
    description: "Added retrieval research."
  });
  const rootIndexPath = path.join(root, "index.json");
  const before = await readFile(rootIndexPath, "utf8");
  const found = await store.searchTopics({ query: "lexical index" });
  await store.listTopics();
  const after = await readFile(rootIndexPath, "utf8");
  assert.equal(found.topics[0].files[0].path, "research.md");
  assert.equal(after, before, "ordinary reads must not rebuild or rewrite the root index");

  const overview = await store.getTopicOverview({ topic: "performance", maxChars: 500 });
  assert.match(overview.context, /lookup cache/);
  assert.equal(overview.files.length, 2);
  assert.ok(overview.files.every((file) => /^\d{4}-\d{2}-\d{2}T/.test(file.updatedAt)));
  assert.ok(overview.files.every((file) => !Object.hasOwn(file, "terms")));
  assert.equal((await store.listTopics()).topics[0].fileCount, 2);
});

test("ordinary reads do not mutate root or topic derived state", async () => {
  const { root, store } = await createStore();
  await store.createTopic({
    title: "Read only",
    summary: "Derived state must stay stable during reads.",
    tags: [],
    initialContent: "# Stable state\n\nSearchable read-only evidence.",
    description: "Created the read-only regression topic."
  });
  const rootIndexPath = path.join(root, "index.json");
  const topicIndexPath = path.join(root, "read-only", "index.json");
  const before = await Promise.all([readFile(rootIndexPath, "utf8"), readFile(topicIndexPath, "utf8")]);

  await store.readTopicFile({ topic: "read-only" });
  const rootCatalogue = await store.readRootCatalogue();
  const rootRawCatalogue = await store.readRootCatalogue({ view: "raw" });
  const topicCatalogue = await store.readTopicCatalogue({ topic: "read-only" });
  const topicRawCatalogue = await store.readTopicCatalogue({ topic: "read-only", view: "raw" });
  await store.getTopicOverview({ topic: "read-only" });
  await store.listTopics();
  await store.searchTopics({ query: "read-only evidence" });

  const after = await Promise.all([readFile(rootIndexPath, "utf8"), readFile(topicIndexPath, "utf8")]);
  assert.deepEqual(after, before);
  assert.equal(rootRawCatalogue.raw, before[0]);
  assert.equal(topicRawCatalogue.raw, before[1]);
  assert.equal(rootCatalogue.data.topics[0].id, "read-only");
  assert.equal(topicCatalogue.data.topic.id, "read-only");
  assert.equal(rootCatalogue.hash.length, 64);
  assert.equal(topicCatalogue.hash.length, 64);
  assert.equal(rootCatalogue.raw, undefined);
  assert.equal(rootRawCatalogue.data, undefined);
});

test("long-lived stores observe external topic and search-index replacements", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-shared-store-test-"));
  const reader = new TopicalStore(root);
  const writer = new TopicalStore(root);
  await reader.initialize();
  await writer.initialize();
  t.after(async () => { await Promise.all([reader.close(), writer.close()]); });

  const before = await reader.getRevision();
  await writer.createTopic({
    title: "External Penguin",
    summary: "Created by another Topical process.",
    tags: ["wildlife"],
    initialContent: "# Colony\n\nEmperor penguins gather on sea ice.",
    description: "Created the external-process fixture."
  });

  const topics = await reader.listTopics();
  const search = await reader.searchTopics({ query: "emperor penguins" });
  const after = await reader.getRevision();
  assert.ok(topics.topics.some((topic) => topic.id === "external-penguin"));
  assert.equal(search.topics[0]?.topic, "external-penguin");
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.recentChanges[0].topic, "external-penguin");
  assert.equal(after.recentChanges[0].title, "External Penguin");
  assert.equal(after.recentChanges[0].action, "create_topic");
  assert.equal(after.recentChanges[0].path, "context.md");
});

test("missing derived indexes can be rebuilt from Markdown without data loss", async () => {
  const { root, store } = await createStore();
  await store.createTopic({
    title: "Rebuildable cache",
    summary: "Markdown survives disposable derived state.",
    tags: [],
    initialContent: "# Recovery\n\nRebuild search from authoritative Markdown.",
    description: "Created the rebuild regression topic."
  });
  const original = await store.readTopicFile({ topic: "rebuildable-cache" });
  await unlink(path.join(root, "index.json"));
  await unlink(path.join(root, "rebuildable-cache", "index.json"));

  const rebuiltStore = new TopicalStore(root);
  await rebuiltStore.initialize();
  await rebuiltStore.reindex();
  const rebuilt = await rebuiltStore.readTopicFile({ topic: "rebuildable-cache" });
  const results = await rebuiltStore.searchTopics({ query: "authoritative markdown" });

  assert.equal(rebuilt.content, original.content);
  assert.equal(rebuilt.hash, original.hash);
  assert.equal(results.topics[0]?.topic, "rebuildable-cache");
});

test("updates a file with conflict protection and named-section replacement", async () => {
  const { store } = await createStore();
  await store.createTopic({ title: "Payments", summary: "", tags: [], initialContent: "# Decision\n\nUse provider A.\n\n# Open questions\n\nNone.", description: "Created the payments topic." });
  const before = await store.readTopicFile({ topic: "payments" });
  const updated = await store.updateTopicFile({
    topic: "payments",
    mode: "replace_section",
    section: "Open questions",
    content: "Confirm regional availability.",
    expectedHash: before.hash,
    description: "Recorded the remaining regional availability question."
  });
  const after = await store.readTopicFile({ topic: "payments" });
  assert.notEqual(updated.hash, before.hash);
  assert.equal(updated.hash, after.hash, "returned hash must represent the persisted post-update file");
  assert.match(after.content, /Confirm regional availability/);
  await assert.rejects(
    () => store.updateTopicFile({ topic: "payments", content: "stale", expectedHash: before.hash, description: "Tried to write stale content." }),
    (error) => error instanceof TopicalError && error.code === "CONFLICT"
  );
});

test("protects paths and soft-deletes files and topics", async () => {
  const { root, store } = await createStore();
  await store.createTopic({ title: "Docs", summary: "", tags: [], description: "Created the documentation topic." });
  await assert.rejects(
    () => store.createTopicFile({ topic: "docs", filePath: "../escape.md", content: "", description: "Tried an unsafe path." }),
    (error) => error instanceof TopicalError && /safe relative path/.test(error.message)
  );
  await assert.rejects(
    () => store.createTopicFile({ topic: "docs", filePath: "notes.txt", content: "", description: "Tried an unsupported file type." }),
    (error) => error instanceof TopicalError && /Markdown paths/.test(error.message)
  );
  await store.createTopicFile({ topic: "docs", filePath: "tickets/42.md", content: "Ticket notes", description: "Added ticket notes." });
  await assert.rejects(
    () => store.deleteTopicFile({ topic: "docs", filePath: "context.md", confirm: true, description: "Tried to remove required context." }),
    (error) => error instanceof TopicalError && /cannot be deleted/.test(error.message)
  );
  const ticket = await store.readTopicFile({ topic: "docs", filePath: "tickets/42.md" });
  const removedFile = await store.deleteTopicFile({ topic: "docs", filePath: "tickets/42.md", expectedHash: ticket.hash, confirm: true, description: "Archived obsolete ticket notes." });
  assert.equal(removedFile.trash.type, "file");
  const context = await store.readTopicFile({ topic: "docs" });
  await store.deleteTopic({ topic: "docs", expectedHash: context.hash, confirm: true, description: "Archived the completed documentation topic." });
  const { topics } = await store.listTopics();
  assert.equal(topics.length, 0);
  const rootIndex = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  assert.equal(rootIndex.recentActions[0].action, "delete_topic");
});

test("taxonomy is bounded and read-only", async () => {
  const { root, store } = await createStore();
  await store.createTopic({ title: "Taxonomy one", summary: "", tags: ["Café-Ops", "singleton"], description: "Created the first taxonomy topic." });
  await store.createTopic({ title: "Taxonomy two", summary: "", tags: ["cafe_ops", "singletom", "third", "fourth"], description: "Created the second taxonomy topic." });
  const rootPath = path.join(root, "index.json");
  const before = await readFile(rootPath, "utf8");
  const taxonomy = await store.listTags({ limit: 2 });
  const after = await readFile(rootPath, "utf8");

  assert.equal(taxonomy.tags.length, 2);
  assert.ok(taxonomy.page.nextCursor);
  assert.equal(taxonomy.summary.topics, 2);
  assert.equal(taxonomy.summary.topicsAboveGuidance, 1);
  assert.equal(taxonomy.warnings.comparisonCollisions.length, 1);
  assert.ok(taxonomy.warnings.nearDuplicates.some((entry) => entry.keys.includes("singleton") && entry.keys.includes("singletom")));
  assert.equal(after, before);
});

test("topic, history, and health reads are bounded, stable, and read-only", async () => {
  const { root, store } = await createStore();
  await store.createTopic({ title: "Page alpha", summary: "", tags: [], description: "Created the alpha page fixture." });
  await store.createTopic({ title: "Page beta", summary: "", tags: [], description: "Created the beta page fixture." });
  const rootPath = path.join(root, "index.json");
  const before = await readFile(rootPath, "utf8");

  const first = await store.listTopics({ sort: "title", limit: 1 });
  const second = await store.listTopics({ sort: "title", cursor: first.page.nextCursor, limit: 1 });
  assert.deepEqual(first.topics.map((topic) => topic.id), ["page-alpha"]);
  assert.deepEqual(second.topics.map((topic) => topic.id), ["page-beta"]);
  assert.equal(second.page.nextCursor, null);

  const history = await store.listHistory({ topic: "page-alpha", limit: 1 });
  assert.equal(history.events[0].action, "create_topic");
  const health = await store.getSystemHealth();
  assert.equal(health.status, "ready");
  assert.equal(health.markdownAuthority, true);
  assert.equal(health.catalogue.topics, 2);
  assert.equal(health.search.fts5, true);
  assert.equal(health.rebuildRecommended, false);
  assert.equal(await readFile(rootPath, "utf8"), before);
});

test("lean overviews, complete file paging, and exact search-file paging stay bounded", async () => {
  const { store } = await createStore();
  await store.createTopic({ title: "Bounded workspace", summary: "Paged file fixture.", tags: [], description: "Created the bounded workspace fixture." });
  for (let index = 0; index < 7; index += 1) {
    await store.createTopicFile({ topic: "bounded-workspace", filePath: `research/note-${index}.md`, content: `# Finding ${index}\n\nShared narwhal evidence ${index}.`, description: `Added generated research note ${index}.` });
  }

  const lean = await store.getTopicOverview({ topic: "bounded-workspace", include: [] });
  assert.deepEqual(Object.keys(lean).sort(), ["metadata", "topic"]);
  const overview = await store.getTopicOverview({ topic: "bounded-workspace", include: ["files"], fileLimit: 3 });
  assert.equal(overview.files.length, 3);
  assert.equal(overview.files[0].path, "context.md");
  assert.equal(overview.filePage.total, 8);
  assert.ok(overview.filePage.nextCursor);

  const paths = [];
  let cursor;
  do {
    const page = await store.listTopicFiles({ topic: "bounded-workspace", sort: "name", limit: 3, cursor });
    paths.push(...page.files.map((file) => file.path));
    cursor = page.page.nextCursor;
  } while (cursor);
  assert.equal(paths.length, 8);
  assert.equal(new Set(paths).size, 8);

  const initialSearch = await store.searchTopics({ query: "narwhal evidence" });
  assert.equal(initialSearch.topics[0].fileMatchCount, 7);
  assert.equal(initialSearch.topics[0].files.length, 3);
  const matchingPaths = [];
  cursor = undefined;
  do {
    const page = await store.searchTopicFiles({ query: "narwhal evidence", topic: "bounded-workspace", matchMode: initialSearch.matchMode, limit: 3, cursor });
    matchingPaths.push(...page.files.map((file) => file.path));
    cursor = page.page.nextCursor;
  } while (cursor);
  assert.equal(matchingPaths.length, 7);
  assert.ok(matchingPaths.every((filePath) => filePath.startsWith("research/")));
});

test("normal file mutations keep recent history small and update search without replacing its database", async () => {
  const { root, store } = await createStore();
  await store.createTopic({ title: "Incremental writes", summary: "One-file mutation fixture.", tags: [], description: "Created the incremental-write fixture." });
  await store.createTopicFile({ topic: "incremental-writes", filePath: "changed.md", content: "Old cobalt marker.", description: "Added the changing file." });
  await store.createTopicFile({ topic: "incremental-writes", filePath: "untouched.md", content: "Stable amber marker.", description: "Added the untouched file." });
  const cachePath = path.join(root, ".topical-cache", "search.sqlite");
  const beforeCache = await stat(cachePath, { bigint: true });
  const changed = await store.readTopicFile({ topic: "incremental-writes", filePath: "changed.md" });
  await store.updateTopicFile({ topic: "incremental-writes", filePath: "changed.md", content: "New violet marker.", expectedHash: changed.hash, description: "Updated only the changing file." });
  const afterCache = await stat(cachePath, { bigint: true });
  assert.equal(afterCache.ino, beforeCache.ino, "incremental updates must not replace the complete search database");
  assert.equal((await store.searchTopics({ query: "violet marker" })).topics[0]?.files[0]?.path, "changed.md");
  assert.equal((await store.searchTopics({ query: "stable amber" })).topics[0]?.files[0]?.path, "untouched.md");

  let context = await store.readTopicFile({ topic: "incremental-writes" });
  for (let index = 0; index < 14; index += 1) {
    context = await store.updateTopicMetadata({ topic: "incremental-writes", summary: `Revision ${index}.`, expectedHash: context.hash, description: `Recorded generated metadata revision ${index}.` });
  }
  const topicIndex = JSON.parse(await readFile(path.join(root, "incremental-writes", "index.json"), "utf8"));
  const history = await store.listHistory({ topic: "incremental-writes", limit: 100 });
  assert.equal(topicIndex.recentHistory.length, 12);
  assert.equal(Object.hasOwn(topicIndex, "history"), false);
  assert.equal(history.page.total, 18);
});

test("context analysis is advisory and leaves large routing documents unchanged", async () => {
  const { store } = await createStore();
  const body = `# Current status\n\n${"Detailed project log. ".repeat(240)}\n\n## August 2026\n\n[Focused plan](plan.md)\n[Missing](missing.md)`;
  await store.createTopic({ title: "Context advisor", summary: "Analysis-only fixture.", tags: [], initialContent: body, description: "Created the context-advisor fixture." });
  await store.createTopicFile({ topic: "context-advisor", filePath: "plan.md", content: "# Focused plan\n", description: "Added the focused plan fixture." });
  const before = await store.readTopicFile({ topic: "context-advisor" });
  const analysis = await store.analyzeTopicContext({ topic: "context-advisor" });
  const after = await store.readTopicFile({ topic: "context-advisor" });
  assert.equal(analysis.mode, "analyze_only");
  assert.equal(analysis.changed, false);
  assert.equal(analysis.context.aboveTarget, true);
  assert.ok(analysis.findings.some((finding) => finding.code === "ABOVE_CONTEXT_BUDGET"));
  assert.deepEqual(analysis.details.brokenLinks, ["missing.md"]);
  assert.equal(after.hash, before.hash);
});

test("legacy catalogue history migrates idempotently before the topic ring is trimmed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-legacy-history-test-"));
  const topicDirectory = path.join(root, "legacy-history");
  await mkdir(topicDirectory);
  await writeFile(path.join(topicDirectory, "context.md"), `---\ntitle: "Legacy history"\nsummary: "Migration fixture."\ntags: []\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\n---\n\n# Legacy history\n`, "utf8");
  const history = Array.from({ length: 130 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    action: index === 0 ? "create_topic" : "update_file",
    path: "context.md",
    description: `Legacy event ${index}.`
  }));
  await writeFile(path.join(topicDirectory, "index.json"), `${JSON.stringify({ version: 5, topic: { id: "legacy-history", title: "Legacy history", summary: "Migration fixture.", tags: [] }, files: ["context.md"], history }, null, 2)}\n`, "utf8");
  const otherDirectory = path.join(root, "other-history");
  await mkdir(otherDirectory);
  await writeFile(path.join(otherDirectory, "context.md"), `---\ntitle: "Other history"\nsummary: "Interleaved migration fixture."\ntags: []\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\n---\n\n# Other history\n`, "utf8");
  await writeFile(path.join(otherDirectory, "index.json"), `${JSON.stringify({ version: 5, topic: { id: "other-history", title: "Other history", summary: "Interleaved migration fixture.", tags: [] }, files: ["context.md"], history: [
    { at: "2026-01-01T00:00:30.000Z", action: "create_topic", path: "context.md", description: "Other legacy event zero." },
    { at: "2026-01-01T00:01:30.000Z", action: "update_file", path: "context.md", description: "Other legacy event one." }
  ] }, null, 2)}\n`, "utf8");

  const store = new TopicalStore(root);
  await store.initialize();
  const first = await store.listHistory({ topic: "legacy-history", limit: 100 });
  const second = await store.listHistory({ topic: "legacy-history", cursor: first.page.nextCursor, limit: 100 });
  const migratedIndex = JSON.parse(await readFile(path.join(topicDirectory, "index.json"), "utf8"));
  assert.equal(first.page.total, 130);
  assert.equal(first.events.length + second.events.length, 130);
  assert.equal(migratedIndex.recentHistory.length, 12);
  assert.equal(Object.hasOwn(migratedIndex, "history"), false);
  const globalFirst = await store.listHistory({ limit: 100 });
  const globalSecond = await store.listHistory({ cursor: globalFirst.page.nextCursor, limit: 100 });
  const globalEvents = [...globalFirst.events, ...globalSecond.events];
  assert.equal(globalEvents.length, 132);
  assert.ok(globalEvents.every((event, index) => index === 0 || globalEvents[index - 1].at >= event.at), "interleaved per-topic legacy events must migrate into global timestamp order");
  const rollback = await store.prepareV05Rollback({ confirm: true });
  const rollbackRoot = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  const rollbackTopic = JSON.parse(await readFile(path.join(topicDirectory, "index.json"), "utf8"));
  assert.deepEqual({ status: rollback.status, topics: rollback.topics, events: rollback.events }, { status: "ready_for_v0.5", topics: 2, events: 132 });
  assert.equal(rollbackRoot.version, 4);
  assert.equal(rollbackTopic.version, 5);
  assert.equal(rollbackTopic.history.length, 130);
  assert.equal(Object.hasOwn(rollbackTopic, "recentHistory"), false);
  await store.close();
  rollbackTopic.history.push({ at: "2026-01-01T03:00:00.000Z", action: "update_file", path: "context.md", description: "Event written during the v0.5 rollback window." });
  await writeFile(path.join(topicDirectory, "index.json"), `${JSON.stringify(rollbackTopic, null, 2)}\n`, "utf8");

  const reopened = new TopicalStore(root);
  await reopened.initialize();
  assert.equal((await reopened.listHistory({ topic: "legacy-history", limit: 1 })).page.total, 131);
  assert.equal((await reopened.listHistory({ limit: 1 })).page.total, 133);
  await reopened.close();
});

test("metadata, deletion, and restore require reviewed hashes", async () => {
  const { store } = await createStore();
  await store.createTopic({ title: "Recoverable", summary: "Initial.", tags: [], description: "Created the recoverable topic." });
  await store.createTopicFile({ topic: "recoverable", filePath: "notes.md", content: "Recoverable notes.", description: "Added recoverable notes." });
  const context = await store.readTopicFile({ topic: "recoverable" });
  await assert.rejects(
    () => store.updateTopicMetadata({ topic: "recoverable", summary: "Stale.", expectedHash: "0".repeat(64), description: "Tried a stale metadata update." }),
    (error) => error instanceof TopicalError && error.code === "CONFLICT"
  );
  const metadata = await store.updateTopicMetadata({ topic: "recoverable", summary: "Reviewed.", expectedHash: context.hash, description: "Updated reviewed metadata." });
  assert.equal(metadata.hash, (await store.readTopicFile({ topic: "recoverable" })).hash);

  const notes = await store.readTopicFile({ topic: "recoverable", filePath: "notes.md" });
  const deletedFile = await store.deleteTopicFile({ topic: "recoverable", filePath: "notes.md", expectedHash: notes.hash, confirm: true, description: "Archived reviewed notes." });
  const trash = await store.listTrash({ topic: "recoverable" });
  assert.equal(trash.entries[0].id, deletedFile.trash.id);
  assert.equal(trash.retention.automaticDeletion, false);
  await store.restoreTrash({ id: deletedFile.trash.id, expectedHash: notes.hash, description: "Restored reviewed notes." });
  assert.equal((await store.readTopicFile({ topic: "recoverable", filePath: "notes.md" })).content, notes.content);

  const reviewedContext = await store.readTopicFile({ topic: "recoverable" });
  const deletedTopic = await store.deleteTopic({ topic: "recoverable", expectedHash: reviewedContext.hash, confirm: true, description: "Archived the reviewed topic." });
  await store.restoreTrash({ id: deletedTopic.trash.id, expectedHash: reviewedContext.hash, description: "Restored the reviewed topic." });
  assert.equal((await store.listTopics()).topics[0].id, "recoverable");
  assert.equal((await store.listTrash()).entries.length, 0);
});

test("reindexes topic metadata after a direct Markdown edit", async () => {
  const { root, store } = await createStore();
  await store.createTopic({ title: "Release", summary: "Initial summary.", tags: ["v1"], description: "Created the release topic." });
  const contextPath = path.join(root, "release", "context.md");
  await writeFile(contextPath, `---\ntitle: "Release planning"\nsummary: "Updated manually."\ntags: ["v2", "planning"]\ncreated_at: 2026-07-01T00:00:00.000Z\nupdated_at: 2026-07-18T00:00:00.000Z\n---\n\n# Plan\n`, "utf8");

  await store.reindex();
  const [topic] = (await store.listTopics({ tags: ["planning"] })).topics;
  assert.equal(topic.title, "Release planning");
  assert.equal(topic.summary, "Updated manually.");
});

test("uses one canonical tag identity and parses JSON tags containing commas", async () => {
  const { root, store } = await createStore();
  await store.createTopic({
    title: "Tag identity",
    summary: "Canonical tag fixture.",
    tags: [" Café Ops ", "café   ops", "cafe ops", "alpha, beta"],
    description: "Created the canonical tag fixture."
  });
  const [topic] = (await store.listTopics({ tags: ["CAFÉ OPS"] })).topics;
  assert.deepEqual(topic.tags, ["Café Ops", "cafe ops", "alpha, beta"]);
  assert.equal((await store.listTopics({ tags: ["cafe ops"] })).topics.length, 1);
  assert.equal((await store.searchTopics({ query: "", tags: ["alpha, beta"] })).topics.length, 1);

  const contextPath = path.join(root, "tag-identity", "context.md");
  const context = await readFile(contextPath, "utf8");
  assert.match(context, /"alpha, beta"/);
  await store.reindex();
  assert.deepEqual((await store.listTopics()).topics[0].tags, ["Café Ops", "cafe ops", "alpha, beta"]);
});

test("search returns bounded analysis for ignored query terms", async () => {
  const { store } = await createStore();
  await store.createTopic({ title: "Query analysis", summary: "term1 term2", tags: [], description: "Created the query-analysis fixture." });
  const query = `${Array.from({ length: 21 }, (_, index) => `term${index + 1}`).join(" ")} TERM1`;
  const result = await store.searchTopics({ query });
  assert.equal(result.analysis.retainedTerms.length, 20);
  assert.deepEqual(result.analysis.ignoredTerms.map((term) => term.reason), ["term_limit", "duplicate"]);
});

test("rejects symlinks so reads and writes cannot escape TOPICAL_ROOT", async () => {
  const { root, store } = await createStore();
  const outside = await mkdtemp(path.join(os.tmpdir(), "topical-outside-"));
  await writeFile(path.join(outside, "secret.md"), "This must not be exposed through Topical.", "utf8");
  await store.createTopic({ title: "Safety", summary: "", tags: [], description: "Created the safety topic." });
  await symlink(outside, path.join(root, "safety", "linked-directory"), "dir");
  await symlink(path.join(outside, "secret.md"), path.join(root, "safety", "linked-file.md"), "file");

  await assert.rejects(
    () => store.createTopicFile({ topic: "safety", filePath: "linked-directory/escape.md", content: "must not write", description: "Tried to write through a symlink." }),
    (error) => error instanceof TopicalError && /Symbolic links/.test(error.message)
  );
  await assert.rejects(
    () => store.readTopicFile({ topic: "safety", filePath: "linked-file.md" }),
    (error) => error instanceof TopicalError && /Symbolic links/.test(error.message)
  );
  assert.deepEqual(await readdir(outside), ["secret.md"]);
});

test("requires TOPICAL_ROOT to be a dedicated absolute directory", async () => {
  assert.throws(() => new TopicalStore("relative-topical-root"), /absolute path/);
  const target = await mkdtemp(path.join(os.tmpdir(), "topical-real-root-"));
  const linkedRoot = `${target}-link`;
  await symlink(target, linkedRoot, "dir");
  await assert.rejects(
    () => new TopicalStore(linkedRoot).initialize(),
    (error) => error instanceof TopicalError && /symbolic link/.test(error.message)
  );
});
