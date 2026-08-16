import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { conflictError, TopicalError } from "./errors.js";
import { assertDescription, assertMarkdown } from "./normalization.js";
import { paginate } from "./pagination.js";

const now = () => new Date().toISOString();
const hash = (value) => createHash("sha256").update(value).digest("hex");

function assertAlias(alias) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(alias || "")) {
    throw new TopicalError("Publication root aliases must be lowercase slugs.");
  }
}

function assertMarkdownPath(filePath) {
  if (typeof filePath !== "string" || !filePath.endsWith(".md")) {
    throw new TopicalError("Publication paths must be Markdown paths ending in .md.");
  }
  if (path.isAbsolute(filePath) || filePath.includes("\\") || filePath.split("/").includes("..")) {
    throw new TopicalError("Publication path must be a safe relative path.");
  }
  const normalized = path.posix.normalize(filePath);
  if (normalized === "." || normalized.startsWith("../")) {
    throw new TopicalError("Publication path must stay inside its configured destination root.");
  }
  return normalized;
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function assertSafePath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new TopicalError("Path must stay inside its configured root.");
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) throw new TopicalError("Symbolic links are not permitted in publication roots.");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function ensureRoot(root, label, { create = true } = {}) {
  if (!path.isAbsolute(root)) throw new TopicalError(`${label} must be an absolute path.`);
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    throw new TopicalError(`${label} must be a dedicated directory, not the filesystem or home root.`);
  }
  if (create) await mkdir(resolved, { recursive: true });
  if (!await exists(resolved)) throw new TopicalError(`${label} is unavailable.`);
  const details = await lstat(resolved);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new TopicalError(`${label} must be a real directory, not a symbolic link or file.`);
  }
  return realpath(resolved);
}

async function writeAtomic(root, target, content) {
  await assertSafePath(root, target);
  await mkdir(path.dirname(target), { recursive: true });
  await assertSafePath(root, target);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

async function readJson(target, fallback) {
  try { return JSON.parse(await readFile(target, "utf8")); } catch { return fallback; }
}

function sourceFingerprint(sources) {
  return hash(sources
    .map((source) => `${source.path}:${source.hash}`)
    .sort()
    .join("\n"));
}

function publicationGuidance(state) {
  const guidance = {
    unchanged: ["none", "The topic sources and document still match this checkpoint."],
    topic_evolved: ["consider_republish", "Review the evolved topic and explicitly prepare a revised document if useful."],
    document_evolved: ["review_destination_changes", "Review external document changes before deciding whether to preserve, import, or replace them."],
    both_evolved: ["reconcile_three_way", "Review the current topic, current document, and checkpoint snapshot before any update."],
    document_missing: ["review_missing_document", "Confirm whether the missing document should be recreated through an explicit new publication."],
    source_incomplete: ["repair_or_reselect_sources", "Restore the selected source files or choose an explicit new source set."],
    destination_unavailable: ["repair_destination_configuration", "Restore access to the configured destination before taking publication action."]
  }[state];
  return { action: guidance[0], message: guidance[1], requiresExplicitAction: true };
}

export class PublicationStore {
  #queue = Promise.resolve();
  #registryCache;

  constructor({ topicalRoot, publicationRoots = {}, topicStore }) {
    this.topicalRoot = path.resolve(topicalRoot);
    this.publicationRoots = new Map(Object.entries(publicationRoots).map(([alias, root]) => {
      assertAlias(alias);
      if (!path.isAbsolute(root)) throw new TopicalError(`Publication root '${alias}' must be an absolute path.`);
      return [alias, path.resolve(root)];
    }));
    this.topicStore = topicStore;
  }

  async initialize() {
    this.topicalRoot = await ensureRoot(this.topicalRoot, "TOPICAL_ROOT");
    const directory = path.join(this.topicalRoot, ".publications");
    await mkdir(directory, { recursive: true });
    await assertSafePath(this.topicalRoot, directory);
    const indexPath = path.join(directory, "index.json");
    if (!await exists(indexPath)) {
      await writeAtomic(this.topicalRoot, indexPath, JSON.stringify({ version: 1, publications: [] }, null, 2) + "\n");
    }
  }

  async #serial(operation) {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #directory() {
    return path.join(this.topicalRoot, ".publications");
  }

  #recordDirectory(id) {
    return path.join(this.#directory(), id);
  }

  async #registry() {
    await this.initialize();
    if (this.#registryCache) return this.#registryCache;
    const target = path.join(this.#directory(), "index.json");
    await assertSafePath(this.topicalRoot, target);
    const registry = await readJson(target, { version: 1, publications: [] });
    registry.version = 1;
    registry.publications = Array.isArray(registry.publications) ? registry.publications : [];
    this.#registryCache = registry;
    return registry;
  }

  async #writeRegistry(registry) {
    registry.version = 1;
    registry.publications = Array.isArray(registry.publications) ? registry.publications : [];
    await writeAtomic(this.topicalRoot, path.join(this.#directory(), "index.json"), JSON.stringify(registry, null, 2) + "\n");
    this.#registryCache = registry;
  }

  async #readRecord(id) {
    const target = path.join(this.#recordDirectory(id), "record.json");
    await assertSafePath(this.topicalRoot, target);
    if (!await exists(target)) throw new TopicalError(`Publication '${id}' does not exist.`);
    return JSON.parse(await readFile(target, "utf8"));
  }

  async #writeRecord(record) {
    const target = path.join(this.#recordDirectory(record.id), "record.json");
    await writeAtomic(this.topicalRoot, target, JSON.stringify(record, null, 2) + "\n");
  }

  async #destination(alias, relativePath, { create = false } = {}) {
    assertAlias(alias);
    const root = this.publicationRoots.get(alias);
    if (!root) throw new TopicalError(`Publication root '${alias}' is not configured.`);
    const realRoot = await ensureRoot(root, `Publication root '${alias}'`, { create });
    const normalizedPath = assertMarkdownPath(relativePath);
    const target = path.resolve(realRoot, normalizedPath);
    await assertSafePath(realRoot, target);
    return { alias, root: realRoot, path: normalizedPath, target };
  }

  async #sources(topic, sourceFiles = ["context.md"]) {
    if (!Array.isArray(sourceFiles) || !sourceFiles.length) {
      throw new TopicalError("At least one source Markdown file is required for publication.");
    }
    const sources = [];
    for (const filePath of [...new Set(sourceFiles)].sort()) {
      const source = await this.topicStore.readTopicFile({ topic, filePath });
      sources.push({ path: source.path, hash: source.hash });
    }
    return sources;
  }

  async #status(record) {
    let sources;
    let sourceState = "available";
    try {
      sources = await this.#sources(record.topic, record.sourceFiles.map((file) => file.path));
    } catch (error) {
      sources = [];
      sourceState = "source_incomplete";
    }
    let destination;
    let destinationState = "available";
    let currentTargetHash = null;
    try {
      destination = await this.#destination(record.destination.alias, record.destination.path, { create: false });
      if (await exists(destination.target)) {
        await assertSafePath(destination.root, destination.target);
        currentTargetHash = hash(await readFile(destination.target, "utf8"));
      } else {
        destinationState = "document_missing";
      }
    } catch (error) {
      destinationState = "destination_unavailable";
    }

    const currentSourceFingerprint = sources.length ? sourceFingerprint(sources) : null;
    let state;
    if (sourceState !== "available") state = "source_incomplete";
    else if (destinationState !== "available") state = destinationState;
    else if (currentSourceFingerprint === record.sourceFingerprint && currentTargetHash === record.targetHash) state = "unchanged";
    else if (currentSourceFingerprint !== record.sourceFingerprint && currentTargetHash === record.targetHash) state = "topic_evolved";
    else if (currentSourceFingerprint === record.sourceFingerprint && currentTargetHash !== record.targetHash) state = "document_evolved";
    else state = "both_evolved";
    return { state, guidance: publicationGuidance(state), currentSourceFingerprint, currentTargetHash, sources, destination: destination ? { alias: destination.alias, path: destination.path } : record.destination };
  }

  async publishDocument({ topic, sourceFiles = ["context.md"], destinationAlias, destinationPath, content, label, description }) {
    return this.#serial(async () => {
      assertDescription(description);
      assertMarkdown(content);
      const sources = await this.#sources(topic, sourceFiles);
      const destination = await this.#destination(destinationAlias, destinationPath, { create: true });
      if (await exists(destination.target)) throw new TopicalError("Destination already exists. Use update_publication after reviewing its current hash.");
      const id = randomUUID();
      const publishedAt = now();
      const targetHash = hash(content);
      const record = {
        version: 1,
        id,
        topic,
        label: label?.trim() || null,
        sourceFiles: sources,
        sourceFingerprint: sourceFingerprint(sources),
        destination: { alias: destination.alias, path: destination.path },
        targetHash,
        snapshot: "snapshot.md",
        publishedAt,
        description: description.trim(),
        archivedAt: null,
        history: [{ at: publishedAt, action: "publish_document", description: description.trim(), sourceFingerprint: sourceFingerprint(sources), targetHash }]
      };
      await writeAtomic(this.topicalRoot, path.join(this.#recordDirectory(id), "snapshot.md"), content);
      await writeAtomic(destination.root, destination.target, content);
      await this.#writeRecord(record);
      const registry = await this.#registry();
      registry.publications.push({ id, topic, label: record.label, destination: record.destination, publishedAt, archivedAt: null });
      await this.#writeRegistry(registry);
      await this.topicStore.recordPublicationAction(topic, { id, destination: record.destination, publishedAt, action: "publish_document" }, description);
      return { id, topic, destination: record.destination, targetHash, sourceFingerprint: record.sourceFingerprint };
    });
  }

  async listPublications({ topic, includeArchived = false, cursor, limit = 50 } = {}) {
    const registry = await this.#registry();
    const entries = registry.publications
      .filter((record) => (!topic || record.topic === topic) && (includeArchived || !record.archivedAt))
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || left.id.localeCompare(right.id));
    const page = paginate(entries, { cursor, limit, maxLimit: 100 });
    const results = [];
    for (const entry of page.items) {
      const record = await this.#readRecord(entry.id);
      results.push({ id: record.id, topic: record.topic, label: record.label, destination: record.destination, publishedAt: record.publishedAt, archivedAt: record.archivedAt, ...(await this.#status(record)) });
    }
    return { publications: results, page: page.page };
  }

  async getPublicationStatus({ id }) {
    const record = await this.#readRecord(id);
    return { id: record.id, topic: record.topic, destination: record.destination, publishedAt: record.publishedAt, archivedAt: record.archivedAt, ...(await this.#status(record)) };
  }

  async readPublication({ id }) {
    const record = await this.#readRecord(id);
    const status = await this.#status(record);
    const snapshot = await readFile(path.join(this.#recordDirectory(id), record.snapshot), "utf8");
    let currentContent = null;
    if (status.state !== "destination_unavailable" && status.state !== "document_missing") {
      const destination = await this.#destination(record.destination.alias, record.destination.path, { create: false });
      currentContent = await readFile(destination.target, "utf8");
    }
    return { record, status, snapshot, currentContent };
  }

  async updatePublication({ id, content, expectedTargetHash, sourceFiles, description }) {
    return this.#serial(async () => {
      assertDescription(description);
      assertMarkdown(content);
      const record = await this.#readRecord(id);
      if (record.archivedAt) throw new TopicalError("Archived publication records cannot be updated.");
      const destination = await this.#destination(record.destination.alias, record.destination.path, { create: false });
      if (!await exists(destination.target)) throw new TopicalError("Destination document is missing. Create a new publication explicitly instead.");
      const currentContent = await readFile(destination.target, "utf8");
      const currentHash = hash(currentContent);
      if (!expectedTargetHash || expectedTargetHash !== currentHash) {
        throw conflictError("Destination changed since it was read. Read the publication and reconcile before updating.", {
          id,
          expectedTargetHash,
          currentTargetHash: currentHash
        });
      }
      const sources = await this.#sources(record.topic, sourceFiles || record.sourceFiles.map((source) => source.path));
      const timestamp = now();
      const revision = `revisions/${timestamp.replace(/[:.]/g, "-")}.md`;
      await writeAtomic(this.topicalRoot, path.join(this.#recordDirectory(id), revision), content);
      await writeAtomic(destination.root, destination.target, content);
      record.sourceFiles = sources;
      record.sourceFingerprint = sourceFingerprint(sources);
      record.targetHash = hash(content);
      record.snapshot = revision;
      record.history.push({ at: timestamp, action: "update_publication", description: description.trim(), sourceFingerprint: record.sourceFingerprint, targetHash: record.targetHash });
      await this.#writeRecord(record);
      await this.topicStore.recordPublicationAction(record.topic, { id, destination: record.destination, publishedAt: timestamp, action: "update_publication" }, description);
      return { id, destination: record.destination, targetHash: record.targetHash, sourceFingerprint: record.sourceFingerprint };
    });
  }

  async forgetPublication({ id, description, confirm = false }) {
    return this.#serial(async () => {
      assertDescription(description);
      if (!confirm) throw new TopicalError("Set confirm to true to archive this publication relationship. The destination file will not be changed.");
      const record = await this.#readRecord(id);
      if (record.archivedAt) return { id, archivedAt: record.archivedAt, destination: record.destination };
      const timestamp = now();
      record.archivedAt = timestamp;
      record.history.push({ at: timestamp, action: "forget_publication", description: description.trim() });
      await this.#writeRecord(record);
      const registry = await this.#registry();
      const entry = registry.publications.find((publication) => publication.id === id);
      if (entry) entry.archivedAt = timestamp;
      await this.#writeRegistry(registry);
      await this.topicStore.recordPublicationAction(record.topic, { id, destination: record.destination, publishedAt: timestamp, action: "forget_publication" }, description);
      return { id, archivedAt: timestamp, destination: record.destination };
    });
  }
}
