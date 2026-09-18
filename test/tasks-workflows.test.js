import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TopicalStore } from "../src/store.js";
import { extractTasks } from "../src/tasks.js";
import { linkWork } from "../src/workflows.js";

const description = "Verified the structured workflow.";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-tasks-"));
  const store = new TopicalStore(root);
  await store.initialize();
  t.after(() => store.close());
  await store.createTopic({ title: "Orbit oncall", template: "oncall", description });
  return { root, store, topic: "orbit-oncall" };
}

test("tasks parse Markdown structure and retain exact CRLF/Unicode source offsets", () => {
  const content = '---\r\ntitle: "🪐"\r\n---\r\n# Follow-ups\r\n- [ ] Investigate **timeouts**\r\n  - [X] Capture trace\r\n\r\n> - [ ] Quoted\r\n\r\n```md\r\n- [ ] Example\r\n```\r\n\r\n    - [ ] Indented code\r\n\r\n<div>\r\n- [ ] HTML\r\n</div>\r\n\r\n1. [x] Complete\r\n';
  const tasks = extractTasks(content);
  assert.deepEqual(tasks.map((item) => [item.text, item.completed]), [["Investigate timeouts", false], ["Capture trace", true], ["Complete", true]]);
  assert.ok(tasks.every((task) => " xX".includes(content[task.offset])));
  assert.equal(tasks[0].heading, "Follow-ups");
  assert.equal(tasks[0].line, 5);
  assert.deepEqual(extractTasks("<!-- topical:tasks off -->\n\n- [ ] Runbook procedure\n"), []);
  assert.equal(extractTasks("```\n<!-- topical:tasks off -->\n```\n\n- [ ] Real task\n").length, 1);
});

test("parent links respect real Markdown sections and leave code examples intact", () => {
  const example = "# Parent\n\n```md\n## Active work\n```\n";
  assert.equal(linkWork(example, "- [Issue](issues/a/context.md)"), example.trimEnd() + "\n\n## Active work\n\n- [Issue](issues/a/context.md)\n");
  const parent = "## Active work\n\n- Existing\n\n## Decisions\n\nKeep this.\n";
  assert.match(linkWork(parent, "- New"), /- Existing\n- New\n\n## Decisions\n\nKeep this/);
});

test("global tasks page without reading source, preserve duplicates and scope to path boundaries", async (t) => {
  const { store, root, topic } = await fixture(t);
  await store.createTopicFile({ topic, filePath: "issues/a/context.md", content: "# Action\n- [ ] Same text\n- [ ] Same text\n- [x] Done\n", description });
  await store.createTopicFile({ topic, filePath: "issues/ab/context.md", content: "- [ ] Neighbor\n", description });
  await store.createTopic({ title: "Other topic", initialContent: "- [ ] Other\n", description });
  const first = await store.listTasks({ topic, pathPrefix: "issues/a", limit: 1 });
  assert.deepEqual(first.counts, { total: 3, completed: 1, topics: 1, open: 2 });
  const second = await store.listTasks({ topic, pathPrefix: "issues/a", limit: 1, cursor: first.page.nextCursor });
  assert.notEqual(first.tasks[0].offset, second.tasks[0].offset);
  assert.equal(second.page.nextCursor, null);
  await assert.rejects(store.listTasks({ topic, pathPrefix: "issues/ab", cursor: first.page.nextCursor }), { code: "INVALID_CURSOR" });
  const cache = path.join(root, ".topical-cache/search.sqlite");
  const before = await readFile(cache);
  // Direct deletion stays in the projection until reindex, proving reads use the index.
  await unlink(path.join(root, topic, "issues/ab/context.md"));
  assert.equal((await store.listTasks()).counts.open, 4);
  assert.deepEqual(await readFile(cache), before);
  await store.reindex();
  assert.equal((await store.listTasks()).counts.open, 3);
  const catalogue = await readFile(path.join(root, topic, "index.json"), "utf8");
  assert.ok(!catalogue.includes('"tasks"'), "task projection must not duplicate into catalogues");
});

test("completion targets the exact checkbox, rejects stale files, and survives delete/restore/rebuild", async (t) => {
  const { store, root, topic } = await fixture(t);
  const filePath = "issues/example.md";
  await store.createTopicFile({ topic, filePath, content: "# Work\n\n- [ ] Duplicate\n- [ ] Duplicate\n", description });
  const [first, second] = (await store.listTasks()).tasks;
  await store.setTaskCompleted({ topic, filePath, offset: second.offset, completed: true, expectedHash: second.sourceHash, description });
  const content = await store.readTopicFile({ topic, filePath });
  assert.match(content.content, /- \[ \] Duplicate\n- \[x\] Duplicate/);
  await assert.rejects(store.setTaskCompleted({ topic, filePath, offset: first.offset, completed: true, expectedHash: first.sourceHash, description }), { code: "CONFLICT" });
  await assert.rejects(store.setTaskCompleted({ topic, filePath, offset: 0, completed: true, expectedHash: content.hash, description }), /no longer exists/);
  const deleted = await store.deleteTopicFile({ topic, filePath, expectedHash: content.hash, confirm: true, description });
  assert.equal((await store.listTasks()).counts.total, 0);
  await store.restoreTrash({ id: deleted.trash.id, expectedHash: content.hash, description });
  assert.equal((await store.listTasks()).counts.total, 2);
  await writeFile(path.join(root, topic, filePath), content.content + "- [ ] External\n");
  assert.equal((await store.listTasks()).counts.total, 2);
  await store.reindex();
  assert.equal((await store.listTasks()).counts.total, 3);
  await store.close();
  await unlink(path.join(root, ".topical-cache/search.sqlite"));
  await store.initialize();
  assert.equal((await store.listTasks()).counts.total, 3);
});

test("work creation links context, retries safely, excludes drafts, and guards existing content", async (t) => {
  const { store, topic } = await fixture(t);
  const root = await store.readTopicFile({ topic });
  const input = { topic, kind: "issue", slug: "inc-042", title: "API timeouts", brief: "Intermittent failures.", expectedHash: root.hash, description };
  const created = await store.createWorkArea(input);
  assert.equal(created.path, "issues/inc-042/context.md");
  assert.equal((await store.createWorkArea(input)).reused, true);
  const parent = await store.readTopicFile({ topic });
  assert.equal(parent.content.split("[API timeouts]").length, 2);
  await assert.rejects(store.createWorkArea({ ...input, slug: "../escape" }), /slug/);
  await assert.rejects(store.createWorkArea({ ...input, slug: "another" }), { code: "CONFLICT" });
  const issue = await store.readTopicFile({ topic, filePath: created.path });
  const draft = await store.createWorkArea({ topic, kind: "draft", slug: "runbook", title: "Recovery runbook", brief: "- [ ] Reusable procedure", parentFile: created.path, expectedHash: issue.hash, description });
  assert.equal(draft.path, "issues/inc-042/drafts/runbook.md");
  assert.equal((await store.listTasks()).counts.total, 0);
  const updated = await store.readTopicFile({ topic, filePath: created.path });
  await store.updateTopicFile({ topic, filePath: created.path, expectedHash: updated.hash, content: "- [ ] Review the runbook", description });
  assert.equal((await store.listTasks()).tasks[0].path, created.path);
  await assert.rejects(store.createWorkArea(input), { code: "CONFLICT" });
});

test("a concurrent parent edit leaves recoverable work and retry preserves both changes", async (t) => {
  const { store, root, topic } = await fixture(t);
  const parent = await store.readTopicFile({ topic });
  const read = store.readTopicFile.bind(store);
  let reads = 0;
  store.readTopicFile = async (input) => {
    if (input.filePath === "context.md" && ++reads === 2) {
      await writeFile(path.join(root, topic, "context.md"), parent.content + "\nExternal decision preserved.\n");
    }
    return read(input);
  };
  const input = { topic, kind: "plan", slug: "resilience", title: "Resilience", expectedHash: parent.hash, description };
  await assert.rejects(store.createWorkArea(input), { code: "PARTIAL_WORKFLOW" });
  store.readTopicFile = read;
  const created = await read({ topic, filePath: "plans/resilience/context.md" });
  assert.match(created.content, /Resilience/);
  const current = await read({ topic });
  assert.match(current.content, /External decision preserved/);
  assert.ok(!current.content.includes("[Resilience]"));
  await store.createWorkArea({ ...input, expectedHash: current.hash });
  const finished = await read({ topic });
  assert.match(finished.content, /External decision preserved/);
  assert.equal(finished.content.split("[Resilience]").length, 2);
});
