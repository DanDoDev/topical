import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TopicalStore } from "../src/store.js";
import { contextSections } from "../src/reorganization.js";
const description = "Organized reviewed context sections.";
async function fixture(t, content = "# Orbit\n\n## Current\n\nKeep this.\n\n## Investigation\n\nEvidence.\n\n- [ ] Follow up\n\n### Details\n\nMore evidence.\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-organize-"));
  const store = new TopicalStore(root);
  await store.initialize(); t.after(() => store.close());
  const { topic } = await store.createTopic({ title: "Orbit", initialContent: content, description });
  const source = await store.readTopicFile({ topic });
  const section = contextSections(source.content).find((item) => item.title === "Investigation");
  const input = { topic, expectedHash: source.hash, extractions: [{ start: section.start, destination: "history/investigation.md" }] };
  return { root, store, topic, source, input };
}

test("preview is read-only; apply preserves material, heading routes and single task ownership", async (t) => {
  const { root, store, topic, source, input } = await fixture(t);
  const before = await readFile(path.join(root, topic, "index.json"));
  const plan = await store.previewTopicReorganization(input);
  assert.equal((await store.readTopicFile({ topic })).hash, source.hash);
  assert.deepEqual(await readFile(path.join(root, topic, "index.json")), before);
  assert.ok(!(await readdir(path.join(root, topic))).includes("history"));
  assert.match(plan.source.after, /### Details\n\n\[Read supporting file\]/);
  assert.match(plan.files[0].content, /More evidence/);
  await store.applyTopicReorganization({ ...input, previewHash: plan.previewHash, description });
  assert.equal((await store.readTopicFile({ topic })).content, plan.source.after);
  assert.equal((await store.readTopicFile({ topic, filePath: plan.files[0].path })).content, plan.files[0].content);
  const tasks = await store.listTasks({ topic });
  assert.equal(tasks.counts.total, 1);
  assert.equal(tasks.tasks[0].path, "history/investigation.md");
  await store.reindex();
  assert.equal((await store.listTasks({ topic })).counts.total, 1);
  const history = await store.listHistory({ topic });
  assert.ok(history.events.some((event) => event.description === description));
});

test("stale previews, modified inputs, occupied paths and unsafe destinations fail before writes", async (t) => {
  const { store, topic, source, input } = await fixture(t);
  const plan = await store.previewTopicReorganization(input);
  await assert.rejects(store.applyTopicReorganization({ ...input, extractions: [{ ...input.extractions[0], destination: "other.md" }], previewHash: plan.previewHash, description }), { code: "CONFLICT" });
  for (const destination of ["../escape.md", "context.md", ".hidden/notes.md"]) {
    await assert.rejects(store.previewTopicReorganization({ ...input, extractions: [{ ...input.extractions[0], destination }] }));
  }
  await store.createTopicFile({ topic, filePath: input.extractions[0].destination, content: "Existing work", description });
  await assert.rejects(store.applyTopicReorganization({ ...input, previewHash: plan.previewHash, description }), { code: "CONFLICT" });
  assert.equal((await store.readTopicFile({ topic })).hash, source.hash);
  await store.updateTopicFile({ topic, expectedHash: source.hash, content: "External decision", description });
  await assert.rejects(store.applyTopicReorganization({ ...input, previewHash: plan.previewHash, description }), { code: "CONFLICT" });
});

test("Markdown links, images and references are rebased; examples and Unicode remain exact", async (t) => {
  const { store, input } = await fixture(t, '# Orbit\r\n\r\n## Current\r\n\r\n[Elsewhere][trace]\r\n\r\n## Investigation\r\n\r\n🪐 [trace](evidence.md#log) ![graph](assets/plot.png) [details](#details) [ref][trace]\r\n\r\n```md\r\n## Fake heading\r\n[code](leave.md)\r\n```\r\n\r\n[trace]: <evidence.md> "Trace"\r\n\r\n### Details\r\n\r\nKeep *formatting*.\r\n');
  const plan = await store.previewTopicReorganization(input);
  assert.match(plan.files[0].content, /\[trace\]\(<\.\.\/evidence.md#log>\)/);
  assert.match(plan.files[0].content, /!\[graph\]\(<\.\.\/assets\/plot.png>\)/);
  assert.match(plan.files[0].content, /\[details\]\(<\.\.\/context.md#details>\)/);
  assert.match(plan.files[0].content, /\[trace\]: <\.\.\/evidence.md> "Trace"/);
  assert.match(plan.source.after, /\[trace\]: <evidence.md> "Trace"/);
  assert.match(plan.files[0].content, /\[code\]\(leave.md\)/);
  assert.ok(!contextSections(plan.source.before).some((item) => item.title === "Fake heading"));
});

test("nested context, setext headings, outside references and file task exclusions survive extraction", async (t) => {
  const { store, topic } = await fixture(t);
  await store.createTopicFile({ topic, filePath: "issues/a/context.md", content: '# Issue\n\n[ref]: ../../evidence.md\n\nInvestigation\n-------------\n\n<!-- topical:tasks off -->\n\n- [ ] Procedure\n\n[Evidence][ref]\n\n## Keep\n\n- [ ] Another procedure\n', description });
  const source = await store.readTopicFile({ topic, filePath: "issues/a/context.md" });
  const input = { topic, filePath: source.path, expectedHash: source.hash, extractions: [{ start: contextSections(source.content)[0].start, destination: "issues/a/research/evidence.md" }] };
  const plan = await store.previewTopicReorganization(input);
  assert.match(plan.files[0].content, /\[ref\]: <\.\.\/\.\.\/\.\.\/evidence.md>/);
  await store.applyTopicReorganization({ ...input, previewHash: plan.previewHash, description });
  assert.equal((await store.listTasks({ topic, pathPrefix: "issues/a" })).counts.total, 0);
});

test("overlapping sections and symlink destinations are rejected", async (t) => {
  const { root, store, source, topic, input } = await fixture(t);
  const child = contextSections(source.content).find((section) => section.title === "Details");
  await assert.rejects(store.previewTopicReorganization({ ...input, extractions: [...input.extractions, { start: child.start, destination: "details.md" }] }), /children/);
  await symlink(os.tmpdir(), path.join(root, topic, "outside"));
  await assert.rejects(store.previewTopicReorganization({ ...input, extractions: [{ ...input.extractions[0], destination: "outside/file.md" }] }), /symbolic|symlink/i);
});

test("concurrent source changes preserve copies and recover with an explicitly refreshed preview", async (t) => {
  const { root, store, topic, source, input } = await fixture(t);
  const plan = await store.previewTopicReorganization(input);
  const read = store.readTopicFile.bind(store);
  let reads = 0;
  store.readTopicFile = async (args) => {
    if ((!args.filePath || args.filePath === "context.md") && ++reads === 2) await writeFile(path.join(root, topic, "context.md"), source.content + "\nExternal observation.\n");
    return read(args);
  };
  await assert.rejects(store.applyTopicReorganization({ ...input, previewHash: plan.previewHash, description }), (error) => error.code === "PARTIAL_REORGANIZATION" && error.details.preserved.length === 1 && !error.details.sourceWritten);
  store.readTopicFile = read;
  assert.match((await read({ topic })).content, /External observation/);
  assert.equal((await read({ topic, filePath: plan.files[0].path })).content, plan.files[0].content);
  // Identical preserved files can be reused; changed sections need a new destination.
  await writeFile(path.join(root, topic, "context.md"), source.content.replace("Keep this.", "Keep the new decision."));
  const current = await read({ topic });
  const freshInput = { ...input, expectedHash: current.hash, extractions: [{ start: contextSections(current.content).find((s) => s.title === "Investigation").start, destination: plan.files[0].path }] };
  const fresh = await store.previewTopicReorganization(freshInput);
  await store.applyTopicReorganization({ ...freshInput, previewHash: fresh.previewHash, description });
  assert.equal((await store.listTasks({ topic })).counts.total, 1);
});

test("rebasing respects escaped image labels and first-definition-wins semantics", async (t) => {
  const { store, input } = await fixture(t, '# Orbit\n\n[trace]: first.md\n\n## Investigation\n\n![a\\](literal)](assets/image.png)\n\n[Trace][trace]\n\n[trace]: second.md\n');
  const plan = await store.previewTopicReorganization(input);
  assert.match(plan.files[0].content, /!\[a\\\]\(literal\)\]\(<\.\.\/assets\/image.png>\)/);
  assert.ok(plan.files[0].content.indexOf('[trace]: <../first.md>') < plan.files[0].content.indexOf('[trace]: <../second.md>'));
});

test("analysis resolves nested encoded destinations and ignores fenced link examples", async (t) => {
  const { store, topic } = await fixture(t);
  await store.createTopicFile({ topic, filePath: "research/my evidence.md", content: "Evidence", description });
  await store.createTopicFile({ topic, filePath: "issues/context.md", content: '# Issue\n\n## Links\n\n[Evidence](../research/my%20evidence.md "Read")\n\n```md\n[Example](missing.md)\n```\n', description });
  const analysis = await store.analyzeTopicContext({ topic, filePath: "issues/context.md" });
  assert.deepEqual(analysis.details.brokenLinks, []);
});
