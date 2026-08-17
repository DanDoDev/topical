import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { TopicalStore } from "../src/store.js";
import { RELAXED_RELEVANCE_CASE, RELEVANCE_DOCUMENTS, STRICT_RELEVANCE_CASES } from "./fixtures/relevance.js";

async function createStore(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-retrieval-"));
  const store = new TopicalStore(root);
  await store.initialize();
  t.after(() => store.close());
  return { root, store };
}

async function materializeRelevanceStore(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-relevance-store-"));
  const grouped = new Map();
  for (const document of RELEVANCE_DOCUMENTS) {
    const documents = grouped.get(document.topic) || [];
    documents.push(document);
    grouped.set(document.topic, documents);
  }
  for (const [topic, documents] of grouped) {
    const context = documents.find((document) => document.path === "context.md");
    for (const document of documents) {
      const target = path.join(root, topic, document.path);
      await mkdir(path.dirname(target), { recursive: true });
      const content = document.path === "context.md"
        ? `---\ntitle: ${JSON.stringify(context.title)}\nsummary: ${JSON.stringify(context.summary)}\ntags: []\ncreated_at: 2026-08-08T00:00:00.000Z\nupdated_at: 2026-08-08T00:00:00.000Z\n---\n\n# ${document.headings[0]}\n\n${document.body}\n`
        : `# ${document.headings[0]}\n\n${document.body}\n`;
      await writeFile(target, content, "utf8");
    }
  }
  const store = new TopicalStore(root);
  await store.initialize();
  t.after(() => store.close());
  return { root, store };
}

test("production FTS5 search passes English/French grouped relevance gates", async (t) => {
  const { store } = await materializeRelevanceStore(t);
  for (const relevanceCase of STRICT_RELEVANCE_CASES) {
    const result = await store.searchTopics({ query: relevanceCase.query, limit: 10 });
    assert.equal(result.matchMode, "strict", relevanceCase.query);
    assert.equal(result.topics[0]?.topic, relevanceCase.first, relevanceCase.query);
    assert.deepEqual(new Set(result.topics.map((topic) => topic.topic)), new Set(relevanceCase.topics), relevanceCase.query);
    assert.equal(result.topics.length, new Set(result.topics.map((topic) => topic.topic)).size);
  }

  const relaxed = await store.searchTopics({ query: RELAXED_RELEVANCE_CASE.query, limit: 10 });
  assert.equal(relaxed.matchMode, "relaxed");
  assert.deepEqual(new Set(relaxed.topics.map((topic) => topic.topic)), new Set(RELAXED_RELEVANCE_CASE.topics));
});

test("root and topic catalogues omit term arrays and snippets omit frontmatter", async (t) => {
  const { root, store } = await createStore(t);
  await store.createTopic({
    title: "Clean snippets",
    summary: "Frontmatter sentinel metadata.",
    tags: [],
    initialContent: "# Retrieval\n\nHuman prose contains the searchable quasar marker.",
    description: "Created the clean snippet topic."
  });
  const rootIndex = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  const topicIndex = JSON.parse(await readFile(path.join(root, "clean-snippets", "index.json"), "utf8"));
  assert.ok(rootIndex.documents.every((document) => !Object.hasOwn(document, "terms")));
  assert.ok(topicIndex.documents.every((document) => !Object.hasOwn(document, "terms")));

  const result = await store.searchTopics({ query: "quasar marker" });
  const snippet = result.topics[0].files[0].snippet;
  assert.match(snippet, /Human prose/);
  assert.doesNotMatch(snippet, /title:|summary:|---/);
});

test("missing and corrupt SQLite caches rebuild automatically from Markdown", async (t) => {
  const { root, store } = await createStore(t);
  await store.createTopic({
    title: "Cache recovery",
    summary: "Disposable search state.",
    tags: [],
    initialContent: "# Recovery\n\nThe heliotrope recovery marker survives cache replacement.",
    description: "Created the cache recovery topic."
  });
  const cachePath = path.join(root, ".topical-cache", "search.sqlite");
  await store.close();
  await unlink(cachePath);

  const missingRebuild = new TopicalStore(root);
  await missingRebuild.initialize();
  assert.equal((await missingRebuild.searchTopics({ query: "heliotrope marker" })).topics[0]?.topic, "cache-recovery");
  await missingRebuild.close();
  await writeFile(cachePath, "not a sqlite database", "utf8");

  const corruptRebuild = new TopicalStore(root);
  t.after(() => corruptRebuild.close());
  await corruptRebuild.initialize();
  assert.equal((await corruptRebuild.searchTopics({ query: "heliotrope marker" })).topics[0]?.topic, "cache-recovery");
});

test("v0.3 JSON term arrays and incompatible cache schemas migrate by rebuilding derived state", async (t) => {
  const { root, store } = await createStore(t);
  await store.createTopic({
    title: "Migration source",
    summary: "Markdown survives the v0.4 migration.",
    tags: [],
    initialContent: "# Migration\n\nPersistent amethyst migration marker.",
    description: "Created the migration source topic."
  });
  await store.close();
  const rootIndexPath = path.join(root, "index.json");
  const topicIndexPath = path.join(root, "migration-source", "index.json");
  const rootIndex = JSON.parse(await readFile(rootIndexPath, "utf8"));
  const topicIndex = JSON.parse(await readFile(topicIndexPath, "utf8"));
  rootIndex.version = 2;
  topicIndex.version = 3;
  rootIndex.documents.forEach((document) => { document.terms = ["legacy", "amethyst"]; });
  topicIndex.documents.forEach((document) => { document.terms = ["legacy", "amethyst"]; });
  await writeFile(rootIndexPath, `${JSON.stringify(rootIndex, null, 2)}\n`, "utf8");
  await writeFile(topicIndexPath, `${JSON.stringify(topicIndex, null, 2)}\n`, "utf8");
  const database = new Database(path.join(root, ".topical-cache", "search.sqlite"));
  database.prepare("UPDATE metadata SET value = '1' WHERE key = 'schema_version'").run();
  database.close();

  const migrated = new TopicalStore(root);
  t.after(() => migrated.close());
  await migrated.initialize();
  const migratedRoot = JSON.parse(await readFile(rootIndexPath, "utf8"));
  const migratedTopic = JSON.parse(await readFile(topicIndexPath, "utf8"));
  assert.equal(migratedRoot.version, 4);
  assert.equal(migratedTopic.version, 5);
  assert.ok(migratedRoot.documents.every((document) => !Object.hasOwn(document, "terms")));
  assert.ok(migratedTopic.documents.every((document) => !Object.hasOwn(document, "terms")));
  assert.equal((await migrated.searchTopics({ query: "amethyst migration" })).topics[0]?.topic, "migration-source");
});

test("missing JSON catalogues rebuild even when the SQLite cache is compatible", async (t) => {
  const { root, store } = await createStore(t);
  await store.createTopic({ title: "Catalogue recovery", summary: "Rebuild derived JSON.", tags: [], initialContent: "Durable magenta catalogue marker.", description: "Created the catalogue recovery topic." });
  await store.close();
  await unlink(path.join(root, "index.json"));

  const missingRoot = new TopicalStore(root);
  await missingRoot.initialize();
  assert.equal((await missingRoot.listTopics()).topics[0]?.id, "catalogue-recovery");
  await missingRoot.close();
  await unlink(path.join(root, "catalogue-recovery", "index.json"));

  const missingTopic = new TopicalStore(root);
  t.after(() => missingTopic.close());
  await missingTopic.initialize();
  assert.equal((await missingTopic.getTopicOverview({ topic: "catalogue-recovery" })).files.length, 1);
  assert.equal((await missingTopic.searchTopics({ query: "magenta catalogue" })).topics[0]?.topic, "catalogue-recovery");
});

test("incremental replacement changes only the affected topic's search records", async (t) => {
  const { root, store } = await createStore(t);
  await store.createTopic({ title: "Changed topic", summary: "Mutation target.", tags: [], description: "Created the changed topic." });
  await store.createTopicFile({ topic: "changed-topic", filePath: "notes.md", content: "Old vermilion marker.", description: "Added the old search marker." });
  await store.createTopic({ title: "Stable topic", summary: "Must retain record identities.", tags: [], initialContent: "Stable cerulean marker.", description: "Created the stable topic." });
  const cachePath = path.join(root, ".topical-cache", "search.sqlite");
  const ids = () => {
    const database = new Database(cachePath, { readonly: true });
    try { return database.prepare("SELECT id FROM records WHERE topic = 'stable-topic' ORDER BY id").pluck().all(); }
    finally { database.close(); }
  };
  const stableBefore = ids();
  const before = await store.readTopicFile({ topic: "changed-topic", filePath: "notes.md" });
  await store.updateTopicFile({
    topic: "changed-topic",
    filePath: "notes.md",
    mode: "replace",
    content: "New chartreuse marker.",
    expectedHash: before.hash,
    description: "Replaced the search marker for the incremental index test."
  });

  assert.deepEqual(ids(), stableBefore);
  assert.equal((await store.searchTopics({ query: "vermilion" })).topics.length, 0);
  assert.equal((await store.searchTopics({ query: "chartreuse marker" })).topics[0]?.topic, "changed-topic");
  assert.equal((await store.searchTopics({ query: "cerulean marker" })).topics[0]?.topic, "stable-topic");
});

test("soft deletion removes stale document and topic postings", async (t) => {
  const { store } = await createStore(t);
  await store.createTopic({ title: "Deletion search", summary: "Soft deletion test.", tags: [], description: "Created the deletion search topic." });
  await store.createTopicFile({ topic: "deletion-search", filePath: "obsolete.md", content: "Ephemeral obsidian posting.", description: "Added the obsolete search posting." });
  assert.equal((await store.searchTopics({ query: "obsidian posting" })).topics[0]?.topic, "deletion-search");
  const obsolete = await store.readTopicFile({ topic: "deletion-search", filePath: "obsolete.md" });
  await store.deleteTopicFile({ topic: "deletion-search", filePath: "obsolete.md", expectedHash: obsolete.hash, confirm: true, description: "Archived the obsolete search posting." });
  assert.equal((await store.searchTopics({ query: "obsidian posting" })).topics.length, 0);
  const context = await store.readTopicFile({ topic: "deletion-search" });
  await store.deleteTopic({ topic: "deletion-search", expectedHash: context.hash, confirm: true, description: "Archived the deletion search topic." });
  assert.equal((await store.searchTopics({ query: "deletion search" })).topics.length, 0);
});

test("explicit reindex removes stale postings after direct Markdown edits", async (t) => {
  const { root, store } = await createStore(t);
  await store.createTopic({ title: "Direct edit", summary: "Manual Markdown reindexing.", tags: [], description: "Created the direct edit topic." });
  await store.createTopicFile({ topic: "direct-edit", filePath: "manual.md", content: "Old indigo filesystem marker.", description: "Added the direct edit fixture." });
  assert.equal((await store.searchTopics({ query: "indigo" })).topics[0]?.topic, "direct-edit");
  await writeFile(path.join(root, "direct-edit", "manual.md"), "New copper filesystem marker.\n", "utf8");
  await store.reindex();
  assert.equal((await store.searchTopics({ query: "indigo" })).topics.length, 0);
  assert.equal((await store.searchTopics({ query: "copper" })).topics[0]?.topic, "direct-edit");
});

test("tag filters remain exact and empty queries return bounded topic listings", async (t) => {
  const { store } = await createStore(t);
  await store.createTopic({ title: "Filtered one", summary: "Shared atlas phrase.", tags: ["operations"], description: "Created the filtered operations topic." });
  await store.createTopic({ title: "Filtered two", summary: "Shared atlas phrase.", tags: ["editorial"], description: "Created the filtered editorial topic." });
  const filtered = await store.searchTopics({ query: "atlas", tags: ["operations"] });
  assert.deepEqual(filtered.topics.map((topic) => topic.topic), ["filtered-one"]);
  const listing = await store.searchTopics({ query: "", limit: 1 });
  assert.equal(listing.matchMode, "listing");
  assert.equal(listing.topics.length, 1);
});

test("Unicode-safe snippets preserve source characters after accent folding", async (t) => {
  const { store } = await createStore(t);
  const marker = `Caf${"e\u0301"} sentinel`;
  await store.createTopic({
    title: "Unicode snippet",
    summary: "Offset mapping fixture.",
    tags: [],
    initialContent: `${"🙂 prose ".repeat(30)}${marker} remains intact.`,
    description: "Created the Unicode snippet fixture."
  });
  const result = await store.searchTopics({ query: "cafe sentinel" });
  assert.match(result.topics[0].files[0].snippet, new RegExp(marker));
  assert.doesNotMatch(result.topics[0].files[0].snippet, /�/);
});

test("cache paths reject symlinks before SQLite opens them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-cache-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "topical-cache-outside-"));
  await symlink(outside, path.join(root, ".topical-cache"), "dir");
  await assert.rejects(
    () => new TopicalStore(root).initialize(),
    /Symbolic links are not permitted/
  );
});

test("ordinary store reads leave root, topic, and SQLite derived state unchanged", async (t) => {
  const { root, store } = await createStore(t);
  await store.createTopic({ title: "Stable reads", summary: "Read-only derived state.", tags: [], initialContent: "Stable saffron query.", description: "Created the stable reads topic." });
  const paths = [
    path.join(root, "index.json"),
    path.join(root, "stable-reads", "index.json"),
    path.join(root, ".topical-cache", "search.sqlite")
  ];
  const capture = async () => Promise.all(paths.map(async (target) => ({ content: await readFile(target), modified: (await stat(target)).mtimeMs })));
  const before = await capture();
  await store.readTopicFile({ topic: "stable-reads" });
  await store.readRootCatalogue();
  await store.readTopicCatalogue({ topic: "stable-reads" });
  await store.getTopicOverview({ topic: "stable-reads" });
  await store.listTopics();
  await store.searchTopics({ query: "saffron query" });
  const after = await capture();
  assert.deepEqual(after, before);
});
