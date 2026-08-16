import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
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

  const topics = await store.listTopics({ tags: ["hue"] });
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
  assert.ok(overview.files.every((file) => !Object.hasOwn(file, "terms")));
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
  await store.getTopicOverview({ topic: "read-only" });
  await store.listTopics();
  await store.searchTopics({ query: "read-only evidence" });

  const after = await Promise.all([readFile(rootIndexPath, "utf8"), readFile(topicIndexPath, "utf8")]);
  assert.deepEqual(after, before);
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
    (error) => error instanceof TopicalError && /changed since it was read/.test(error.message)
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
  const removedFile = await store.deleteTopicFile({ topic: "docs", filePath: "tickets/42.md", confirm: true, description: "Archived obsolete ticket notes." });
  assert.match(removedFile.trashedTo, /\.trash/);
  await store.deleteTopic({ topic: "docs", confirm: true, description: "Archived the completed documentation topic." });
  const topics = await store.listTopics();
  assert.equal(topics.length, 0);
  const rootIndex = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  assert.equal(rootIndex.recentActions[0].action, "delete_topic");
});

test("reindexes topic metadata after a direct Markdown edit", async () => {
  const { root, store } = await createStore();
  await store.createTopic({ title: "Release", summary: "Initial summary.", tags: ["v1"], description: "Created the release topic." });
  const contextPath = path.join(root, "release", "context.md");
  await writeFile(contextPath, `---\ntitle: "Release planning"\nsummary: "Updated manually."\ntags: ["v2", "planning"]\ncreated_at: 2026-07-01T00:00:00.000Z\nupdated_at: 2026-07-18T00:00:00.000Z\n---\n\n# Plan\n`, "utf8");

  await store.reindex();
  const [topic] = await store.listTopics({ tags: ["planning"] });
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
  const [topic] = await store.listTopics({ tags: ["CAFÉ OPS"] });
  assert.deepEqual(topic.tags, ["Café Ops", "cafe ops", "alpha, beta"]);
  assert.equal((await store.listTopics({ tags: ["cafe ops"] })).length, 1);
  assert.equal((await store.searchTopics({ query: "", tags: ["alpha, beta"] })).topics.length, 1);

  const contextPath = path.join(root, "tag-identity", "context.md");
  const context = await readFile(contextPath, "utf8");
  assert.match(context, /"alpha, beta"/);
  await store.reindex();
  assert.deepEqual((await store.listTopics())[0].tags, ["Café Ops", "cafe ops", "alpha, beta"]);
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
