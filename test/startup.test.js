import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runDoctor } from "../src/doctor.js";
import { formatNodeVersionError, formatStartupError, nodeMajor, supportsNode } from "../src/startup.js";
import { TopicalStore } from "../src/store.js";

test("the dependency-free startup guard gives an actionable Node 24 recovery", () => {
  assert.equal(nodeMajor("v20.19.0"), 20);
  assert.equal(supportsNode("v20.19.0"), false);
  assert.equal(supportsNode("v24.18.0"), true);
  const message = formatNodeVersionError("v20.19.0");
  assert.match(message, /Node\.js 24\.x is required; found v20\.19\.0/);
  assert.match(message, /npm ci/);
  assert.match(message, /nvm which 24/);
  assert.match(message, /workspace folder does not change the MCP runtime/);
});

test("startup failures explain dependency and configuration recovery", () => {
  const nativeError = Object.assign(new Error("better_sqlite3.node uses a different NODE_MODULE_VERSION"), { code: "ERR_DLOPEN_FAILED" });
  assert.match(formatStartupError(nativeError), /activate Node 24, run `npm ci`/);
  assert.match(formatStartupError(new Error("TOPICAL_ROOT is required.")), /set TOPICAL_ROOT/);
  assert.match(formatStartupError(new Error("The installed SQLite binding does not include FTS5.")), /FTS5-enabled better-sqlite3/);
});

test("startup failures explain how to recover from a busy UI port", () => {
  const message = formatStartupError(Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:2223"), { code: "EADDRINUSE" }));
  assert.match(message, /topical ui --port <number>/);
});

test("doctor validates a healthy configuration without mutating its root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = { entries: await readdir(root), modified: (await stat(root)).mtimeMs };

  const report = await runDoctor({ cwd: root, env: { TOPICAL_ROOT: root } });

  const after = { entries: await readdir(root), modified: (await stat(root)).mtimeMs };
  assert.equal(report.ok, true);
  assert.deepEqual(after, before);
  assert.equal(report.checks.find((entry) => entry.name === "Node.js")?.status, "pass");
  assert.equal(report.checks.find((entry) => entry.name === "SQLite FTS5")?.status, "pass");
  assert.match(report.checks.find((entry) => entry.name === "Search cache")?.message || "", /No cache exists/);
});

test("doctor reports a missing root as a fixable configuration failure", async () => {
  const report = await runDoctor({ cwd: os.tmpdir(), env: {} });
  assert.equal(report.ok, false);
  const root = report.checks.find((entry) => entry.name === "TOPICAL_ROOT");
  assert.equal(root?.status, "fail");
  assert.match(root?.fix || "", /MCP server environment/);
});

test("doctor leaves an existing SQLite cache byte-for-byte unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-doctor-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TopicalStore(root);
  await store.initialize();
  await store.close();
  const cachePath = path.join(root, ".topical-cache", "search.sqlite");
  const before = { content: await readFile(cachePath), modified: (await stat(cachePath)).mtimeMs };

  const report = await runDoctor({ cwd: root, env: { TOPICAL_ROOT: root } });

  const after = { content: await readFile(cachePath), modified: (await stat(cachePath)).mtimeMs };
  assert.equal(report.ok, true);
  assert.equal(Buffer.compare(after.content, before.content), 0);
  assert.equal(after.modified, before.modified);
});
