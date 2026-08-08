import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

export async function auditLegacyIndexes(root) {
  const rootIndexPath = path.join(root, "index.json");
  const rootIndex = await readJson(rootIndexPath);
  const rootBytes = (await stat(rootIndexPath)).size;
  const rootTerms = (rootIndex.documents || []).flatMap((document) => document.terms || []);
  const tagUsage = new Map();
  for (const topic of rootIndex.topics || []) {
    for (const tag of topic.tags || []) {
      const canonical = String(tag).normalize("NFKC").toLowerCase();
      tagUsage.set(canonical, (tagUsage.get(canonical) || 0) + 1);
    }
  }

  let topicIndexBytes = 0;
  let searchCacheBytes = 0;
  let topicDocumentCount = 0;
  let topicTermEntries = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const topicIndexPath = path.join(root, entry.name, "index.json");
    try {
      const topicIndex = await readJson(topicIndexPath);
      topicIndexBytes += (await stat(topicIndexPath)).size;
      topicDocumentCount += (topicIndex.documents || []).length;
      topicTermEntries += (topicIndex.documents || [])
        .reduce((sum, document) => sum + (document.terms || []).length, 0);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    searchCacheBytes = (await stat(path.join(root, ".topical-cache", "search.sqlite"))).size;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const uniqueTerms = new Set(rootTerms).size;
  return {
    topics: (rootIndex.topics || []).length,
    rootDocuments: (rootIndex.documents || []).length,
    topicDocuments: topicDocumentCount,
    rootTermEntries: rootTerms.length,
    topicTermEntries,
    totalStoredTermEntries: rootTerms.length + topicTermEntries,
    globallyUniqueTerms: uniqueTerms,
    repeatedRootTermEntries: Math.max(0, rootTerms.length - uniqueTerms),
    repeatedRootTermPercent: rootTerms.length ? Number((((rootTerms.length - uniqueTerms) / rootTerms.length) * 100).toFixed(1)) : 0,
    duplicatedTermCopiesAcrossIndexes: Math.min(rootTerms.length, topicTermEntries),
    indexBytes: {
      root: rootBytes,
      topics: topicIndexBytes,
      searchCache: searchCacheBytes,
      total: rootBytes + topicIndexBytes + searchCacheBytes
    },
    tags: {
      assignments: [...tagUsage.values()].reduce((sum, count) => sum + count, 0),
      unique: tagUsage.size,
      singleton: [...tagUsage.values()].filter((count) => count === 1).length,
      usage: [...tagUsage.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    }
  };
}
