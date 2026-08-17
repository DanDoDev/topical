import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimePreflight } from "../src/runtime-preflight.js";

test("runtime preflight accepts the supported Node major without output", () => {
  let output = "";

  const supported = runRuntimePreflight({
    version: "v24.18.0",
    stderr: { write: (value) => { output += value; } }
  });

  assert.equal(supported, true);
  assert.equal(output, "");
});

test("runtime preflight rejects an unsupported Node before native imports", () => {
  let output = "";

  const supported = runRuntimePreflight({
    version: "v20.19.0",
    stderr: { write: (value) => { output += value; } }
  });

  assert.equal(supported, false);
  assert.match(output, /Node\.js 24\.x is required; found v20\.19\.0/);
  assert.match(output, /npm ci/);
  assert.match(output, /npm install --global \.\/topical-mcp-\*\.tgz --omit=dev/);
  assert.match(output, /nvm which 24/);
});
