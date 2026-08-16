import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeQuery,
  canonicalTagKey,
  cleanTags,
  comparisonTagKey,
  CONTRACT_LIMITS,
  parseTagArray,
  technicalAliasEntries
} from "../src/normalization.js";

test("canonical tag identity preserves semantics while advisory comparison finds variants", () => {
  assert.equal(canonicalTagKey("  Café   Ops  "), "café ops");
  assert.notEqual(canonicalTagKey("café-ops"), canonicalTagKey("cafe_ops"));
  assert.equal(comparisonTagKey("café-ops"), comparisonTagKey("CAFE_ops"));
  assert.deepEqual(cleanTags([" Café Ops ", "café   ops", "cafe ops"]), ["Café Ops", "cafe ops"]);
});

test("Topical JSON tag arrays preserve commas and legacy arrays remain readable", () => {
  assert.deepEqual(parseTagArray('["alpha, beta", "gamma"]'), ["alpha, beta", "gamma"]);
  assert.deepEqual(parseTagArray("[alpha, beta]"), ["alpha", "beta"]);
});

test("query analysis reports duplicate and capped terms instead of silently discarding them", () => {
  const distinct = Array.from({ length: CONTRACT_LIMITS.queryTerms + 1 }, (_, index) => `term${index + 1}`);
  const analysis = analyzeQuery(`${distinct.join(" ")} TERM1`);
  assert.equal(analysis.terms.length, CONTRACT_LIMITS.queryTerms);
  assert.deepEqual(analysis.ignoredTerms.map((entry) => entry.reason), ["term_limit", "duplicate"]);
  assert.equal(analysis.ignoredTerms[0].term, `term${CONTRACT_LIMITS.queryTerms + 1}`);
});

test("technical aliases separate camel case and join punctuated identifiers", () => {
  const aliases = technicalAliasEntries("expectedHash runs on Node.js with snake_case");
  assert.ok(aliases.some((entry) => entry.source === "expectedHash" && entry.alias === "expected hash"));
  assert.ok(aliases.some((entry) => entry.source === "Node.js" && entry.alias === "nodejs"));
  assert.ok(aliases.some((entry) => entry.source === "snake_case" && entry.alias === "snake case"));
});
