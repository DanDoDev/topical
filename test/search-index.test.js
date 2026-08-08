import assert from "node:assert/strict";
import test from "node:test";

import { assertSearchIndex, queryWithRelaxedFallback, SEARCH_MATCH_MODE } from "../src/search-index.js";
import { RELAXED_RELEVANCE_CASE, RELEVANCE_DOCUMENTS, STRICT_RELEVANCE_CASES } from "./fixtures/relevance.js";
import { ReferenceSearchIndex } from "./support/reference-search-index.js";

async function populatedIndex() {
  const index = new ReferenceSearchIndex();
  await index.rebuild({ documents: RELEVANCE_DOCUMENTS });
  return index;
}

test("SearchIndex requires rebuild, replace, remove, query, health, and close operations", () => {
  assert.throws(() => assertSearchIndex({ query() {} }), /missing rebuild/);
  assert.doesNotThrow(() => assertSearchIndex(new ReferenceSearchIndex()));
});

test("representative English and French queries return topic-grouped strict results", async () => {
  const index = await populatedIndex();
  for (const relevanceCase of STRICT_RELEVANCE_CASES) {
    const result = await queryWithRelaxedFallback(index, { query: relevanceCase.query, limit: 10 });
    assert.equal(result.matchMode, SEARCH_MATCH_MODE.STRICT, relevanceCase.query);
    assert.equal(result.topics[0]?.topic, relevanceCase.first, relevanceCase.query);
    assert.deepEqual(new Set(result.topics.map((topic) => topic.topic)), new Set(relevanceCase.topics), relevanceCase.query);
    assert.equal(result.topics.length, new Set(result.topics.map((topic) => topic.topic)).size, relevanceCase.query);
  }
});

test("relaxed fallback runs only after an empty strict pass and is clearly marked", async () => {
  const index = await populatedIndex();
  const result = await queryWithRelaxedFallback(index, { query: RELAXED_RELEVANCE_CASE.query, limit: 10 });
  assert.equal(result.matchMode, SEARCH_MATCH_MODE.RELAXED);
  assert.deepEqual(new Set(result.topics.map((topic) => topic.topic)), new Set(RELAXED_RELEVANCE_CASE.topics));

  const calls = [];
  const strictHit = {
    rebuild() {}, replace() {}, remove() {}, health() {}, close() {},
    query({ matchMode }) {
      calls.push(matchMode);
      return [{ topic: "atlas-retrieval" }];
    }
  };
  const strictResult = await queryWithRelaxedFallback(strictHit, { query: "retrieval architecture" });
  assert.equal(strictResult.matchMode, SEARCH_MATCH_MODE.STRICT);
  assert.deepEqual(calls, [SEARCH_MATCH_MODE.STRICT]);
});

test("the grouped result contract rejects duplicate topic rows", async () => {
  const duplicateIndex = {
    rebuild() {}, replace() {}, remove() {}, health() {}, close() {},
    query() { return [{ topic: "atlas-retrieval" }, { topic: "atlas-retrieval" }]; }
  };
  await assert.rejects(
    () => queryWithRelaxedFallback(duplicateIndex, { query: "retrieval" }),
    /more than once/
  );
});
