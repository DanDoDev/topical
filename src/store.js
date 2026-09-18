import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { conflictError, TopicalError } from "./errors.js";
import { HistoryStore } from "./history-store.js";
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
import { extractTasks } from "./tasks.js";
import { topicStarter, workStarter, workPath, linkWork } from "./workflows.js";

const ROOT_INDEX_VERSION = 5;
const TOPIC_INDEX_VERSION = 6;
const TRASH_MANIFEST_VERSION = 1;
const MAX_RECENT_ACTIONS = 100;
const MAX_REVISION_TOPICS = 20;
const MAX_RECENT_TOPIC_ACTIONS = 12;
const DEFAULT_OVERVIEW_CHARS = 2_000;
const CONTEXT_ADVISORY_CHARS = 4_000;
const MAX_INTERACTIVE_CATALOGUE_BYTES = 10 * 1024 * 1024;

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

function overviewFields(include) {
  const values = include === undefined
    ? ["context", "files"]
    : Array.isArray(include)
      ? include
      : String(include).split(",");
  const allowed = new Set(["context", "files", "history", "publications"]);
  const fields = new Set(values.map((value) => String(value).trim()).filter(Boolean));
  for (const field of fields) {
    if (!allowed.has(field)) throw new TopicalError(`Unknown overview field '${field}'.`, { code: "INVALID_INPUT" });
  }
  return fields;
}

function sortedTopicDocuments(documents, sort = "recent") {
  const values = [...(documents || [])];
  return values.sort((left, right) => {
    if (left.path === "context.md") return -1;
    if (right.path === "context.md") return 1;
    if (sort === "name") return left.path.localeCompare(right.path);
    if (sort === "size") return (right.size || 0) - (left.size || 0) || left.path.localeCompare(right.path);
    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")) || left.path.localeCompare(right.path);
  });
}

function localMarkdownLinks(markdown) {
  const links = [];
  for (const match of String(markdown || "").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = raw.split("#")[0].split("?")[0];
    if (target.toLowerCase().endsWith(".md")) links.push(target);
  }
  return [...new Set(links)];
}

export class TopicalStore {
  #queue = Promise.resolve();
  #rootIndexCache;
  #rootIndexStamp;
  #rootRefreshPromise;
  #searchIndex;
  #searchIndexIdentity;
  #historyStore;
  #initialized = false;
  #initializePromise;

  constructor(root) {
    if (!path.isAbsolute(root)) throw new TopicalError("TOPICAL_ROOT must be an absolute path.");
    this.root = path.resolve(root);
    this.#historyStore = new HistoryStore(this.root);
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
    await this.#historyStore.initialize();
    const topicDirectories = await readdir(this.root, { withFileTypes: true });
    const legacyEvents = [];
    for (const entry of topicDirectories) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue;
      const legacyIndexPath = path.join(this.root, entry.name, "index.json");
      await assertSafeFilesystemPath(this.root, legacyIndexPath);
      const legacyIndex = await readJson(legacyIndexPath, null);
      if (Array.isArray(legacyIndex?.history) && legacyIndex.history.length) {
        legacyIndex.history.forEach((event, position) => legacyEvents.push({ topic: entry.name, event, position }));
      }
    }
    legacyEvents.sort((left, right) => String(left.event.at || "").localeCompare(String(right.event.at || "")) || left.topic.localeCompare(right.topic) || left.position - right.position);
    await this.#historyStore.importLegacyEntries(legacyEvents);
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
      await this.#historyStore.close();
      throw error;
    }
  }

  async close() {
    await this.#searchIndex?.close();
    await this.#historyStore?.close();
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
    return readJson(path.join(directory, "index.json"), { version: TOPIC_INDEX_VERSION, topic: { id: topic }, files: [], recentHistory: [] });
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
      documents.push(await this.#buildTopicDocument(topic, directory, filePath, metadata));
    }
    return documents;
  }

  async #buildTopicDocument(topic, directory, filePath, metadata) {
    const target = path.join(directory, filePath);
    await assertSafeFilesystemPath(this.root, target);
    const content = await readFile(target, "utf8");
    const details = await stat(target);
    const parsed = parseFrontmatter(content, metadata);
    const body = compactText(parsed.body);
    return {
      topic,
      path: filePath,
      headings: headingList(parsed.body),
      excerpt: body.slice(0, 360),
      size: Buffer.byteLength(content, "utf8"),
      hash: hash(content),
      updatedAt: details.mtime.toISOString(),
      body,
      tasks: extractTasks(content)
    };
  }

  #topicSummary(topic, metadata, index) {
    const lastAction = index.recentHistory?.at(-1) || index.history?.at(-1);
    return {
      id: topic,
      title: metadata.title || topic,
      summary: metadata.summary || "",
      tags: metadata.tags || [],
      createdAt: metadata.createdAt || null,
      updatedAt: index.updatedAt || metadata.updatedAt || now(),
      fileCount: index.files?.length || 0,
      lastAction: lastAction ? { at: lastAction.at, action: lastAction.action, description: lastAction.description } : null
    };
  }

  async #upsertTopicInRoot(topic, change = {}) {
    const index = change.index || await this.#topicIndex(topic);
    const metadata = change.metadata || index.topic || { title: topic, summary: "", tags: [] };
    const rootIndex = await this.#getRootIndex();
    const summary = this.#topicSummary(topic, metadata, index);
    const lastAction = index.recentHistory?.at(-1) || index.history?.at(-1);
    const existed = rootIndex.topics.some((entry) => entry.id === topic);
    rootIndex.topics = [...rootIndex.topics.filter((entry) => entry.id !== topic), summary]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (change.documentPath) {
      rootIndex.documents = rootIndex.documents.filter((document) => document.topic !== topic || document.path !== change.documentPath);
      if (change.document) {
        const { body: _body, tasks: _tasks, ...catalogueDocument } = change.document;
        rootIndex.documents.push(catalogueDocument);
      }
    } else if (!existed || change.replaceDocuments) {
      rootIndex.documents = [...rootIndex.documents.filter((document) => document.topic !== topic), ...(index.documents || [])];
    }
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

  async #record(topic, action, filePath, description, { replaceDocuments = false } = {}) {
    assertDescription(description);
    const directory = this.#topicDirectory(topic);
    const index = await this.#topicIndex(topic);
    const event = await this.#historyStore.append({ topic, at: now(), action, path: filePath ?? null, description: description.trim() });
    index.version = TOPIC_INDEX_VERSION;
    index.recentHistory = [...(index.recentHistory || index.history || []), event].slice(-MAX_RECENT_TOPIC_ACTIONS);
    delete index.history;
    index.updatedAt = event.at;
    let metadata = index.topic || { id: topic, title: topic, summary: "", tags: [] };
    let document = null;
    const documentPath = typeof filePath === "string" && filePath.endsWith(".md") ? filePath : null;
    if (replaceDocuments) {
      index.files = await listMarkdownFiles(directory);
      const context = await readFile(path.join(directory, "context.md"), "utf8");
      metadata = { id: topic, ...parseFrontmatter(context, metadata).metadata };
      const searchDocuments = await this.#buildTopicDocuments(topic, directory, index.files, metadata);
      index.documents = searchDocuments.map(({ body: _body, tasks: _tasks, ...value }) => value);
      index.topic = metadata;
      await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify(index, null, 2) + "\n");
      return {
        event,
        change: {
          topic: this.#topicSummary(topic, metadata, index),
          fullTopic: { topic: this.#topicSummary(topic, metadata, index), documents: searchDocuments },
          index,
          metadata,
          replaceDocuments: true
        }
      };
    }
    if (documentPath) {
      const target = path.join(directory, documentPath);
      await assertSafeFilesystemPath(this.root, target);
      const present = await exists(target);
      index.files = [...new Set([...(index.files || []).filter((value) => value !== documentPath), ...(present ? [documentPath] : [])])].sort();
      if (present) {
        if (documentPath === "context.md") {
          const context = await readFile(target, "utf8");
          metadata = { id: topic, ...parseFrontmatter(context, metadata).metadata };
          index.topic = metadata;
        }
        document = await this.#buildTopicDocument(topic, directory, documentPath, metadata);
      }
      index.documents = [...(index.documents || []).filter((value) => value.path !== documentPath), ...(document ? [(({ body: _body, tasks: _tasks, ...value }) => value)(document)] : [])]
        .sort((left, right) => left.path.localeCompare(right.path));
    }
    index.topic = { id: topic, ...metadata };
    await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify(index, null, 2) + "\n");
    return {
      event,
      change: {
        topic: this.#topicSummary(topic, metadata, index),
        documentPath,
        document,
        index,
        metadata,
        replaceDocuments: false
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
      if (Array.isArray(index.history) && index.history.length) await this.#historyStore.importLegacy(topic, index.history);
      const files = await listMarkdownFiles(directory);
      index.version = TOPIC_INDEX_VERSION;
      index.topic = { id: topic, ...parsed.metadata };
      index.files = files;
      index.updatedAt = parsed.metadata.updatedAt || index.updatedAt || now();
      index.recentHistory = [...(index.recentHistory || index.history || [])].slice(-MAX_RECENT_TOPIC_ACTIONS);
      delete index.history;
      const searchDocuments = await this.#buildTopicDocuments(topic, directory, files, parsed.metadata);
      index.documents = searchDocuments.map(({ body: _body, tasks: _tasks, ...document }) => document);
      await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify(index, null, 2) + "\n");
      const lastAction = index.recentHistory.at(-1);
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

  async #applySearchChange(change) {
    try {
      if (change.fullTopic) await this.#searchIndex.replace(change.fullTopic);
      else if (change.documentPath) await this.#searchIndex.replaceDocument({ topic: change.topic, path: change.documentPath, document: change.document });
      else await this.#searchIndex.updateTopic({ topic: change.topic });
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
      const { event, change } = await this.#record(topic, publication.action, null, description);
      const directory = await this.#requireTopicDirectory(topic);
      const index = change.index;
      const summary = {
        id: publication.id,
        destination: publication.destination,
        publishedAt: publication.publishedAt,
        action: publication.action,
        updatedAt: event.at
      };
      index.publications = [...(index.publications || []).filter((entry) => entry.id !== publication.id), summary];
      await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify(index, null, 2) + "\n");
      await this.#upsertTopicInRoot(topic, change);
      await this.#applySearchChange(change);
      return event;
    });
  }

  async reindex() {
    return this.#serial(() => this.#reindexUnlocked());
  }

  async prepareV05Rollback({ confirm = false } = {}) {
    if (!confirm) throw new TopicalError("Set confirm to true to rebuild v0.5-compatible catalogues from durable audit history.", { code: "INVALID_INPUT" });
    return this.#serial(async () => {
      await this.initialize();
      const rootIndex = await this.#getRootIndex();
      let eventCount = 0;
      for (const summary of rootIndex.topics) {
        const index = await this.#topicIndex(summary.id);
        const newestFirst = [];
        let cursor;
        do {
          const page = await this.#historyStore.list({ topic: summary.id, cursor, limit: 100 });
          newestFirst.push(...page.events);
          cursor = page.page.nextCursor;
        } while (cursor);
        index.version = 5;
        index.history = newestFirst.reverse().map(({ topic: _topic, ...event }) => event);
        delete index.recentHistory;
        eventCount += index.history.length;
        const directory = await this.#requireTopicDirectory(summary.id);
        await writeAtomic(this.root, path.join(directory, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
      }
      const legacyRoot = { ...rootIndex, version: 4 };
      await writeAtomic(this.root, path.join(this.root, "index.json"), `${JSON.stringify(legacyRoot, null, 2)}\n`);
      this.#rootIndexCache = undefined;
      this.#rootIndexStamp = undefined;
      return {
        status: "ready_for_v0.5",
        topics: rootIndex.topics.length,
        events: eventCount,
        guidance: "Stop this process before starting Topical v0.5. The durable .topical-history records remain available if this version is started again."
      };
    });
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

  async listTopicFiles({ topic, query = "", sort = "recent", cursor, limit = 50 } = {}) {
    assertTopicId(topic);
    const index = await this.#topicIndex(topic);
    const normalizedQuery = normalizeSearchText(String(query || "").trim());
    const documents = sortedTopicDocuments(index.documents, sort)
      .filter((document) => !normalizedQuery || normalizeSearchText([
        document.path,
        ...(document.headings || []),
        document.excerpt || ""
      ].join(" ")).includes(normalizedQuery))
      .map((document) => ({ ...document, headings: [...(document.headings || [])] }));
    const page = paginate(documents, { cursor, limit, maxLimit: 100 });
    return {
      files: page.items,
      page: page.page,
      summary: {
        totalFiles: (index.documents || []).length,
        matchedFiles: documents.length,
        contextPath: "context.md"
      }
    };
  }

  async listHistory({ topic, action, pathQuery, cursor, limit = 50 } = {}) {
    if (topic) assertTopicId(topic);
    return this.#historyStore.list({ topic, action, pathQuery, cursor, limit });
  }

  async getSystemHealth() {
    const index = await this.#getRootIndex();
    const search = await this.#searchIndex.health();
    const history = await this.#historyStore.health();
    return {
      status: search.status === "ready" && history.status === "ready" ? "ready" : "degraded",
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
      history,
      rebuildRecommended: search.status !== "ready"
    };
  }

  async getRevision({ topic } = {}) {
    if (topic) {
      assertTopicId(topic);
      const directory = await this.#requireTopicDirectory(topic);
      const indexPath = path.join(directory, "index.json");
      await assertSafeFilesystemPath(this.root, indexPath);
      return { scope: "topic", topic, revision: hash(`${topic}|${await fileStamp(indexPath)}`) };
    }
    const index = await this.#getRootIndex();
    const titles = new Map(index.topics.map((entry) => [entry.id, entry.title]));
    const recentChanges = [];
    const changedTopics = new Set();
    for (const event of index.recentActions) {
      if (changedTopics.has(event.topic)) continue;
      changedTopics.add(event.topic);
      recentChanges.push({
        id: event.id,
        topic: event.topic,
        title: titles.get(event.topic) || event.topic,
        at: event.at,
        action: event.action,
        path: event.path ?? null
      });
      if (recentChanges.length === MAX_REVISION_TOPICS) break;
    }
    return {
      scope: "global",
      revision: hash(this.#rootIndexStamp || ""),
      recentChanges
    };
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

  async createTopic({ title, summary, tags = [], initialContent = "", description, template }) {
    return this.#serial(async () => {
      assertDescription(description);
      assertBoundedText(title, { field: "title", maxChars: CONTRACT_LIMITS.titleChars, allowEmpty: false });
      assertBoundedText(summary ?? "", { field: "summary", maxChars: CONTRACT_LIMITS.summaryChars });
      const cleanTitle = title.trim();
      const cleanSummary = (summary ?? "").trim();
      if (template) {
        if (initialContent.trim()) throw new TopicalError("Choose either a template or initial Markdown.");
        initialContent = topicStarter(template, cleanTitle, cleanSummary);
      }
      const topic = slugify(cleanTitle);
      const directory = this.#topicDirectory(topic);
      if (await exists(directory)) throw new TopicalError(`Topic '${topic}' already exists.`);
      const timestamp = now();
      const normalizedTags = cleanTags(tags);
      await mkdir(directory, { recursive: true });
      assertMarkdown(initialContent);
      await assertSafeFilesystemPath(this.root, directory);
      await writeAtomic(this.root, path.join(directory, "context.md"), formatContext({ title: cleanTitle, summary: cleanSummary, tags: normalizedTags, createdAt: timestamp, updatedAt: timestamp }, initialContent));
      await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify({ version: TOPIC_INDEX_VERSION, topic: { id: topic, title: cleanTitle, summary: cleanSummary, tags: normalizedTags, createdAt: timestamp, updatedAt: timestamp }, files: ["context.md"], recentHistory: [] }, null, 2) + "\n");
      const { change } = await this.#record(topic, "create_topic", "context.md", description, { replaceDocuments: true });
      await this.#upsertTopicInRoot(topic, change);
      await this.#applySearchChange(change);
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
    const details = await stat(target);
    return { topic, path: normalized, content, hash: hash(content), updatedAt: details.mtime.toISOString() };
  }

  async listTasks(input = {}) {
    await this.#getRootIndex();
    if (input.topic !== undefined) await this.#requireTopicDirectory(input.topic);
    return this.#searchIndex.listTasks(input);
  }

  async createWorkArea({ topic, kind, slug, title, brief = "", parentFile = "context.md", expectedHash, description }) {
    return this.#serial(async () => {
      assertDescription(description);
      assertBoundedText(title, { field: "title", maxChars: CONTRACT_LIMITS.titleChars, allowEmpty: false });
      if (/[\r\n]/.test(title)) throw new TopicalError("Work title must be a single line.");
      assertBoundedText(brief, { field: "brief", maxChars: 4000 });
      const relative = workPath(kind, slug);
      const parent = await this.readTopicFile({ topic, filePath: parentFile });
      const filePath = path.posix.join(path.posix.dirname(parent.path), relative);
      const content = workStarter(kind, title.trim(), brief);
      assertMarkdown(content);
      const directory = await this.#requireTopicDirectory(topic);
      const target = path.join(directory, filePath);
      await assertSafeFilesystemPath(this.root, target);
      const link = `- [${title.trim().replace(/[\\[\]]/g, "\\$&")}](${relative})`;
      const present = await exists(target);
      // A retry may safely finish the parent link, but never overwrite evolved work.
      if (present && await readFile(target, "utf8") !== content) throw conflictError("Work already exists with different content. Open the existing file.", { topic, path: filePath });
      if (present && parent.content.split(/\r?\n/).includes(link)) return { topic, path: filePath, reused: true };
      assertExpectedHash(expectedHash, parent.hash, { topic, path: parent.path });
      const nextParent = linkWork(parent.content, link);
      assertMarkdown(nextParent);
      try {
        if (!present) {
          await writeAtomic(this.root, target, content);
          const { change } = await this.#record(topic, "create_file", filePath, description);
          await this.#upsertTopicInRoot(topic, change);
          await this.#applySearchChange(change);
        }
        // Recheck before changing the parent if another process edited it.
        const latest = await this.readTopicFile({ topic, filePath: parent.path });
        assertExpectedHash(parent.hash, latest.hash, { topic, path: parent.path });
        await writeAtomic(this.root, path.join(directory, parent.path), nextParent);
        if (parent.path === "context.md") await this.#touchContext(topic, nextParent);
        const { change } = await this.#record(topic, "update_file", parent.path, description);
        await this.#upsertTopicInRoot(topic, change);
        await this.#applySearchChange(change);
        return { topic, path: filePath, parentFile: parent.path, reused: present };
      } catch (error) {
        throw new TopicalError("Work creation did not finish. Inspect the work file and parent, then retry with the current parent hash.", { code: "PARTIAL_WORKFLOW", details: { topic, path: filePath, parentFile: parent.path, cause: error.message } });
      }
    });
  }

  async setTaskCompleted({ topic, filePath, offset, completed, expectedHash, description }) {
    if (!Number.isInteger(offset) || offset < 0 || typeof completed !== "boolean") throw new TopicalError("A valid task offset and completion state are required.");
    const current = await this.readTopicFile({ topic, filePath });
    assertExpectedHash(expectedHash, current.hash, { topic, path: current.path });
    if (!extractTasks(current.content).some((task) => task.offset === offset)) throw new TopicalError("Task no longer exists at this location. Refresh the task list.");
    const content = current.content.slice(0, offset) + (completed ? "x" : " ") + current.content.slice(offset + 1);
    return this.updateTopicFile({ topic, filePath: current.path, mode: "replace", content, expectedHash: current.hash, description });
  }

  async readRootCatalogue({ view = "rendered" } = {}) {
    await this.initialize();
    return this.#readCatalogue(path.join(this.root, "index.json"), { scope: "root" }, view);
  }

  async readTopicCatalogue({ topic, view = "rendered" }) {
    await this.initialize();
    const directory = await this.#requireTopicDirectory(topic);
    return this.#readCatalogue(path.join(directory, "index.json"), { scope: "topic", topic }, view);
  }

  async #readCatalogue(target, identity, view) {
    if (view !== "rendered" && view !== "raw") throw new TopicalError("Catalogue view must be 'rendered' or 'raw'.");
    await assertSafeFilesystemPath(this.root, target);
    const details = await stat(target);
    if (details.size > MAX_INTERACTIVE_CATALOGUE_BYTES) {
      throw new TopicalError("This catalogue is too large for the interactive inspector.", {
        code: "PAYLOAD_TOO_LARGE",
        details: { maximumBytes: MAX_INTERACTIVE_CATALOGUE_BYTES, size: details.size }
      });
    }
    const raw = await readFile(target, "utf8");
    const result = { ...identity, size: Buffer.byteLength(raw, "utf8"), hash: hash(raw), view };
    if (view === "raw") return { ...result, raw };
    try {
      return { ...result, data: JSON.parse(raw) };
    } catch {
      throw new TopicalError("The derived catalogue contains invalid JSON. Reindex Topical to rebuild it.");
    }
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
      const { change } = await this.#record(topic, "update_file", current.path, description);
      await this.#upsertTopicInRoot(topic, change);
      await this.#applySearchChange(change);
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
      const { change } = await this.#record(topic, "create_file", normalized, description);
      await this.#upsertTopicInRoot(topic, change);
      await this.#applySearchChange(change);
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
      const { change } = await this.#record(topic, "delete_file", normalized, description);
      await this.#upsertTopicInRoot(topic, change);
      await this.#applySearchChange(change);
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
      const { change } = await this.#record(topic, "update_metadata", "context.md", description);
      await this.#upsertTopicInRoot(topic, change);
      await this.#applySearchChange(change);
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
      const event = await this.#historyStore.append({ topic, at: entry.trashedAt, action: "delete_topic", path: null, description: description.trim() });
      await this.#removeTopicFromRoot(topic, event);
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
        const { change } = await this.#record(entry.topic, "restore_file", entry.path, description);
        await this.#upsertTopicInRoot(entry.topic, change);
        await this.#applySearchChange(change);
      } else if (entry.type === "topic") {
        const contextPath = path.join(stored, "context.md");
        await assertSafeFilesystemPath(this.root, contextPath);
        const storedContext = await readFile(contextPath, "utf8");
        if (hash(storedContext) !== entry.hash) throw new TopicalError(`Trash entry '${id}' content failed its hash check.`, { code: "INTEGRITY_ERROR" });
        const destination = this.#topicDirectory(entry.topic);
        if (await exists(destination)) throw conflictError("The original topic ID already exists; review it before restoring.", { topic: entry.topic });
        await rename(stored, destination);
        const { change } = await this.#record(entry.topic, "restore_topic", null, description, { replaceDocuments: true });
        await this.#upsertTopicInRoot(entry.topic, change);
        await this.#applySearchChange(change);
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

  async getTopicOverview({ topic, maxChars = DEFAULT_OVERVIEW_CHARS, include, fileCursor, fileLimit = 20, fileSort = "recent" }) {
    await this.initialize();
    const directory = await this.#requireTopicDirectory(topic);
    const rootIndex = await this.#getRootIndex();
    const summary = rootIndex.topics.find((entry) => entry.id === topic);
    if (!summary) throw new TopicalError(`Topic '${topic}' is not indexed. Run reindex_topical before requesting an overview.`);
    const fields = overviewFields(include);
    const result = {
      topic,
      metadata: { ...summary, tags: [...summary.tags] }
    };
    if (fields.has("context")) {
      const contextPath = path.join(directory, "context.md");
      await assertSafeFilesystemPath(this.root, contextPath);
      const context = await readFile(contextPath, "utf8");
      const compacted = compactText(parseFrontmatter(context, summary).body);
      const boundedLength = Math.max(500, Math.min(Number(maxChars) || DEFAULT_OVERVIEW_CHARS, 12_000));
      result.context = compacted.slice(0, boundedLength);
      result.contextTruncated = compacted.length > boundedLength;
      result.contextAdvisory = {
        characters: compacted.length,
        targetMaximum: CONTEXT_ADVISORY_CHARS,
        aboveTarget: compacted.length > CONTEXT_ADVISORY_CHARS,
        guidance: compacted.length > CONTEXT_ADVISORY_CHARS
          ? "Keep context.md as a concise status and topic map; move substantial detail to focused supporting files."
          : "context.md is within the advisory discovery budget."
      };
    }
    let index;
    if (fields.has("files") || fields.has("publications")) index = await this.#topicIndex(topic);
    if (fields.has("files")) {
      const files = sortedTopicDocuments(index.documents, fileSort)
        .map((document) => ({ ...document, headings: [...(document.headings || [])] }));
      const page = paginate(files, { cursor: fileCursor, limit: fileLimit, maxLimit: 100 });
      result.files = page.items;
      result.filePage = page.page;
    }
    if (fields.has("publications")) result.publications = [...(index.publications || [])];
    if (fields.has("history")) {
      const history = await this.#historyStore.list({ topic, limit: MAX_RECENT_TOPIC_ACTIONS });
      result.recentHistory = history.events;
      result.historyPage = history.page;
    }
    return result;
  }

  async analyzeTopicContext({ topic }) {
    assertTopicId(topic);
    const context = await this.readTopicFile({ topic, filePath: "context.md" });
    const body = parseFrontmatter(context.content).body;
    const index = await this.#topicIndex(topic);
    const knownPaths = new Set((index.documents || []).map((document) => document.path));
    const links = localMarkdownLinks(body);
    const brokenLinks = links.filter((target) => {
      const normalized = path.posix.normalize(target);
      return normalized.startsWith("../") || !knownPaths.has(normalized);
    });
    const headings = body.split(/\r?\n/).filter((line) => /^#{1,6}\s+\S/.test(line));
    const datedHeadings = headings.filter((heading) => /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(heading));
    const characters = body.length;
    const findings = [];
    if (characters > CONTEXT_ADVISORY_CHARS) findings.push({ code: "ABOVE_CONTEXT_BUDGET", severity: "advisory", message: `context.md has ${characters.toLocaleString()} body characters; the normal routing-document target is at most ${CONTEXT_ADVISORY_CHARS.toLocaleString()}.` });
    if (headings.length > 12) findings.push({ code: "MANY_SECTIONS", severity: "advisory", message: `context.md has ${headings.length} headings and may mix long-lived routing with detailed work logs.` });
    if (datedHeadings.length > 3) findings.push({ code: "DATED_LOG_SECTIONS", severity: "advisory", message: `${datedHeadings.length} dated headings may be better preserved in a focused implementation or handoff file.` });
    if (brokenLinks.length) findings.push({ code: "BROKEN_TOPIC_LINKS", severity: "advisory", message: `${brokenLinks.length} local Markdown link${brokenLinks.length === 1 ? "" : "s"} do not resolve to a current topic file.` });
    return {
      topic,
      mode: "analyze_only",
      changed: false,
      context: {
        hash: context.hash,
        characters,
        lines: body ? body.split(/\r?\n/).length : 0,
        headings: headings.length,
        linkedTopicFiles: links.length,
        targetRange: { minimum: 2_000, maximum: CONTEXT_ADVISORY_CHARS },
        aboveTarget: characters > CONTEXT_ADVISORY_CHARS
      },
      findings,
      details: { brokenLinks, datedHeadings: datedHeadings.slice(0, 20) },
      guidance: [
        "Keep context.md to purpose, current status, immediate decisions, and a concise map of focused files.",
        "Put substantial plans, research, dated logs, and handoffs in supporting Markdown files before shortening context.md.",
        "No content was changed. Any future optimization must be reviewed and use current hashes for every affected file."
      ]
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

  async searchTopicFiles({ query, topic, matchMode = "strict", cursor, limit = 50 }) {
    assertTopicId(topic);
    await this.initialize();
    await this.#getRootIndex();
    const analysis = analyzeQuery(query);
    const sourceQuery = analysis.source;
    const result = await this.#searchIndex.queryFiles({ query: sourceQuery, analysis, topic, matchMode, cursor, limit });
    const directory = await this.#requireTopicDirectory(topic);
    const files = [];
    for (const file of result.files) {
      const target = path.join(directory, file.path);
      await assertSafeFilesystemPath(this.root, target);
      if (!await exists(target)) continue;
      const content = await readFile(target, "utf8");
      const parsed = parseFrontmatter(content);
      const explanation = explainFileMatch(file.path, parsed.body, file.matchedTerms, []);
      files.push({
        ...file,
        ...explanation,
        snippet: bodySnippet(parsed.body, explanation.matchedTerms.length ? explanation.matchedTerms : file.matchedTerms, sourceQuery)
      });
    }
    return {
      query: sourceQuery,
      topic,
      matchMode,
      files,
      page: result.page
    };
  }
}
