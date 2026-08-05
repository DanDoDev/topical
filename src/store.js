import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT_INDEX_VERSION = 2;
const TOPIC_INDEX_VERSION = 3;
const MAX_RECENT_ACTIONS = 100;
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const MAX_INDEX_TERMS = 5_000;
const MAX_SEARCH_CANDIDATES = 60;
const DEFAULT_OVERVIEW_CHARS = 6_000;

export class TopicalError extends Error {}

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

function assertDescription(description) {
  if (typeof description !== "string" || description.trim().length < 3) {
    throw new TopicalError("A short, one-sentence description is required for every change.");
  }
}

function assertMarkdownSize(content) {
  if (Buffer.byteLength(content, "utf8") > MAX_MARKDOWN_BYTES) {
    throw new TopicalError("Markdown content cannot exceed 5 MiB per file.");
  }
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
  const tags = typeof values.tags === "string" && values.tags.startsWith("[")
    ? values.tags.slice(1, -1).split(",").map((tag) => parseScalar(tag)).filter(Boolean)
    : [];
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

function normalizeText(value) {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function tokenize(value) {
  return normalizeText(value).match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [];
}

function compactText(value) {
  return value.replace(/\s+/g, " ").trim();
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

  constructor(root) {
    if (!path.isAbsolute(root)) throw new TopicalError("TOPICAL_ROOT must be an absolute path.");
    this.root = path.resolve(root);
  }

  async initialize() {
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
    if (!await exists(indexPath)) {
      const emptyIndex = { version: ROOT_INDEX_VERSION, updatedAt: now(), topics: [], documents: [], recentActions: [] };
      await writeAtomic(this.root, indexPath, JSON.stringify(emptyIndex, null, 2) + "\n");
      this.#rootIndexCache = emptyIndex;
    }
  }

  async #serial(operation) {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #getRootIndex() {
    await this.initialize();
    if (this.#rootIndexCache) return this.#rootIndexCache;
    const indexPath = path.join(this.root, "index.json");
    await assertSafeFilesystemPath(this.root, indexPath);
    const index = await readJson(indexPath, { version: ROOT_INDEX_VERSION, updatedAt: now(), topics: [], documents: [], recentActions: [] });
    index.version = ROOT_INDEX_VERSION;
    index.topics = Array.isArray(index.topics) ? index.topics : [];
    index.documents = Array.isArray(index.documents) ? index.documents : [];
    index.recentActions = Array.isArray(index.recentActions) ? index.recentActions : [];
    this.#rootIndexCache = index;
    return index;
  }

  async #writeRootIndex(index) {
    index.version = ROOT_INDEX_VERSION;
    index.updatedAt = now();
    index.topics = Array.isArray(index.topics) ? index.topics : [];
    index.documents = Array.isArray(index.documents) ? index.documents : [];
    index.recentActions = Array.isArray(index.recentActions) ? index.recentActions : [];
    await writeAtomic(this.root, path.join(this.root, "index.json"), JSON.stringify(index, null, 2) + "\n");
    this.#rootIndexCache = index;
    return index;
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
      const terms = [...new Set(tokenize(`${metadata.title || topic}\n${metadata.summary || ""}\n${(metadata.tags || []).join(" ")}\n${filePath}\n${headings.join(" ")}\n${body}`))]
        .slice(0, MAX_INDEX_TERMS);
      documents.push({
        topic,
        path: filePath,
        headings,
        excerpt: body.slice(0, 360),
        terms,
        size: Buffer.byteLength(content, "utf8"),
        hash: hash(content)
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
    index.documents = await this.#buildTopicDocuments(topic, directory, index.files, metadata);
    await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify(index, null, 2) + "\n");
    return event;
  }

  async #reindexUnlocked(rootAction) {
    await this.initialize();
    const rootIndexPath = path.join(this.root, "index.json");
    await assertSafeFilesystemPath(this.root, rootIndexPath);
    const current = await readJson(rootIndexPath, { recentActions: [] });
    const entries = await readdir(this.root, { withFileTypes: true });
    const topics = [];
    const documents = [];
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
      index.documents = await this.#buildTopicDocuments(topic, directory, files, parsed.metadata);
      await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify(index, null, 2) + "\n");
      const lastAction = index.history.at(-1);
      if (lastAction) events.push({ topic, ...lastAction });
      documents.push(...index.documents);
      topics.push(this.#topicSummary(topic, parsed.metadata, index));
    }
    const actions = [...events, ...(current.recentActions || [])]
      .filter((event, index, all) => all.findIndex((candidate) => `${candidate.topic || ""}|${candidate.at}|${candidate.action}|${candidate.path || ""}` === `${event.topic || ""}|${event.at}|${event.action}|${event.path || ""}`) === index)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, MAX_RECENT_ACTIONS);
    topics.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const rootIndex = { version: ROOT_INDEX_VERSION, updatedAt: now(), topics, documents, recentActions: actions };
    return this.#writeRootIndex(rootIndex);
  }

  async recordPublicationAction(topic, publication, description) {
    return this.#serial(async () => {
      assertDescription(description);
      const event = await this.#record(topic, publication.action, null, description);
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
      return event;
    });
  }

  async reindex() {
    return this.#serial(() => this.#reindexUnlocked());
  }

  async listTopics({ sort = "recent", tags = [] } = {}) {
    const index = await this.#getRootIndex();
    const wantedTags = tags.map((tag) => tag.toLowerCase());
    const topics = index.topics
      .filter((topic) => wantedTags.every((tag) => topic.tags.map(String).map((value) => value.toLowerCase()).includes(tag)))
      .map((topic) => ({ ...topic, tags: [...topic.tags], lastAction: topic.lastAction ? { ...topic.lastAction } : null }));
    if (sort === "title") topics.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "created") topics.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return topics;
  }

  async createTopic({ title, summary, tags = [], initialContent = "", description }) {
    return this.#serial(async () => {
      assertDescription(description);
      const topic = slugify(title);
      const directory = this.#topicDirectory(topic);
      if (await exists(directory)) throw new TopicalError(`Topic '${topic}' already exists.`);
      const timestamp = now();
      const cleanTags = [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];
      await mkdir(directory, { recursive: true });
      assertMarkdownSize(initialContent);
      await assertSafeFilesystemPath(this.root, directory);
      await writeAtomic(this.root, path.join(directory, "context.md"), formatContext({ title: title.trim(), summary: summary.trim(), tags: cleanTags, createdAt: timestamp, updatedAt: timestamp }, initialContent));
      await writeAtomic(this.root, path.join(directory, "index.json"), JSON.stringify({ version: TOPIC_INDEX_VERSION, topic: { id: topic, title: title.trim(), summary: summary.trim(), tags: cleanTags, createdAt: timestamp, updatedAt: timestamp }, files: ["context.md"], history: [] }, null, 2) + "\n");
      await this.#record(topic, "create_topic", "context.md", description);
      await this.#upsertTopicInRoot(topic);
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
      if (typeof content !== "string") throw new TopicalError("content must be a string.");
      assertMarkdownSize(content);
      const current = await this.readTopicFile({ topic, filePath });
      if (expectedHash && expectedHash !== current.hash) throw new TopicalError("The file changed since it was read. Read it again before updating.");
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
      await this.#record(topic, "update_file", current.path, description);
      await this.#upsertTopicInRoot(topic);
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
      assertMarkdownSize(content);
      const directory = await this.#requireTopicDirectory(topic);
      const target = path.resolve(directory, normalized);
      if (!target.startsWith(`${directory}${path.sep}`)) throw new TopicalError("File path must stay inside the topic.");
      await assertSafeFilesystemPath(this.root, target);
      if (await exists(target)) throw new TopicalError(`File '${normalized}' already exists.`);
      await writeAtomic(this.root, target, content);
      await this.#record(topic, "create_file", normalized, description);
      await this.#upsertTopicInRoot(topic);
      return { topic, path: normalized, hash: hash(content) };
    });
  }

  async deleteTopicFile({ topic, filePath, description, confirm = false }) {
    return this.#serial(async () => {
      assertDescription(description);
      if (!confirm) throw new TopicalError("Set confirm to true to move this file to Topical's trash.");
      const normalized = assertMarkdownPath(filePath, { allowContext: false });
      const directory = await this.#requireTopicDirectory(topic);
      const target = path.resolve(directory, normalized);
      if (!target.startsWith(`${directory}${path.sep}`) || !await exists(target)) throw new TopicalError(`File '${normalized}' does not exist in '${topic}'.`);
      await assertSafeFilesystemPath(this.root, target);
      const trashTarget = path.join(this.root, ".trash", `${topic}-${Date.now()}`, normalized);
      await assertSafeFilesystemPath(this.root, trashTarget);
      await mkdir(path.dirname(trashTarget), { recursive: true });
      await assertSafeFilesystemPath(this.root, trashTarget);
      await rename(target, trashTarget);
      await this.#record(topic, "delete_file", normalized, description);
      await this.#upsertTopicInRoot(topic);
      return { topic, path: normalized, trashedTo: trashTarget };
    });
  }

  async updateTopicMetadata({ topic, title, summary, tags, description }) {
    return this.#serial(async () => {
      assertDescription(description);
      const current = await this.readTopicFile({ topic });
      const parsed = parseFrontmatter(current.content, { title: topic, summary: "", tags: [] });
      const metadata = {
        title: title?.trim() || parsed.metadata.title || topic,
        summary: summary?.trim() ?? parsed.metadata.summary ?? "",
        tags: tags ? [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))] : parsed.metadata.tags || [],
        createdAt: parsed.metadata.createdAt || now(),
        updatedAt: now()
      };
      const directory = await this.#requireTopicDirectory(topic);
      await writeAtomic(this.root, path.join(directory, "context.md"), formatContext(metadata, parsed.body));
      await this.#record(topic, "update_metadata", "context.md", description);
      await this.#upsertTopicInRoot(topic);
      return { topic, metadata };
    });
  }

  async deleteTopic({ topic, description, confirm = false }) {
    return this.#serial(async () => {
      assertDescription(description);
      if (!confirm) throw new TopicalError("Set confirm to true to move this topic to Topical's trash.");
      const directory = await this.#requireTopicDirectory(topic);
      const target = path.join(this.root, ".trash", `${topic}-${Date.now()}`);
      await assertSafeFilesystemPath(this.root, target);
      await mkdir(path.dirname(target), { recursive: true });
      await assertSafeFilesystemPath(this.root, target);
      await rename(directory, target);
      await this.#removeTopicFromRoot(topic, { at: now(), action: "delete_topic", path: null, description: description.trim() });
      return { topic, trashedTo: target };
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
      files: (index.documents || []).map(({ terms, ...document }) => document),
      publications: [...(index.publications || [])],
      recentHistory: [...(index.history || [])].slice(-12).reverse()
    };
  }

  async searchTopics({ query, tags = [], limit = 10 }) {
    const rootIndex = await this.#getRootIndex();
    const needle = normalizeText(String(query || "").trim());
    const queryTerms = [...new Set(tokenize(needle))];
    const wantedTags = tags.map((tag) => normalizeText(tag));
    const allowedTopics = new Map(rootIndex.topics
      .filter((topic) => wantedTags.every((tag) => topic.tags.some((value) => normalizeText(value) === tag)))
      .map((topic) => [topic.id, topic]));
    const metadataCandidates = rootIndex.documents
      .filter((document) => allowedTopics.has(document.topic))
      .map((document) => {
        const topic = allowedTopics.get(document.topic);
        const terms = new Set(document.terms || []);
        const matchedTerms = queryTerms.filter((term) => terms.has(term));
        if (queryTerms.length && !matchedTerms.length) return null;
        const headings = (document.headings || []).map(normalizeText);
        let score = document.path === "context.md" ? 5 : 0;
        score += matchedTerms.length * 3;
        if (needle && normalizeText(topic.title).includes(needle)) score += 30;
        if (needle && topic.tags.some((tag) => normalizeText(tag).includes(needle))) score += 15;
        if (needle && headings.some((heading) => heading.includes(needle))) score += 12;
        if (needle && normalizeText(document.path).includes(needle)) score += 8;
        return { document, topic, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.topic.updatedAt.localeCompare(a.topic.updatedAt));

    // A rare query may fall outside a capped document-term list. Fall back to a full scan only then,
    // preserving search recall while normal searches touch a bounded set of candidate files.
    const candidates = (metadataCandidates.length ? metadataCandidates : rootIndex.documents
      .filter((document) => allowedTopics.has(document.topic))
      .map((document) => ({ document, topic: allowedTopics.get(document.topic), score: document.path === "context.md" ? 5 : 0 })))
      .slice(0, MAX_SEARCH_CANDIDATES);
    const results = [];
    for (const { document, topic, score: metadataScore } of candidates) {
      const directory = await this.#requireTopicDirectory(document.topic);
      const target = path.join(directory, document.path);
      await assertSafeFilesystemPath(this.root, target);
      if (!await exists(target)) continue;
      const content = await readFile(target, "utf8");
      const snippetSource = compactText(content);
      const normalizedContent = normalizeText(snippetSource);
      const phrasePosition = needle ? normalizedContent.indexOf(needle) : 0;
      const matchedTerms = queryTerms.filter((term) => normalizedContent.includes(term));
      if (queryTerms.length && !matchedTerms.length) continue;
      const firstMatch = phrasePosition >= 0 ? phrasePosition : Math.min(...matchedTerms.map((term) => normalizedContent.indexOf(term)).filter((position) => position >= 0));
      const start = Math.max(0, firstMatch - 110);
      results.push({
        topic: document.topic,
        title: topic.title,
        path: document.path,
        score: metadataScore + matchedTerms.length * 2 + (phrasePosition >= 0 ? 25 : 0),
        snippet: snippetSource.slice(start, start + 320),
        hash: document.hash
      });
    }
    return results.sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic)).slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
  }
}
