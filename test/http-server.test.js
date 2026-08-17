import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TopicalApplication } from "../src/application.js";
import { createHttpServer } from "../src/http-server.js";

const host = "127.0.0.1:41731";
const origin = `http://${host}`;

async function createServer({ serveUi = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-http-test-"));
  const application = new TopicalApplication({ root });
  await application.initialize();
  const instance = createHttpServer({ application, csrfToken: "test-token", serveUi });
  return { ...instance, application, root };
}

function headers(extra = {}) {
  return { host, origin, "sec-fetch-site": "same-origin", "x-topical-csrf": "test-token", ...extra };
}

test("HTTP bootstrap is loopback-only and exposes a per-run mutation token", async (t) => {
  const { server, application } = await createServer();
  t.after(async () => { await server.close(); await application.close(); });

  const denied = await server.inject({ method: "GET", url: "/api/v1/bootstrap", headers: { host: "attacker.example" } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "LOCAL_ONLY");

  const response = await server.inject({ method: "GET", url: "/api/v1/bootstrap", headers: { host } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().csrfToken, "test-token");
  assert.match(response.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("HTTP mutations require exact origin, JSON, and the CSRF token", async (t) => {
  const { server, application } = await createServer();
  t.after(async () => { await server.close(); await application.close(); });
  const payload = { title: "Local UI", summary: "", tags: [], initialContent: "", description: "Created from the local UI." };

  const missingOrigin = await server.inject({ method: "POST", url: "/api/v1/topics", headers: { host, "content-type": "application/json", "x-topical-csrf": "test-token" }, payload });
  assert.equal(missingOrigin.statusCode, 403);
  assert.equal(missingOrigin.json().error.code, "ORIGIN_REJECTED");

  const wrongType = await server.inject({ method: "POST", url: "/api/v1/topics", headers: headers({ "content-type": "text/plain" }), payload: JSON.stringify(payload) });
  assert.equal(wrongType.statusCode, 415);

  const wrongToken = await server.inject({ method: "POST", url: "/api/v1/topics", headers: headers({ "content-type": "application/json", "x-topical-csrf": "wrong" }), payload });
  assert.equal(wrongToken.statusCode, 403);
  assert.equal(wrongToken.json().error.code, "CSRF_REJECTED");

  const topics = await application.listTopics();
  assert.equal(topics.topics.length, 0, "rejected requests must not mutate the store");
});

test("HTTP routes preserve application results, audit descriptions, and conflicts", async (t) => {
  const { server, application } = await createServer();
  t.after(async () => { await server.close(); await application.close(); });

  const created = await server.inject({
    method: "POST",
    url: "/api/v1/topics",
    headers: headers({ "content-type": "application/json" }),
    payload: { title: "Local UI", summary: "Browser management", tags: ["ui"], initialContent: "# Draft\n\nSafe editing.", description: "Created from the local UI." }
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().topic, "local-ui");

  const file = await server.inject({ method: "GET", url: "/api/v1/topic-file?topic=local-ui&path=context.md", headers: { host } });
  assert.equal(file.statusCode, 200);
  const current = file.json();

  const updated = await server.inject({
    method: "PATCH",
    url: "/api/v1/topic-file",
    headers: headers({ "content-type": "application/json" }),
    payload: { topic: "local-ui", filePath: "context.md", mode: "replace", content: current.content.replace("Safe editing.", "Conflict-safe editing."), expectedHash: current.hash, description: "Updated through the browser editor." }
  });
  assert.equal(updated.statusCode, 200);

  const conflict = await server.inject({
    method: "PATCH",
    url: "/api/v1/topic-file",
    headers: headers({ "content-type": "application/json" }),
    payload: { topic: "local-ui", filePath: "context.md", mode: "replace", content: current.content, expectedHash: current.hash, description: "Tried to save a stale browser draft." }
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "CONFLICT");

  const history = await server.inject({ method: "GET", url: "/api/v1/history?topic=local-ui", headers: { host } });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().events[0].description, "Updated through the browser editor.");
});

test("HTTP revision and topic reads notice mutations from another application", async (t) => {
  const { server, application, root } = await createServer();
  const writer = new TopicalApplication({ root });
  await writer.initialize();
  t.after(async () => { await server.close(); await application.close(); await writer.close(); });

  const before = await server.inject({ method: "GET", url: "/api/v1/revision", headers: { host } });
  await writer.createTopic({
    title: "External HTTP Topic",
    initialContent: "# Live\n\nAppears without restarting the UI server.",
    description: "Created through a second application instance."
  });
  const after = await server.inject({ method: "GET", url: "/api/v1/revision", headers: { host } });
  const topics = await server.inject({ method: "GET", url: "/api/v1/topics", headers: { host } });

  assert.notEqual(after.json().revision, before.json().revision);
  assert.ok(topics.json().topics.some((topic) => topic.id === "external-http-topic"));
});

test("HTTP route validation is bounded and hides unexpected internals", async (t) => {
  const { server, application } = await createServer();
  t.after(async () => { await server.close(); await application.close(); });

  const invalid = await server.inject({ method: "GET", url: "/api/v1/topics?limit=1000", headers: { host } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "VALIDATION_ERROR");

  const missing = await server.inject({ method: "GET", url: "/api/v1/topics/missing/overview", headers: { host } });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "TOPICAL_ERROR");
});

test("HTTP soft deletion and restoration remain hash-reviewed and recoverable", async (t) => {
  const { server, application } = await createServer();
  t.after(async () => { await server.close(); await application.close(); });
  await application.createTopic({ title: "Recovery", initialContent: "# Recover me", description: "Created the recovery fixture." });
  const context = await application.readTopicFile({ topic: "recovery" });

  const deleted = await server.inject({
    method: "DELETE",
    url: "/api/v1/topic",
    headers: headers({ "content-type": "application/json" }),
    payload: { topic: "recovery", expectedHash: context.hash, description: "Moved the fixture to recoverable trash." }
  });
  assert.equal(deleted.statusCode, 200);
  const trash = await server.inject({ method: "GET", url: "/api/v1/trash", headers: { host } });
  assert.equal(trash.json().entries.length, 1);

  const entry = trash.json().entries[0];
  const restored = await server.inject({
    method: "POST",
    url: `/api/v1/trash/${entry.id}/restore`,
    headers: headers({ "content-type": "application/json" }),
    payload: { expectedHash: entry.hash, description: "Restored the reviewed recovery fixture." }
  });
  assert.equal(restored.statusCode, 200);
  assert.match((await application.readTopicFile({ topic: "recovery" })).content, /Recover me/);
});

test("bundled static serving does not expose files outside ui-dist", async (t) => {
  const { server, application } = await createServer({ serveUi: true });
  t.after(async () => { await server.close(); await application.close(); });

  const index = await server.inject({ method: "GET", url: "/", headers: { host } });
  assert.equal(index.statusCode, 200);
  assert.match(index.body, /<title>Topical<\/title>/);

  for (const url of ["/assets/%2e%2e/%2e%2e/package.json", "/assets/..%2f..%2fpackage.json", "/.git/config"]) {
    const response = await server.inject({ method: "GET", url, headers: { host } });
    assert.doesNotMatch(response.body, /"name"\s*:\s*"topical-mcp"|\[core\]/);
  }
});
