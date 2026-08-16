import { SearchIndex, SEARCH_MATCH_MODE } from "../../src/search-index.js";
import { analyzeQuery, canonicalTagKey, normalizeSearchText } from "../../src/normalization.js";

function searchableText(document) {
  return normalizeSearchText([
    document.title,
    document.summary,
    ...(document.tags || []),
    document.path,
    ...(document.headings || []),
    document.body
  ].join("\n"));
}

export class ReferenceSearchIndex extends SearchIndex {
  #documents = [];
  #closed = false;

  async rebuild({ documents }) {
    this.#documents = documents.map((document) => ({ ...document }));
  }

  async replace({ topic, documents }) {
    this.#documents = this.#documents.filter((document) => document.topic !== topic)
      .concat(documents.map((document) => ({ ...document })));
  }

  async remove({ topic, paths }) {
    const removedPaths = paths ? new Set(paths) : null;
    this.#documents = this.#documents.filter((document) => (
      document.topic !== topic || (removedPaths && !removedPaths.has(document.path))
    ));
  }

  async query({ query, analysis, tags = [], limit = 10, matchMode = SEARCH_MATCH_MODE.STRICT }) {
    if (this.#closed) throw new Error("Reference search index is closed.");
    const queryTerms = (analysis || analyzeQuery(query)).terms.map((term) => term.normalized);
    const wantedTags = tags.map(canonicalTagKey);
    const byTopic = new Map();
    for (const document of this.#documents) {
      if (!wantedTags.every((tag) => (document.tags || []).map(canonicalTagKey).includes(tag))) continue;
      const text = searchableText(document);
      const matchedTerms = queryTerms.filter((term) => text.includes(term));
      if (!matchedTerms.length && queryTerms.length) continue;
      const entry = byTopic.get(document.topic) || {
        topic: document.topic,
        title: document.title,
        matchedTerms: new Set(),
        files: [],
        score: 0
      };
      matchedTerms.forEach((term) => entry.matchedTerms.add(term));
      const phrase = normalizeSearchText(query);
      const phraseBoost = phrase && text.includes(phrase) ? 25 : 0;
      const titleBoost = phrase && normalizeSearchText(document.title).includes(phrase) ? 30 : 0;
      entry.score += matchedTerms.length * 5 + phraseBoost + titleBoost;
      entry.files.push({ path: document.path, matchedTerms });
      byTopic.set(document.topic, entry);
    }

    const results = [...byTopic.values()]
      .filter((entry) => matchMode === SEARCH_MATCH_MODE.RELAXED || queryTerms.every((term) => entry.matchedTerms.has(term)))
      .map((entry) => ({
        ...entry,
        matchedTerms: [...entry.matchedTerms],
        files: entry.files.slice(0, 3)
      }))
      .sort((left, right) => right.score - left.score || left.topic.localeCompare(right.topic));
    return results.slice(0, limit);
  }

  async health() {
    return { status: this.#closed ? "closed" : "ready", documents: this.#documents.length };
  }

  async close() {
    this.#closed = true;
  }
}
