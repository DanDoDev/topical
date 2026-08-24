import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { DEFAULT_UI_PORT } from "../src/config.js";

const run = promisify(execFile);
const entry = path.resolve("src/server.js");

test("CLI documents MCP, doctor, and loopback UI commands", async () => {
  const { stdout, stderr } = await run(process.execPath, [entry, "--help"]);
  assert.equal(stderr, "");
  assert.match(stdout, /topical \[mcp\|ui\|doctor\|prepare-v0\.5-rollback\]/);
  assert.match(stdout, /ui \[--port <number>\] \[--no-open\]/);
  assert.match(stdout, /default port: 2223/);
  assert.equal(DEFAULT_UI_PORT, 2223);
});

test("CLI requires explicit confirmation before preparing v0.5 rollback catalogues", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-cli-rollback-test-"));
  await assert.rejects(run(process.execPath, [entry, "prepare-v0.5-rollback", "--json"], { env: { ...process.env, TOPICAL_ROOT: root } }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Set confirm to true/);
    return true;
  });
  const { stdout } = await run(process.execPath, [entry, "prepare-v0.5-rollback", "--confirm", "--json"], { env: { ...process.env, TOPICAL_ROOT: root } });
  assert.equal(JSON.parse(stdout).status, "ready_for_v0.5");
});

test("CLI rejects invalid UI ports before initializing the store", async () => {
  await assert.rejects(run(process.execPath, [entry, "ui", "--port", "outside"]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /--port must be an integer/);
    return true;
  });
});

test("CLI accepts the explicit mcp command", async () => {
  await assert.rejects(run(process.execPath, [entry, "mcp"], { env: { ...process.env, TOPICAL_ROOT: "" } }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /TOPICAL_ROOT is required/);
    assert.doesNotMatch(error.stderr, /unsupported arguments/);
    return true;
  });
});
