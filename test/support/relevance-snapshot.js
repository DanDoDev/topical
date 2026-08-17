import { RELEVANCE_DOCUMENTS } from "../fixtures/relevance.js";

export function relevanceSnapshot(documents = RELEVANCE_DOCUMENTS) {
  const topics = new Map();
  for (const document of documents) {
    const snapshot = topics.get(document.topic) || {
      topic: {
        id: document.topic,
        title: document.title,
        summary: document.summary,
        tags: document.tags,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
        lastAction: null
      },
      documents: []
    };
    snapshot.documents.push({
      path: document.path,
      headings: document.headings,
      excerpt: document.body.slice(0, 360),
      body: document.body,
      hash: "0".repeat(64),
      size: Buffer.byteLength(document.body)
    });
    topics.set(document.topic, snapshot);
  }
  return { topics: [...topics.values()] };
}
