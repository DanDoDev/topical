import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { TopicalApplication } from "./application.js";
import { loadTopicalConfig } from "./config.js";
import { TopicalError } from "./errors.js";
import { TOPICAL_VERSION } from "./version.js";

function textResult(value, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function tool(handler) {
  return async (input) => {
    try {
      return textResult(await handler(input));
    } catch (error) {
      const known = error instanceof TopicalError;
      const message = known || error instanceof Error ? error.message : "Unexpected Topical error.";
      return textResult({
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message,
          ...(known && error.details !== undefined ? { details: error.details } : {})
        }
      }, true);
    }
  };
}

const optionalTags = z.array(z.string().min(1)).max(50).optional();
const topicId = z.string().min(1).describe("Topical topic ID such as garden-lighting. It is a folder under TOPICAL_ROOT, not a Codex task, chat, workspace, or project. Search or list topics first if uncertain.");
const optionalTopicId = topicId.optional();
const topicTitle = z.string().min(1).max(160).describe("Human title for a new Topical note folder. Topical derives a lowercase topic ID from this title.");
const topicFilePath = z.string().min(1).describe("Safe relative Markdown path inside the selected Topical topic, such as research.md or prs/123.md.");
const optionalTopicFilePath = topicFilePath.optional();
const publicationSourceFiles = z.array(topicFilePath).min(1).max(100).optional().describe("Selected central topic files used for publication lineage. Defaults to context.md; read these files before drafting content.");
const destinationAlias = z.string().min(1).describe("Configured publication-root alias such as docs, not an absolute filesystem path.");
const destinationPath = z.string().min(1).describe("New safe relative Markdown path under the configured destination alias. A new publication refuses an existing path.");
const publicationContent = z.string().max(5 * 1024 * 1024).describe("Complete polished Markdown supplied by the caller. Topical does not generate or summarize it.");
const destinationHash = z.string().length(64).describe("Current destination SHA-256 from read_publication.status.currentTargetHash. Use this to prevent overwriting external edits.");
const contentHash = z.string().regex(/^[a-f0-9]{64}$/).describe("Current SHA-256 returned by read_topic_file. Required to protect reviewed mutations from stale content.");
const cursor = z.string().min(1).optional().describe("Opaque cursor returned by the previous page.");
const SERVER_INSTRUCTIONS = [
  "TOPICAL_ROOT is the shared parent directory for all Topical topics.",
  "A topic is the explicit folder ID supplied to tools, not a Codex task, chat, workspace, or current project.",
  "When a user mentions topical, existing notes, or prior working context, inspect Topical tools before using the terminal or asking for a path.",
  "Use search_topics or list_topics before creating or writing when the topic is uncertain.",
  "Do not infer a topic from a similarly named Codex project; ask only if search and list cannot identify a single likely topic.",
  "Treat context.md as a concise routing document: purpose, current status, immediate decisions, and links to focused supporting files.",
  "Put substantial plans, research, logs, and handoffs in focused topic files; update context.md with only a concise status or link.",
  "For requested context cleanup, analyze_topic_context returns section offsets; preview_topic_reorganization shows exact extractions, and apply_topic_reorganization requires the reviewed previewHash. Preserve source material and review stale status explicitly; do not infer obsolete decisions from age alone.",
  "Use list_tasks for outstanding actions across topics rather than reading every file. Store actions once in their owning work area; handoffs link to them. Use create_work_area for an issue, plan, or draft, and keep detailed evidence in supporting files. Drafts exclude procedural checklists from actionable tasks; keep drafting actions in the parent context.",
  "Publication guidance is read-only; only explicit publish_document or update_publication calls can change a published file."
].join(" ");
const description = z.string().min(3).max(500).describe("One sentence explaining this change; recorded in the topic history.");

export async function startServer({ application, transport } = {}) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== 24) throw new Error(`Topical v${TOPICAL_VERSION} requires Node.js 24 LTS; found ${process.version}.`);
  const app = application || new TopicalApplication(await loadTopicalConfig());
  await app.initialize();
  const server = new McpServer({ name: "topical", version: TOPICAL_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool("list_tasks", {
    title: "List tasks",
    description: "Query indexed Markdown tasks globally, by topic, or by work-area path. Returns bounded tasks, scoped counts, source hashes and checkbox offsets. External edits require reindex. Follow cursors; read only the owning context needed for the selected task.",
    inputSchema: { topic: optionalTopicId, pathPrefix: z.string().max(1000).optional(), status: z.enum(["open", "completed", "all"]).optional(), cursor, limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.listTasks(input)));

  server.registerTool("set_task_completed", {
    title: "Complete or reopen task",
    description: "Update the original Markdown checkbox using its indexed offset and sourceHash as expectedHash. On conflict refresh and review before retrying; no separate task store is authoritative.",
    inputSchema: { topic: topicId, filePath: topicFilePath, offset: z.number().int().min(0), completed: z.boolean(), expectedHash: contentHash, description }
  }, tool((input) => app.setTaskCompleted(input)));

  server.registerTool("create_work_area", {
    title: "Create issue, plan, or draft",
    description: "Create a focused issue or plan context, or a draft file, beneath the reviewed parent file's folder and link it from that parent. Search/read first to avoid duplicates. Retry safely with the same inputs after inspecting partial work; existing content is never overwritten.",
    inputSchema: { topic: topicId, kind: z.enum(["issue", "plan", "draft"]), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100), title: topicTitle, brief: z.string().max(4000).optional(), parentFile: optionalTopicFilePath, expectedHash: contentHash, description }
  }, tool((input) => app.createWorkArea(input)));

  const reorganizationSchema = { topic: topicId, filePath: optionalTopicFilePath, expectedHash: contentHash, extractions: z.array(z.object({ start: z.number().int().min(0), destination: topicFilePath })).min(1).max(20) };
  server.registerTool("preview_topic_reorganization", {
    title: "Preview context reorganization",
    description: "Preview extraction of selected Markdown sections into supporting files. Use section start offsets and source hash from analyze_topic_context. Destinations are relative to the topic root. Returns exact before/after, new file contents, and a previewHash. No writes; review all content before applying.",
    inputSchema: reorganizationSchema,
    annotations: { readOnlyHint: true }
  }, tool((input) => app.previewTopicReorganization(input)));
  server.registerTool("apply_topic_reorganization", {
    title: "Apply reviewed context reorganization",
    description: "Apply the exact reviewed extraction inputs with their expectedHash and previewHash. Preserve supporting files before shortening source. Reject stale source, altered preview, or occupied destinations. On partial failure inspect source and preserved files before retrying; never silently retry changed content.",
    inputSchema: { ...reorganizationSchema, previewHash: contentHash, description }
  }, tool((input) => app.applyTopicReorganization(input)));

  server.registerTool("search_topics", {
    title: "Search topics",
    description: "Search Topical note folders with topic-grouped strict matching, an explicitly marked relaxed fallback, and conservative visible expansion only after both exact-token passes are empty. Use first to find the explicit topic for a write; topics are not Codex chats or projects.",
    inputSchema: { query: z.string().default(""), tags: optionalTags, limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.searchTopics(input)));

  server.registerTool("search_topic_files", {
    title: "Search files in a topic",
    description: "Page through every file matched by an existing topic-grouped search without expanding the initial search response unboundedly.",
    inputSchema: {
      query: z.string().default(""),
      topic: topicId,
      matchMode: z.enum(["strict", "relaxed", "expanded"]).optional(),
      cursor,
      limit: z.number().int().min(1).max(100).optional()
    },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.searchTopicFiles(input)));

  server.registerTool("list_topics", {
    title: "List topics",
    description: "List a bounded page of known Topical note folders. Use when a user refers to existing notes and the explicit topic is unclear.",
    inputSchema: { sort: z.enum(["recent", "title", "created"]).optional(), tags: optionalTags, cursor, limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.listTopics(input)));

  server.registerTool("list_topic_files", {
    title: "List topic files",
    description: "Return one bounded page of file descriptors for an explicitly selected topic. Use cursors instead of requesting an unbounded topic catalogue.",
    inputSchema: {
      topic: topicId,
      query: z.string().max(2000).optional(),
      sort: z.enum(["recent", "name", "size"]).optional(),
      cursor,
      limit: z.number().int().min(1).max(100).optional()
    },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.listTopicFiles(input)));

  server.registerTool("list_tags", {
    title: "List tags",
    description: "Return bounded tag usage, sparse-tag guidance, and advisory variant warnings without changing Markdown. Inspect this taxonomy before proposing new tags.",
    inputSchema: { query: z.string().max(2000).optional(), cursor, limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.listTags(input)));

  server.registerTool("list_history", {
    title: "List history",
    description: "Return a bounded, newest-first audit history page globally or for one explicit topic.",
    inputSchema: { topic: optionalTopicId, action: z.string().max(100).optional(), pathQuery: z.string().max(2000).optional(), cursor, limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.listHistory(input)));

  server.registerTool("get_system_health", {
    title: "Get system health",
    description: "Report catalogue and disposable search-cache health without changing Markdown or derived state.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, tool(() => app.getSystemHealth()));

  server.registerTool("create_topic", {
    title: "Create topic",
    description: "Create a new Topical note folder under TOPICAL_ROOT. This does not create a Codex task, chat, Git branch, or project; search first to avoid duplicates.",
    inputSchema: {
      title: topicTitle,
      summary: z.string().max(500).default(""),
      tags: optionalTags,
      initialContent: z.string().optional(),
      template: z.enum(["oncall", "project", "documentation", "planning"]).optional(),
      description
    }
  }, tool((input) => app.createTopic(input)));

  server.registerTool("read_topic_file", {
    title: "Read topic file",
    description: "Read Markdown from an explicitly selected Topical topic and return its SHA-256 hash for conflict-safe updates.",
    inputSchema: { topic: topicId, filePath: optionalTopicFilePath },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.readTopicFile(input)));

  server.registerTool("get_topic_overview", {
    title: "Get topic overview",
    description: "Return a bounded briefing for an explicitly selected Topical topic. Use after search or list to choose focused files to read.",
    inputSchema: {
      topic: topicId,
      include: z.array(z.enum(["context", "files", "history", "publications"])).max(4).optional(),
      maxChars: z.number().int().min(500).max(12000).optional(),
      fileCursor: cursor,
      fileLimit: z.number().int().min(1).max(100).optional(),
      fileSort: z.enum(["recent", "name", "size"]).optional()
    },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.getTopicOverview(input)));

  server.registerTool("analyze_topic_context", {
    title: "Analyze topic context",
    description: "Analyze context.md size, structure, and local links against the advisory thin-context contract. This is read-only and never reorganizes or deletes content.",
    inputSchema: { topic: topicId, filePath: optionalTopicFilePath },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.analyzeTopicContext(input)));

  server.registerTool("update_topic_file", {
    title: "Update topic file",
    description: "Append, replace, or replace a named Markdown section in the explicit topic. Read first and use expectedHash. Keep context.md concise; substantial plans, research, logs, and handoffs belong in focused supporting files with a short context.md link.",
    inputSchema: {
      topic: topicId,
      filePath: optionalTopicFilePath,
      mode: z.enum(["append", "replace", "replace_section"]).optional(),
      content: z.string(),
      section: z.string().optional(),
      expectedHash: contentHash,
      description
    }
  }, tool((input) => app.updateTopicFile(input)));

  server.registerTool("create_topic_file", {
    title: "Create topic file",
    description: "Create a focused supporting Markdown file inside the explicitly selected topic for substantial plans, research, logs, or handoffs that should not make context.md a context dump.",
    inputSchema: { topic: topicId, filePath: topicFilePath, content: z.string().optional(), description }
  }, tool((input) => app.createTopicFile(input)));

  server.registerTool("delete_topic_file", {
    title: "Delete topic file",
    description: "Move a supporting Markdown file from the explicitly selected topic to Topical's .trash directory. context.md cannot be deleted.",
    inputSchema: { topic: topicId, filePath: topicFilePath, expectedHash: contentHash, confirm: z.literal(true), description }
  }, tool((input) => app.deleteTopicFile(input)));

  server.registerTool("update_topic_metadata", {
    title: "Update topic metadata",
    description: "Update context.md frontmatter in the explicitly selected Topical topic.",
    inputSchema: { topic: topicId, title: topicTitle.optional(), summary: z.string().max(500).optional(), tags: optionalTags, expectedHash: contentHash, description }
  }, tool((input) => app.updateTopicMetadata(input)));

  server.registerTool("delete_topic", {
    title: "Delete topic",
    description: "Move the explicitly selected Topical topic folder to Topical's .trash directory.",
    inputSchema: { topic: topicId, expectedHash: contentHash, confirm: z.literal(true), description }
  }, tool((input) => app.deleteTopic(input)));

  server.registerTool("list_trash", {
    title: "List trash",
    description: "List bounded recoverable soft-deletion entries and retention status without modifying them.",
    inputSchema: { type: z.enum(["file", "topic"]).optional(), topic: optionalTopicId, cursor, limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.listTrash(input)));

  server.registerTool("restore_trash", {
    title: "Restore trash",
    description: "Restore one reviewed soft-deletion entry to its original path. Refuses destination conflicts and requires the trashed content hash.",
    inputSchema: { id: z.string().uuid(), expectedHash: contentHash, description }
  }, tool((input) => app.restoreTrash(input)));

  server.registerTool("publish_document", {
    title: "Publish document",
    description: "Explicitly write caller-supplied standalone Markdown to a configured destination. It is not synchronization, and the new destination path must not already exist.",
    inputSchema: { topic: topicId, sourceFiles: publicationSourceFiles, destinationAlias, destinationPath, content: publicationContent, label: z.string().max(160).optional(), description }
  }, tool((input) => app.publishDocument(input)));

  server.registerTool("list_publications", {
    title: "List publications",
    description: "Read-only list of publication checkpoints, divergence states, and advisory guidance. It never republishes or changes files.",
    inputSchema: { topic: optionalTopicId, includeArchived: z.boolean().optional(), cursor, limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.listPublications(input)));

  server.registerTool("get_publication_status", {
    title: "Get publication status",
    description: "Read-only comparison of a checkpoint, selected topic sources, and destination document. Its guidance is advisory and never writes.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.getPublicationStatus(input)));

  server.registerTool("read_publication", {
    title: "Read publication",
    description: "Read a publication record, immutable checkpoint snapshot, and current destination document for explicit review or three-way reconciliation.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true }
  }, tool((input) => app.readPublication(input)));

  server.registerTool("update_publication", {
    title: "Update publication",
    description: "Explicitly write a complete new publication checkpoint after review. Requires the current destination hash and never performs automatic synchronization.",
    inputSchema: { id: z.string().uuid(), content: publicationContent, expectedTargetHash: destinationHash, sourceFiles: publicationSourceFiles, description }
  }, tool((input) => app.updatePublication(input)));

  server.registerTool("forget_publication", {
    title: "Forget publication",
    description: "Archive a publication relationship only. It does not delete or modify the independent destination document.",
    inputSchema: { id: z.string().uuid(), confirm: z.literal(true), description }
  }, tool((input) => app.forgetPublication(input)));

  server.registerTool("reindex_topical", {
    title: "Reindex Topical",
    description: "Rebuild derived indexes after direct Markdown edits. This does not create topics, transfer notes, or publish documents.",
    inputSchema: {}
  }, tool(() => app.reindex()));

  try {
    await server.connect(transport || new StdioServerTransport());
  } catch (error) {
    await app.close();
    throw error;
  }
  return { server, application: app };
}
