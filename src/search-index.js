export const SEARCH_MATCH_MODE = Object.freeze({
  STRICT: "strict",
  RELAXED: "relaxed"
});

const REQUIRED_METHODS = ["rebuild", "replace", "remove", "query", "health", "close"];

/**
 * Internal boundary for Topical's disposable search representation.
 *
 * Implementations own only derived data. Markdown and the topic catalogue remain
 * authoritative, and callers must be able to discard and rebuild an implementation.
 */
export class SearchIndex {
  async rebuild(_snapshot) { throw new Error("SearchIndex.rebuild is not implemented."); }
  async replace(_change) { throw new Error("SearchIndex.replace is not implemented."); }
  async remove(_selection) { throw new Error("SearchIndex.remove is not implemented."); }
  async query(_request) { throw new Error("SearchIndex.query is not implemented."); }
  async health() { throw new Error("SearchIndex.health is not implemented."); }
  async close() { throw new Error("SearchIndex.close is not implemented."); }
}

export function assertSearchIndex(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("SearchIndex implementation must be an object.");
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof candidate[method] !== "function") {
      throw new TypeError(`SearchIndex implementation is missing ${method}().`);
    }
  }
  return candidate;
}

function assertTopicGroupedResults(results) {
  if (!Array.isArray(results)) throw new TypeError("SearchIndex.query must return an array.");
  const seen = new Set();
  for (const result of results) {
    if (!result || typeof result.topic !== "string" || !result.topic) {
      throw new TypeError("Each search result must identify one topic.");
    }
    if (seen.has(result.topic)) {
      throw new TypeError(`SearchIndex.query returned topic '${result.topic}' more than once.`);
    }
    seen.add(result.topic);
  }
  return results;
}

/**
 * Run the contract-level strict-first policy without binding Topical to an engine.
 * Relaxation is visible in the response and happens only after an empty strict pass.
 */
export async function queryWithRelaxedFallback(searchIndex, request) {
  const index = assertSearchIndex(searchIndex);
  const strictTopics = assertTopicGroupedResults(await index.query({
    ...request,
    matchMode: SEARCH_MATCH_MODE.STRICT
  }));
  if (strictTopics.length) {
    return { matchMode: SEARCH_MATCH_MODE.STRICT, topics: strictTopics };
  }

  const relaxedTopics = assertTopicGroupedResults(await index.query({
    ...request,
    matchMode: SEARCH_MATCH_MODE.RELAXED
  }));
  return { matchMode: SEARCH_MATCH_MODE.RELAXED, topics: relaxedTopics };
}
