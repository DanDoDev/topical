import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { conflictError, TopicalError } from "./errors.js";
import {
  analyzeQuery,
  assertBoundedText,
  assertDescription,
  assertMarkdown,
  boundedEditDistance,
  canonicalTagKey,
  cleanTags,
  comparisonTagKey,
  CONTRACT_LIMITS,
  normalizeSearchText,
  normalizedSearchView,
  parseTagArray,
  queryAnalysisResponse,
  technicalAliasEntries
} from "./normalization.js";
import { paginate } from "./pagination.js";
import { queryWithRelaxedFallback } from "./search-index.js";
import { SqliteSearchIndex } from "./sqlite-search-index.js";

const ROOT_INDEX_VERSION = 3;
const TOPIC_INDEX_VERSION = 4;
const TRASH_MANIFEST_VERSION = 1;
const MAX_RECENT_ACTIONS = 100;
const DEFAULT_OVERVIEW_CHARS = 6_000;

export { TopicalError } from "./errors.js";

const now = () => new Date().toISOString();
const hash = (value) => createHash("sha256").update(value).digest("hex");

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new TopicalError("Topic title must contain at least one letter or number.");
  return slug;
}

function assertTopicId(topic) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)) {
    throw new TopicalError("Topic must be a lowercase slug, such as 'hue-lighting-effects'.");
  }
}

function assertMarkdownPath(filePath, { allowContext = true } = {}) {
  if (typeof filePath !== "string" || !filePath.endsWith(".md")) {
    throw new TopicalError("Topic files must be Markdown paths ending in .md.");
  }
  if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..") || filePath.includes("\\")) {
    throw new TopicalError("File path must be a safe relative path inside the topic.");
  }
  const normalized = path.posix.normalize(filePath);
  if (normalized === "." || normalized.startsWith("../")) {
    throw new TopicalError("File path must stay inside the topic.");
  }
  if (!allowContext && normalized === "context.md") {
    throw new TopicalError("context.md is required and cannot be deleted.");
  }
  return normalized;
}

function assertExpectedHash(expectedHash, currentHash, details) {
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new TopicalError("expectedHash is required and must be a SHA-256 hash.", {
      code: "INVALID_INPUT",
      details: { field: "expectedHash" }
    });
  }
  if (expectedHash !== currentHash) {
    throw conflictError("The reviewed content changed. Read it again before continuing.", {
      ...details,
      expectedHash,
      currentHash
    });
  }
}

function toYamlScalar(value) {
  return JSON.stringify(String(value).replace(/[\r\n]+/g, " ").trim());
}

function formatContext({ title, summary, tags, createdAt, updatedAt }, body = "") {
  const tagText = tags.map((tag) => JSON.stringify(tag)).join(", ");
  return `---\ntitle: ${toYamlScalar(title)}\nsummary: ${toYamlScalar(summary)}\ntags: [${tagText}]\ncreated_at: ${createdAt}\nupdated_at: ${updatedAt}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try { return JSON.parse(trimmed); } catch { /* use literal below */ }
  }
  return trimmed;
}

function parseFrontmatter(markdown, fallback = {}) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { metadata: { ...fallback }, body: markdown };
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    values[line.slice(0, separator).trim()] = parseScalar(line.slice(separator + 1));
  }
  const tags = parseTagArray(values.tags);
  return {
    metadata: {
      title: values.title || fallback.title,
      summary: values.summary || fallback.summary || "",
      tags: Array.isArray(tags) ? tags : [],
      createdAt: values.created_at || fallback.createdAt,
      updatedAt: values.updated_at || fallback.updatedAt
    },
    body: match[2]
  };
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function assertSafeFilesystemPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new TopicalError("Filesystem path must stay inside TOPICAL_ROOT.");
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) throw new TopicalError("Symbolic links are not permitted inside TOPICAL_ROOT.");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function readJson(target, fallback) {
  try { return JSON.parse(await readFile(target, "utf8")); } catch { return fallback; }
}

async function fileStamp(target) {
  const details = await stat(target, { bigint: true });
  return [details.dev, details.ino, details.size, details.mtimeNs].join(":");
}

async function writeAtomic(root, target, content) {
  await assertSafeFilesystemPath(root, target);
  await mkdir(path.dirname(target), { recursive: true });
  await assertSafeFilesystemPath(root, target);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

async function listMarkdownFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (entry.name === "index.json" || entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await listMarkdownFiles(absolute, relative));
    else if (entry.isFile() && entry.name.endsWith(".md")) results.push(relative);
  }
  return results.sort();
}

function updateSection(markdown, section, replacement) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^(#{1,6})\\s+${escaped}\\s*$`, "m");
  const found = heading.exec(markdown);
  if (!found) throw new TopicalError(`Section '${section}' was not found.`);
  const start = found.index + found[0].length;
  const level = found[1].length;
  const after = markdown.slice(start);
  const nextHeading = new RegExp(`^#{1,${level}}\\s+`, "m").exec(after);
  const end = nextHeading ? start + nextHeading.index : markdown.length;
  return `${markdown.slice(0, start)}\n\n${replacement.trim()}\n${markdown.slice(end)}`;
}

function compactText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function bodySnippet(body, matchedTerms, query) {
  const source = compactText(body);
  if (!source) return "";
  const view = normalizedSearchView(source);
  const phrase = normalizeSearchText(query || "").trim();
  const positions = [phrase, ...(matchedTerms || [])]
    .filter(Boolean)
    .map((term) => view.text.indexOf(term))
    .filter((position) => position >= 0);
  const firstMatch = positions.length ? Math.min(...positions) : 0;
  const sourceMatch = view.sourceOffsets[firstMatch] ?? 0;
  const codepointsBefore = Array.from(source.slice(0, sourceMatch)).length;
  const start = Math.max(0, codepointsBefore - 110);
  return Array.from(source).slice(start, start + 320).join("");
}

function explainFileMatch(filePath, body, terms, aliasTerms = []) {
  const normalizedPath = normalizeSearchText(filePath);
  const normalizedHeadings = headingList(body).map(normalizeSearchText);
  const normalizedBody = normalizeSearchText(body);
  const matchedTerms = [];
  const matchedFields = new Set();
  const matchedAliases = [];
  const aliasTermSet = new Set(aliasTerms);
  const aliases = aliasTermSet.size ? technicalAliasEntries([filePath, body].join("\n")) : [];
  for (const term of terms || []) {
    let matched = false;
    if (normalizedPath.includes(term)) { matched = true; matchedFields.add("path"); }
    if (normalizedHeadings.some((heading) => heading.includes(term))) { matched = true; matchedFields.add("headings"); }
    if (normalizedBody.includes(term)) { matched = true; matchedFields.add("body"); }
    for (const alias of aliasTermSet.has(term) ? aliases : []) {
      const aliasTerms = alias.alias.match(/[\p{L}\p{N}]+/gu) || [];
      if (alias.alias === term || aliasTerms.includes(term)) {
        matched = true;
        matchedFields.add("aliases");
        if (!matchedAliases.some((entry) => entry.source === alias.source && entry.alias === alias.alias)) {
          matchedAliases.push(alias);
        }
      }
    }
    if (matched) matchedTerms.push(term);
  }
  return { matchedTerms, matchedFields: [...matchedFields], matchedAliases: matchedAliases.slice(0, 20) };
}

function headingList(markdown) {
  return markdown.split(/\r?\n/)
    .map((line) => line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim())
    .filter(Boolean)
    .slice(0, 80);
}

export class TopicalStore {
  #queue = Promise.resolve();
  #rootIndexCache;
  #rootIndexStamp;
  #rootRefreshPromise;
  #searchIndex;
  #searchIndexIdentity;
  #initialized = false;
  #initializePromise;

  constructor(root) {
    if (!path.isAbsolute(root)) throw new TopicalError("TOPICAL_ROOT must be an absolute path.");
    this.root = path.resolve(root);
  }

  async initialize() {
    if (this.#initialized) return;
    if (this.#initializePromise) return this.#initializePromise;
    this.#initializePromise = this.#initialize();
    try {
      await this.#initializePromise;
    } finally {
      this.#initializePromise = null;
    }
  }

  async #initialize() {
    if (this.root === path.parse(this.root).root || this.root === os.homedir()) {
      throw new TopicalError("TOPICAL_ROOT must be a dedicated directory, not the filesystem or home root.");
    }
    await mkdir(this.root, { recursive: true });
    const rootStats = await lstat(this.root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new TopicalError("TOPICAL_ROOT must be a real directory, not a symbolic link or file.");
    }
    this.root = await realpath(this.root);
    const indexPath = path.join(this.root, "index.json");
    await assertSafeFilesystemPath(this.root, indexPath);
    let rootNeedsRebuild = false;
    if (!await exists(indexPath)) {
      const emptyIndex = { version: ROOT_INDEX_VERSION, updatedAt: now(), topics: [], documents: [], recentActions: [] };
      await writeAtomic(this.root, indexPath, JSON.stringify(emptyIndex, null, 2) + "\n");
      this.#rootIndexCache = emptyIndex;
      this.#rootIndexStamp = await fileStamp(indexPath);
      rootNeedsRebuild = true;
    } else {
      const existingIndex = await readJson(indexPath, null);
      rootNeedsRebuild = !existingIndex || existingIndex.version !== ROOT_INDEX_VERSION;
      if (!rootNeedsRebuild) {
        this.#rootIndexCache = existingIndex;
        this.#rootIndexStamp = await fileStamp(indexPath);
        for (const topic of existingIndex.topics || []) {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic.id)) { rootNeedsRebuild = true; break; }
          const topicIndexPath = path.join(this.root, topic.id, "index.json");
          await assertSafeFilesystemPath(this.root, topicIndexPath);
          const topicIndex = await readJson(topicIndexPath, null);
          if (!topicIndex || topicIndex.version !== TOPIC_INDEX_VERSION) { rootNeedsRebuild = true; break; }
        }
      }
    }
    this.#searchIndex = new SqliteSearchIndex(this.root);
    const searchHealth = await this.#searchIndex.health();
    if (searchHealth.status === "ready") this.#searchIndexIdentity = await this.#currentSearchIdentity();
    this.#initialized = true;
    try {
      if (rootNeedsRebuild || searchHealth.status !== "ready") await this.#reindexUnlocked();
    } catch (error) {
      this.#initialized = false;
      await this.#searchIndex.close();
      throw error;
    }
  }

  async close() {
    await this.#searchIndex?.close();
    this.#initialized = false;
    this.#rootIndexCache = undefined;
    this.#rootIndexStamp = undefined;
    this.#searchIndexIdentity = undefined;
  }

  async #serial(operation) {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #getRootIndex() {
    await this.initialize();
    const indexPath = path.join(this.root, "index.json");
    await assertSafeFilesystemPath(this.root, indexPath);
    const currentStamp = await fileStamp(indexPath);
    if (this.#rootIndexCache && currentStamp === this.#rootIndexStamp) return this.#rootIndexCache;
    if (this.#rootRefreshPromise) return this.#rootRefreshPromise;
    this.#rootRefreshPromise = (async () => {
      const observedStamp = await fileStamp(indexPath);
      if (this.#rootIndexCache && observedStamp === this.#rootIndexStamp) return this.#rootIndexCache;
      const index = await readJson(indexPath, { version: ROOT_INDEX_VERSION, updatedAt: now(), topics: [], documents: [], recentActions: [] });
      index.version = ROOT_INDEX_VERSION;
      index.topics = Array.isArray(index.topics) ? index.topics : [];
      index.documents = Array.isArray(index.documents) ? index.documents : [];
      index.recentActions = Array.isArray(index.recentActions) ? index.recentActions : [];
      const previousStamp = this.#rootIndexStamp;
      this.#rootIndexCache = index;
      this.#rootIndexStamp = observedStamp;
      if (previousStamp && previousStamp !== observedStamp) await this.#refreshSearchIndexIfReplaced();
      return index;
    })();
    try {
      return await this.#rootRefreshPromise;
    } finally {
      this.#rootRefreshPromise = null;
    }
  }

  async #writeRootIndex(index) {
    index.version = ROOT_INDEX_VERSION;
    index.updatedAt = now();
    index.topics = Array.isArray(index.topics) ? index.topics : [];
    index.documents = Array.isArray(index.documents) ? index.documents : [];
    index.recentActions = Array.isArray(index.recentActions) ? index.recentActions : [];
    const indexPath = path.join(this.root, "index.json");
    await writeAtomic(this.root, indexPath, JSON.stringify(index, null, 2) + "\n");
    this.#rootIndexCache = index;
    this.#rootIndexStamp = await fileStamp(indexPath);
    return index;
  }

  async #currentSearchIdentity() {
    try {
      const details = await stat(path.join(this.root, ".topical-cache", "search.sqlite"), { bigint: true });
      return [details.dev, details.ino].join(":");
    } catch {
      return null;
    }
  }

  async #refreshSearchIndexIfReplaced() {
    const identity = await this.#currentSearchIdentity();
    if (!identity || identity === this.#searchIndexIdentity) return;
    const replacement = new SqliteSearchIndex(this.root);
    const health = await replacement.health();
    if (health.status !== "ready") {
      await replacement.close();
      return;
    }
    const previous = this.#searchIndex;
    this.#searchIndex = replacement;
    this.#searchIndexIdentity = identity;
    await previous?.close();
  }

  #topicDirectory(topic) {
    assertTopicId(topic);
    const directory = path.resolve(this.root, topic);
    if (path.dirname(directory) !== this.root) throw new TopicalError("Invalid topic path.");
    return directory;
  }

  async #topicIndex(topic) {
    const directory = this.#topicDirectory(topic);
    await this.#requireTopicDirectory(topic);
    await assertSafeFilesystemPath(this.root, path.join(directory, "index.json"));
    return readJson(path.join(directory, "index.json"), { version: TOPIC_INDEX_VERSION, topic: { id: topic }, files: [], history: [] });
  }

  async #requireTopicDirectory(topic) {
    const directory = this.#topicDirectory(topic);
    await assertSafeFilesystemPath(this.root, directory);
    try {
      const details = await lstat(directory);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new TopicalError(`Topic '${topic}' must be a real directory.`);
    } catch (error) {
      if (error?.code === "ENOENT") throw new TopicalError(`Topic '${topic}' does not exist.`);
      throw error;
    }
    return directory;
  }

  async #buildTopicDocuments(topic, directory, files, metadata) {
    const documents = [];
    for (const filePath of files) {
      const target = path.join(directory, filePath);
      await assertSafeFilesystemPath(this.root, target);
      const content = await readFile(target, "utf8");
      const parsed = parseFrontmatter(content, metadata);
      const body = compactText(parsed.body);
      const headings = headingList(parsed.body);
      documents.push({
        topic,
        path: filePath,
        headings,
        excerpt: body.slice(0, 360),
        size: Buffer.byteLength(content, "utf8"),
        hash: hash(content),
        body
      });
    }
    return documents;
  }

  #topicSummary(topic, metadata, index) {
    const lastAction = index.history?.at(-1);
    return {
      id: topic,
      title: metadata.title || topic,
      summary: metadata.summary || "",
      tags: metadata.tags || [],
      createdAt: metadata.createdAt || null,
      updatedAt: metadata.updatedAt || index.updatedAt || now(),
      fileCount: index.files?.length || 0,
      lastAction: lastAction ? { at: lastAction.at, action: lastAction.action, description: lastAction.description } : null
    };
  }

  async #upsertTopicInRoot(topic) {
    const directory = await this.#requireTopicDirectory(topic);
    const contextPath = path.join(directory, "context.md");
    await assertSafeFilesystemPath(this.root, contextPath);
    const content = await readFile(contextPath, "utf8");
    const metadata = parseFrontmatter(content, { title: topic, summary: "", tags: [] }).metadata;
    const index = await this.#topicIndex(topic);
    const rootIndex = await this.#getRootIndex();
    const summary = this.#topicSummary(topic, metadata, index);
    const lastAction = index.history?.at(-1);
    rootIndex.topics = [...rootIndex.topics.filter((entry) => entry.id !== topic), summary]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    rootIndex.documents = [...rootIndex.documents.filter((document) => document.topic !== topic), ...(index.documents || [])];
    if (lastAction) {
      const event = { topic, ...lastAction };
      rootIndex.recentActions = [event, ...rootIndex.recentActions]
        .filter((candidate, position, all) => all.findIndex((other) => `${other.topic || ""}|${other.at}|${other.action}|${other.path || ""}` === `${candidate.topic || ""}|${candidate.at}|${candidate.action}|${candidate.path || ""}`) === position)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, MAX_RECENT_ACTIONS);
    }
    return this.#writeRootIndex(rootIndex);
  }

  async #removeTopicFromRoot(topic, event) {
    const rootIndex = await this.#getRootIndex();
    rootIndex.topics = rootIndex.topics.filter((entry) => entry.id !== topic);
    rootIndex.documents = rootIndex.documents.filter((document) => document.topic !== topic);
    rootIndex.recentActions = [{ topic, ...event }, ...rootIndex.recentActions]
      .filter((candidate, position, all) => all.findIndex((other) => `${other.topic || ""}|${other.at}|${other.action}|${other.path || ""}` === `${candidate.topic || ""}|${candidate.at}|${candidate.action}|${candidate.path || ""}`) === position)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, MAX_RECENT_ACTIONS);
    return this.#writeRootIndex(rootIndex);
  }

  async #record(topic, action, filePath, description) {
    assertDescription(description);
    const directory = this.#topicDirectory(topic);
    const index = await this.#topicIndex(topic);
    const event = { at: now(), action, path: filePath ?? null, description: description.trim() };
    index.version = TOPIC_INDEX_VERSION;
    index.history = [...(index.history || []), event];
    index.updatedAt = event.at;
    index.files = await listMarkdownFiles(directory);
    const contextPath = path.join(directory, "context.md");
    await assertSafeFilesystemPath(this.root, contextPath);
    const context = await readFile(contextPath, "utf8");
    const metadata = parseFrontmatter(context, { title: topic, summary: "", tags: [] }).metadata;
    index.topic = { id: topic, ...metadata };
    const searchDocuments = await this.#buildTopicDocuments(topic, directory, index.files, metadata);
    index.documents = searchDocuments.map(({ body: _body, ...document }) => document);
    await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify(index, null, 2) + "\n");
    return {
      event,
      searchTopic: {
        topic: this.#topicSummary(topic, metadata, index),
        documents: searchDocuments
      }
    };
  }

  async #reindexUnlocked(rootAction) {
    await this.initialize();
    const rootIndexPath = path.join(this.root, "index.json");
    await assertSafeFilesystemPath(this.root, rootIndexPath);
    const current = await readJson(rootIndexPath, { recentActions: [] });
    const entries = await readdir(this.root, { withFileTypes: true });
    const topics = [];
    const documents = [];
    const searchTopics = [];
    const events = rootAction ? [rootAction] : [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue;
      const topic = entry.name;
      const directory = this.#topicDirectory(topic);
      const contextPath = path.join(directory, "context.md");
      await assertSafeFilesystemPath(this.root, contextPath);
      if (!await exists(contextPath)) continue;
      const content = await readFile(contextPath, "utf8");
      const parsed = parseFrontmatter(content, { title: topic, createdAt: undefined, updatedAt: undefined });
      const index = await this.#topicIndex(topic);
      const files = await listMarkdownFiles(directory);
      index.version = TOPIC_INDEX_VERSION;
      index.topic = { id: topic, ...parsed.metadata };
      index.files = files;
      index.updatedAt = parsed.metadata.updatedAt || index.updatedAt || now();
      index.history = index.history || [];
      const searchDocuments = await this.#buildTopicDocuments(topic, directory, files, parsed.metadata);
      index.documents = searchDocuments.map(({ body: _body, ...document }) => document);
      await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify(index, null, 2) + "\n");
      const lastAction = index.history.at(-1);
      if (lastAction) events.push({ topic, ...lastAction });
      documents.push(...index.documents);
      const topicSummary = this.#topicSummary(topic, parsed.metadata, index);
      topics.push(topicSummary);
      searchTopics.push({ topic: topicSummary, documents: searchDocuments });
    }
    const actions = [...events, ...(current.recentActions || [])]
      .filter((event, index, all) => all.findIndex((candidate) => `${candidate.topic || ""}|${candidate.at}|${candidate.action}|${candidate.path || ""}` === `${event.topic || ""}|${event.at}|${event.action}|${event.path || ""}`) === index)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, MAX_RECENT_ACTIONS);
    topics.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const rootIndex = { version: ROOT_INDEX_VERSION, updatedAt: now(), topics, documents, recentActions: actions };
    await this.#searchIndex.rebuild({ topics: searchTopics });
    this.#searchIndexIdentity = await this.#currentSearchIdentity();
    return this.#writeRootIndex(rootIndex);
  }

  async #replaceSearchTopic(searchTopic) {
    try {
      await this.#searchIndex.replace(searchTopic);
    } catch {
      await this.#reindexUnlocked();
    }
  }

  async #removeSearchTopic(topic) {
    try {
      await this.#searchIndex.remove({ topic });
    } catch {
      await this.#reindexUnlocked();
    }
  }

  #trashDirectory(id) {
    if (!/^[a-f0-9-]{36}$/.test(id || "")) {
      throw new TopicalError("Trash entry ID is invalid.", { code: "INVALID_INPUT", details: { field: "id" } });
    }
    return path.join(this.root, ".trash", id);
  }

  async #writeTrashManifest(container, entry) {
    await assertSafeFilesystemPath(this.root, container);
    await writeAtomic(this.root, path.join(container, "manifest.json"), `${JSON.stringify(entry, null, 2)}\n`);
  }

  async #readTrashEntry(id) {
    const container = this.#trashDirectory(id);
    await assertSafeFilesystemPath(this.root, container);
    const manifestPath = path.join(container, "manifest.json");
    if (!await exists(manifestPath)) throw new TopicalError(`Trash entry '${id}' does not exist.`, { code: "NOT_FOUND" });
    const entry = await readJson(manifestPath, null);
    if (!entry || entry.version !== TRASH_MANIFEST_VERSION || entry.id !== id) {
      throw new TopicalError(`Trash entry '${id}' has an invalid manifest.`, { code: "INTEGRITY_ERROR" });
    }
    return { container, entry };
  }

  async #trashEntries() {
    const trashRoot = path.join(this.root, ".trash");
    await assertSafeFilesystemPath(this.root, trashRoot);
    if (!await exists(trashRoot)) return [];
    const entries = [];
    for (const directory of await readdir(trashRoot, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[a-f0-9-]{36}$/.test(directory.name)) continue;
      try {
        const { entry } = await this.#readTrashEntry(directory.name);
        entries.push(entry);
      } catch { /* Invalid/incomplete entries are reported by health, not exposed as restorable. */ }
    }
    return entries.sort((left, right) => right.trashedAt.localeCompare(left.trashedAt) || left.id.localeCompare(right.id));
  }

  async recordPublicationAction(topic, publication, description) {
    return this.#serial(async () => {
      assertDescription(description);
      const { event, searchTopic } = await this.#record(topic, publication.action, null, description);
      const directory = await this.#requireTopicDirectory(topic);
      const index = await this.#topicIndex(topic);
      const summary = {
        id: publication.id,
        destination: publication.destination,
        publishedAt: publication.publishedAt,
        action: publication.action,
        updatedAt: event.at
      };
      index.publications = [...(index.publications || []).filter((entry) => entry.id !== publication.id), summary];
      await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify(index, null, 2) + "\n");
      await this.#upsertTopicInRoot(topic);
      await this.#replaceSearchTopic(searchTopic);
      return event;
    });
  }

  async reindex() {
    return this.#serial(() => this.#reindexUnlocked());
  }

  async listTopics({ sort = "recent", tags = [], cursor, limit = 50 } = {}) {
    const index = await this.#getRootIndex();
    const wantedTags = cleanTags(tags).map(canonicalTagKey);
    const topics = index.topics
      .filter((topic) => wantedTags.every((tag) => topic.tags.map(canonicalTagKey).includes(tag)))
      .map((topic) => ({ ...topic, tags: [...topic.tags], lastAction: topic.lastAction ? { ...topic.lastAction } : null }));
    if (sort === "title") topics.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "created") topics.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const page = paginate(topics, { cursor, limit, maxLimit: 100 });
    return { topics: page.items, page: page.page };
  }

  async listHistory({ topic, cursor, limit = 50 } = {}) {
    let history;
    if (topic) {
      assertTopicId(topic);
      try {
        const index = await this.#topicIndex(topic);
        history = [...(index.history || [])].reverse().map((event) => ({ topic, ...event }));
      } catch (error) {
        if (!(error instanceof TopicalError) || error.code !== "TOPICAL_ERROR" || !/does not exist/.test(error.message)) throw error;
        const root = await this.#getRootIndex();
        history = root.recentActions.filter((event) => event.topic === topic);
      }
    } else {
      const index = await this.#getRootIndex();
      history = [...index.recentActions];
    }
    const page = paginate(history, { cursor, limit, maxLimit: 100 });
    return { events: page.items, page: page.page };
  }

  async getSystemHealth() {
    const index = await this.#getRootIndex();
    const search = await this.#searchIndex.health();
    return {
      status: search.status === "ready" ? "ready" : "degraded",
      markdownAuthority: true,
      catalogue: {
        rootSchemaVersion: ROOT_INDEX_VERSION,
        topicSchemaVersion: TOPIC_INDEX_VERSION,
        updatedAt: index.updatedAt,
        topics: index.topics.length,
        documents: index.documents.length,
        recentActions: index.recentActions.length
      },
      search,
      rebuildRecommended: search.status !== "ready"
    };
  }

  async getRevision() {
    await this.#getRootIndex();
    return { revision: hash(this.#rootIndexStamp || "") };
  }

  async listTags({ query = "", cursor, limit = 50 } = {}) {
    const index = await this.#getRootIndex();
    const normalizedQuery = normalizeSearchText(String(query || "").trim());
    const byKey = new Map();
    for (const topic of index.topics) {
      for (const displayTag of topic.tags || []) {
        const key = canonicalTagKey(displayTag);
        if (!key) continue;
        const entry = byKey.get(key) || { key, displayForms: new Set(), topics: new Set() };
        entry.displayForms.add(String(displayTag));
        entry.topics.add(topic.id);
        byKey.set(key, entry);
      }
    }

    const allTags = [...byKey.values()]
      .map((entry) => ({
        key: entry.key,
        displayForms: [...entry.displayForms].sort((left, right) => left.localeCompare(right)),
        usageCount: entry.topics.size,
        topics: [...entry.topics].sort().slice(0, 10)
      }))
      .sort((left, right) => right.usageCount - left.usageCount || left.key.localeCompare(right.key));
    const filtered = normalizedQuery
      ? allTags.filter((entry) => normalizeSearchText([entry.key, ...entry.displayForms].join(" ")).includes(normalizedQuery))
      : allTags;
    const page = paginate(filtered, { cursor, limit, maxLimit: 100 });

    const comparisonGroups = new Map();
    for (const entry of allTags) {
      const comparison = comparisonTagKey(entry.key);
      const group = comparisonGroups.get(comparison) || [];
      group.push(entry.key);
      comparisonGroups.set(comparison, group);
    }
    const comparisonCollisions = [...comparisonGroups.entries()]
      .filter(([, keys]) => new Set(keys).size > 1)
      .slice(0, 20)
      .map(([comparisonKey, keys]) => ({ comparisonKey, keys: [...new Set(keys)].sort() }));
    const variants = allTags
      .filter((entry) => entry.displayForms.length > 1)
      .slice(0, 20)
      .map((entry) => ({ key: entry.key, displayForms: entry.displayForms }));
    const nearDuplicates = [];
    const candidates = allTags.slice(0, 500);
    for (let left = 0; left < candidates.length && nearDuplicates.length < 20; left += 1) {
      for (let right = left + 1; right < candidates.length && nearDuplicates.length < 20; right += 1) {
        const leftKey = comparisonTagKey(candidates[left].key);
        const rightKey = comparisonTagKey(candidates[right].key);
        if (leftKey.length < 4 || rightKey.length < 4 || leftKey === rightKey) continue;
        if (boundedEditDistance(leftKey, rightKey, 1) === 1) {
          nearDuplicates.push({ keys: [candidates[left].key, candidates[right].key] });
        }
      }
    }
    const overGuidance = index.topics.filter((topic) => (topic.tags || []).length > 3);
    const singletonTags = allTags.filter((entry) => entry.usageCount === 1);
    return {
      summary: {
        topics: index.topics.length,
        taggedTopics: index.topics.filter((topic) => (topic.tags || []).length > 0).length,
        assignments: index.topics.reduce((sum, topic) => sum + (topic.tags || []).length, 0),
        uniqueCanonicalTags: allTags.length,
        singletonTags: singletonTags.length,
        topicsAboveGuidance: overGuidance.length
      },
      tags: page.items,
      page: page.page,
      warnings: {
        singletonSummary: { count: singletonTags.length, sampleKeys: singletonTags.slice(0, 20).map((entry) => entry.key) },
        variants,
        comparisonCollisions,
        nearDuplicates,
        overGuidance: { count: overGuidance.length, topics: overGuidance.slice(0, 20).map((topic) => ({ topic: topic.id, tagCount: topic.tags.length })) }
      },
      guidance: "Zero tags is normal. Three tags is advisory. Review warnings explicitly; Topical never rewrites tags automatically."
    };
  }

  async createTopic({ title, summary, tags = [], initialContent = "", description }) {
    return this.#serial(async () => {
      assertDescription(description);
      assertBoundedText(title, { field: "title", maxChars: CONTRACT_LIMITS.titleChars, allowEmpty: false });
      assertBoundedText(summary ?? "", { field: "summary", maxChars: CONTRACT_LIMITS.summaryChars });
      const cleanTitle = title.trim();
      const cleanSummary = (summary ?? "").trim();
      const topic = slugify(cleanTitle);
      const directory = this.#topicDirectory(topic);
      if (await exists(directory)) throw new TopicalError(`Topic '${topic}' already exists.`);
      const timestamp = now();
      const normalizedTags = cleanTags(tags);
      await mkdir(directory, { recursive: true });
      assertMarkdown(initialContent);
      await assertSafeFilesystemPath(this.root, directory);
      await writeAtomic(this.root, path.join(directory, "context.md"), formatContext({ title: cleanTitle, summary: cleanSummary, tags: normalizedTags, createdAt: timestamp, updatedAt: timestamp }, initialContent));
      await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify({ version: TOPIC_INDEX_VERSION, topic: { id: topic, title: cleanTitle, summary: cleanSummary, tags: normalizedTags, createdAt: timestamp, updatedAt: timestamp }, files: ["context.md"], history: [] }, null, 2) + "\n");
      const { searchTopic } = await this.#record(topic, "create_topic", "context.md", description);
      await this.#upsertTopicInRoot(topic);
      await this.#replaceSearchTopic(searchTopic);
      return { topic, path: path.join(directory, "context.md") };
    });
  }

  async readTopicFile({ topic, filePath = "context.md" }) {
    await this.initialize();
    const directory = await this.#requireTopicDirectory(topic);
    const normalized = assertMarkdownPath(filePath);
    const target = path.resolve(directory, normalized);
    if (!target.startsWith(`${directory}${path.sep}`)) throw new TopicalError("File path must stay inside the topic.");
    await assertSafeFilesystemPath(this.root, target);
    if (!await exists(target)) throw new TopicalError(`File '${normalized}' does not exist in '${topic}'.`);
    const content = await readFile(target, "utf8");
    return { topic, path: normalized, content, hash: hash(content) };
  }

  async updateTopicFile({ topic, filePath = "context.md", mode = "append", content, section, description, expectedHash }) {
    return this.#serial(async () => {
      assertDescription(description);
      assertMarkdown(content);
      const current = await this.readTopicFile({ topic, filePath });
      assertExpectedHash(expectedHash, current.hash, { topic, path: current.path });
      let next;
      if (mode === "replace") next = content;
      else if (mode === "append") next = `${current.content.replace(/\s*$/, "")}\n\n${content.trim()}\n`;
      else if (mode === "replace_section") {
        if (!section) throw new TopicalError("section is required for replace_section mode.");
        next = updateSection(current.content, section, content);
      } else throw new TopicalError("mode must be append, replace, or replace_section.");
      const directory = await this.#requireTopicDirectory(topic);
      await writeAtomic(this.root, path.join(directory, current.path), next);
      if (current.path === "context.md") await this.#touchContext(topic, next);
      const { searchTopic } = await this.#record(topic, "update_file", current.path, description);
      await this.#upsertTopicInRoot(topic);
      await this.#replaceSearchTopic(searchTopic);
      const updated = await this.readTopicFile({ topic, filePath: current.path });
      return { topic, path: current.path, hash: updated.hash };
    });
  }

  async #touchContext(topic, content) {
    const directory = await this.#requireTopicDirectory(topic);
    const current = parseFrontmatter(content, { title: topic, summary: "", tags: [] });
    const metadata = { ...current.metadata, title: current.metadata.title || topic, tags: current.metadata.tags || [], createdAt: current.metadata.createdAt || now(), updatedAt: now() };
    await writeAtomic(this.root, path.join(directory, "context.md"), formatContext(metadata, current.body));
  }

  async createTopicFile({ topic, filePath, content = "", description }) {
    return this.#serial(async () => {
      assertDescription(description);
      const normalized = assertMarkdownPath(filePath, { allowContext: false });
      assertMarkdown(content);
      const directory = await this.#requireTopicDirectory(topic);
      const target = path.resolve(directory, normalized);
      if (!target.startsWith(`${directory}${path.sep}`)) throw new TopicalError("File path must stay inside the topic.");
      await assertSafeFilesystemPath(this.root, target);
      if (await exists(target)) throw new TopicalError(`File '${normalized}' already exists.`);
      await writeAtomic(this.root, target, content);
      const { searchTopic } = await this.#record(topic, "create_file", normalized, description);
      await this.#upsertTopicInRoot(topic);
      await this.#replaceSearchTopic(searchTopic);
      return { topic, path: normalized, hash: hash(content) };
    });
  }

  async deleteTopicFile({ topic, filePath, description, expectedHash, confirm = false }) {
    return this.#serial(async () => {
      assertDescription(description);
      if (!confirm) throw new TopicalError("Set confirm to true to move this file to Topical's trash.");
      const normalized = assertMarkdownPath(filePath, { allowContext: false });
      const current = await this.readTopicFile({ topic, filePath: normalized });
      assertExpectedHash(expectedHash, current.hash, { topic, path: normalized });
      const directory = await this.#requireTopicDirectory(topic);
      const target = path.resolve(directory, normalized);
      if (!target.startsWith(`${directory}${path.sep}`) || !await exists(target)) throw new TopicalError(`File '${normalized}' does not exist in '${topic}'.`);
      await assertSafeFilesystemPath(this.root, target);
      const id = randomUUID();
      const container = this.#trashDirectory(id);
      const storagePath = `content/${normalized}`;
      const trashTarget = path.join(container, storagePath);
      await assertSafeFilesystemPath(this.root, trashTarget);
      await mkdir(path.dirname(trashTarget), { recursive: true });
      await assertSafeFilesystemPath(this.root, trashTarget);
      await rename(target, trashTarget);
      const entry = {
        version: TRASH_MANIFEST_VERSION,
        id,
        type: "file",
        topic,
        path: normalized,
        trashedAt: now(),
        hash: current.hash,
        description: description.trim(),
        storagePath
      };
      await this.#writeTrashManifest(container, entry);
      const { searchTopic } = await this.#record(topic, "delete_file", normalized, description);
      await this.#upsertTopicInRoot(topic);
      await this.#replaceSearchTopic(searchTopic);
      return { topic, path: normalized, trash: entry };
    });
  }

  async updateTopicMetadata({ topic, title, summary, tags, description, expectedHash }) {
    return this.#serial(async () => {
      assertDescription(description);
      const current = await this.readTopicFile({ topic });
      assertExpectedHash(expectedHash, current.hash, { topic, path: "context.md" });
      if (title !== undefined) assertBoundedText(title, { field: "title", maxChars: CONTRACT_LIMITS.titleChars, allowEmpty: false });
      if (summary !== undefined) assertBoundedText(summary, { field: "summary", maxChars: CONTRACT_LIMITS.summaryChars });
      const parsed = parseFrontmatter(current.content, { title: topic, summary: "", tags: [] });
      const metadata = {
        title: title?.trim() || parsed.metadata.title || topic,
        summary: summary?.trim() ?? parsed.metadata.summary ?? "",
        tags: tags ? cleanTags(tags) : parsed.metadata.tags || [],
        createdAt: parsed.metadata.createdAt || now(),
        updatedAt: now()
      };
      const directory = await this.#requireTopicDirectory(topic);
      await writeAtomic(this.root, path.join(directory, "context.md"), formatContext(metadata, parsed.body));
      const { searchTopic } = await this.#record(topic, "update_metadata", "context.md", description);
      await this.#upsertTopicInRoot(topic);
      await this.#replaceSearchTopic(searchTopic);
      const persisted = await this.readTopicFile({ topic });
      return { topic, metadata, hash: persisted.hash };
    });
  }

  async deleteTopic({ topic, description, expectedHash, confirm = false }) {
    return this.#serial(async () => {
      assertDescription(description);
      if (!confirm) throw new TopicalError("Set confirm to true to move this topic to Topical's trash.");
      const current = await this.readTopicFile({ topic });
      assertExpectedHash(expectedHash, current.hash, { topic, path: "context.md" });
      const directory = await this.#requireTopicDirectory(topic);
      const id = randomUUID();
      const container = this.#trashDirectory(id);
      const storagePath = "topic";
      const target = path.join(container, storagePath);
      await assertSafeFilesystemPath(this.root, target);
      await mkdir(path.dirname(target), { recursive: true });
      await assertSafeFilesystemPath(this.root, target);
      await rename(directory, target);
      const entry = {
        version: TRASH_MANIFEST_VERSION,
        id,
        type: "topic",
        topic,
        path: null,
        trashedAt: now(),
        hash: current.hash,
        description: description.trim(),
        storagePath
      };
      await this.#writeTrashManifest(container, entry);
      await this.#removeTopicFromRoot(topic, { at: entry.trashedAt, action: "delete_topic", path: null, description: description.trim() });
      await this.#removeSearchTopic(topic);
      return { topic, trash: entry };
    });
  }

  async listTrash({ type, topic, cursor, limit = 50 } = {}) {
    await this.initialize();
    const entries = (await this.#trashEntries())
      .filter((entry) => !type || entry.type === type)
      .filter((entry) => !topic || entry.topic === topic)
      .map(({ storagePath: _storagePath, version: _version, ...entry }) => ({ ...entry }));
    const page = paginate(entries, { cursor, limit, maxLimit: 100 });
    return {
      entries: page.items,
      page: page.page,
      retention: {
        automaticDeletion: false,
        oldestTrashedAt: entries.at(-1)?.trashedAt || null,
        newestTrashedAt: entries[0]?.trashedAt || null
      }
    };
  }

  async restoreTrash({ id, expectedHash, description }) {
    return this.#serial(async () => {
      assertDescription(description);
      const { container, entry } = await this.#readTrashEntry(id);
      assertExpectedHash(expectedHash, entry.hash, { id, topic: entry.topic, path: entry.path });
      const stored = path.join(container, entry.storagePath);
      await assertSafeFilesystemPath(this.root, stored);
      if (!await exists(stored)) throw new TopicalError(`Trash entry '${id}' content is missing.`, { code: "INTEGRITY_ERROR" });

      if (entry.type === "file") {
        const storedContent = await readFile(stored, "utf8");
        if (hash(storedContent) !== entry.hash) throw new TopicalError(`Trash entry '${id}' content failed its hash check.`, { code: "INTEGRITY_ERROR" });
        const directory = await this.#requireTopicDirectory(entry.topic);
        const destination = path.resolve(directory, assertMarkdownPath(entry.path, { allowContext: false }));
        if (!destination.startsWith(`${directory}${path.sep}`)) throw new TopicalError("Restore path must stay inside the topic.");
        await assertSafeFilesystemPath(this.root, destination);
        if (await exists(destination)) throw conflictError("The original file path already exists; review it before restoring.", { topic: entry.topic, path: entry.path });
        await mkdir(path.dirname(destination), { recursive: true });
        await assertSafeFilesystemPath(this.root, destination);
        await rename(stored, destination);
        const { searchTopic } = await this.#record(entry.topic, "restore_file", entry.path, description);
        await this.#upsertTopicInRoot(entry.topic);
        await this.#replaceSearchTopic(searchTopic);
      } else if (entry.type === "topic") {
        const contextPath = path.join(stored, "context.md");
        await assertSafeFilesystemPath(this.root, contextPath);
        const storedContext = await readFile(contextPath, "utf8");
        if (hash(storedContext) !== entry.hash) throw new TopicalError(`Trash entry '${id}' content failed its hash check.`, { code: "INTEGRITY_ERROR" });
        const destination = this.#topicDirectory(entry.topic);
        if (await exists(destination)) throw conflictError("The original topic ID already exists; review it before restoring.", { topic: entry.topic });
        await rename(stored, destination);
        const { searchTopic } = await this.#record(entry.topic, "restore_topic", null, description);
        await this.#upsertTopicInRoot(entry.topic);
        await this.#replaceSearchTopic(searchTopic);
      } else {
        throw new TopicalError(`Trash entry '${id}' has an unsupported type.`, { code: "INTEGRITY_ERROR" });
      }

      await rm(container, { recursive: true, force: true });
      const restored = entry.type === "file"
        ? await this.readTopicFile({ topic: entry.topic, filePath: entry.path })
        : await this.readTopicFile({ topic: entry.topic });
      return { id, type: entry.type, topic: entry.topic, path: entry.path, hash: restored.hash };
    });
  }

  async getTopicOverview({ topic, maxChars = DEFAULT_OVERVIEW_CHARS }) {
    await this.initialize();
    const directory = await this.#requireTopicDirectory(topic);
    const rootIndex = await this.#getRootIndex();
    const summary = rootIndex.topics.find((entry) => entry.id === topic);
    if (!summary) throw new TopicalError(`Topic '${topic}' is not indexed. Run reindex_topical before requesting an overview.`);
    const contextPath = path.join(directory, "context.md");
    await assertSafeFilesystemPath(this.root, contextPath);
    const context = await readFile(contextPath, "utf8");
    const parsed = parseFrontmatter(context, summary);
    const index = await this.#topicIndex(topic);
    const boundedLength = Math.max(500, Math.min(Number(maxChars) || DEFAULT_OVERVIEW_CHARS, 12_000));
    return {
      topic,
      metadata: { ...summary, tags: [...summary.tags] },
      context: compactText(parsed.body).slice(0, boundedLength),
      contextTruncated: compactText(parsed.body).length > boundedLength,
      files: (index.documents || []).map((document) => ({ ...document, headings: [...(document.headings || [])] })),
      publications: [...(index.publications || [])],
      recentHistory: [...(index.history || [])].slice(-12).reverse()
    };
  }

  async searchTopics({ query, tags = [], limit = 10 }) {
    await this.initialize();
    await this.#getRootIndex();
    const analysis = analyzeQuery(query);
    const sourceQuery = analysis.source;
    const result = await queryWithRelaxedFallback(this.#searchIndex, { query: sourceQuery, analysis, tags: cleanTags(tags), limit });
    const topics = [];
    for (const topic of result.topics) {
      const directory = await this.#requireTopicDirectory(topic.topic);
      const files = [];
      for (const file of topic.files || []) {
        const target = path.join(directory, file.path);
        await assertSafeFilesystemPath(this.root, target);
        if (!await exists(target)) continue;
        const content = await readFile(target, "utf8");
        const parsed = parseFrontmatter(content);
        const explanation = explainFileMatch(file.path, parsed.body, topic.matchedTerms, topic.aliasMatchedTerms);
        files.push({
          ...file,
          ...explanation,
          snippet: bodySnippet(parsed.body, explanation.matchedTerms.length ? explanation.matchedTerms : topic.matchedTerms, sourceQuery)
        });
      }
      topics.push({ ...topic, files });
    }
    return {
      query: sourceQuery,
      analysis: queryAnalysisResponse(analysis),
      matchMode: result.matchMode,
      expansions: result.expansions || [],
      topics
    };
  }
}
