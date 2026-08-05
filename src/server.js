#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { TopicalError, TopicalStore } from "./store.js";
import { PublicationStore } from "./publications.js";

async function loadDotEnv() {
  try {
    const text = await readFile(path.resolve(process.cwd(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch { /* A .env file is optional. */ }
}

function textResult(value, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function tool(handler) {
  return async (input) => {
    try {
      return textResult(await handler(input));
    } catch (error) {
      const message = error instanceof TopicalError || error instanceof Error ? error.message : "Unexpected Topical error.";
      return textResult({ error: message }, true);
    }
  };
}

const optionalTags = z.array(z.string().min(1)).max(50).optional();
const topicId = z.string().min(1).describe("Topical topic ID such as scripts-all. It is a folder under TOPICAL_ROOT, not a Codex task, chat, workspace, or project. Search or list topics first if uncertain.");
const optionalTopicId = topicId.optional();
const topicTitle = z.string().min(1).max(160).describe("Human title for a new Topical note folder. Topical derives a lowercase topic ID from this title.");
const topicFilePath = z.string().min(1).describe("Safe relative Markdown path inside the selected Topical topic, such as research.md or prs/123.md.");
const optionalTopicFilePath = topicFilePath.optional();
const publicationSourceFiles = z.array(topicFilePath).min(1).max(100).optional().describe("Selected central topic files used for publication lineage. Defaults to context.md; read these files before drafting content.");
const destinationAlias = z.string().min(1).describe("Configured publication-root alias such as docs, not an absolute filesystem path.");
const destinationPath = z.string().min(1).describe("New safe relative Markdown path under the configured destination alias. A new publication refuses an existing path.");
const publicationContent = z.string().max(5 * 1024 * 1024).describe("Complete polished Markdown supplied by the caller. Topical does not generate or summarize it.");
const destinationHash = z.string().length(64).describe("Current destination SHA-256 from read_publication.status.currentTargetHash. Use this to prevent overwriting external edits.");
const SERVER_INSTRUCTIONS = [
  "TOPICAL_ROOT is the shared parent directory for all Topical topics.",
  "A topic is the explicit folder ID supplied to tools, not a Codex task, chat, workspace, or current project.",
  "When a user mentions topical, existing notes, or prior working context, inspect Topical tools before using the terminal or asking for a path.",
  "Use search_topics or list_topics before creating or writing when the topic is uncertain.",
  "Do not infer a topic from a similarly named Codex project; ask only if search and list cannot identify a single likely topic.",
  "Publication guidance is read-only; only explicit publish_document or update_publication calls can change a published file."
].join(" ");
const description = z.string().min(3).max(500).describe("One sentence explaining this change; recorded in the topic history.");

function parsePublicationRoots(value = "") {
  const roots = {};
  for (const item of value.split(";").map((entry) => entry.trim()).filter(Boolean)) {
    const separator = item.indexOf("=");
    if (separator < 1) throw new Error("TOPICAL_PUBLISH_ROOTS entries must use alias=absolute-path.");
    roots[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
  }
  return roots;
}

async function main() {
  await loadDotEnv();
  const root = process.env.TOPICAL_ROOT;
  if (!root) throw new Error("TOPICAL_ROOT is required. Set it in MCP configuration or a local .env file.");

  const store = new TopicalStore(root);
  await store.initialize();
  await store.reindex();
  const publications = new PublicationStore({
    topicalRoot: root,
    publicationRoots: parsePublicationRoots(process.env.TOPICAL_PUBLISH_ROOTS),
    topicStore: store
  });
  await publications.initialize();
  const server = new McpServer({ name: "topical", version: "0.3.0" }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool("search_topics", {
    title: "Search topics",
    description: "Search Topical note folders by title, summary, tags, and Markdown. Use first to find the explicit topic for a write; topics are not Codex chats or projects.",
    inputSchema: { query: z.string().default(""), tags: optionalTags, limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true }
  }, tool((input) => store.searchTopics(input)));

  server.registerTool("list_topics", {
    title: "List topics",
    description: "List known Topical note folders. Use when a user refers to existing notes and the explicit topic is unclear.",
    inputSchema: { sort: z.enum(["recent", "title", "created"]).optional(), tags: optionalTags },
    annotations: { readOnlyHint: true }
  }, tool((input) => store.listTopics(input)));

  server.registerTool("create_topic", {
    title: "Create topic",
    description: "Create a new Topical note folder under TOPICAL_ROOT. This does not create a Codex task, chat, Git branch, or project; search first to avoid duplicates.",
    inputSchema: {
      title: topicTitle,
      summary: z.string().max(500).default(""),
      tags: optionalTags,
      initialContent: z.string().optional(),
      description
    }
  }, tool((input) => store.createTopic(input)));

  server.registerTool("read_topic_file", {
    title: "Read topic file",
    description: "Read Markdown from an explicitly selected Topical topic and return its SHA-256 hash for conflict-safe updates.",
    inputSchema: { topic: topicId, filePath: optionalTopicFilePath },
    annotations: { readOnlyHint: true }
  }, tool((input) => store.readTopicFile(input)));

  server.registerTool("get_topic_overview", {
    title: "Get topic overview",
    description: "Return a bounded briefing for an explicitly selected Topical topic. Use after search or list to choose focused files to read.",
    inputSchema: { topic: topicId, maxChars: z.number().int().min(500).max(12000).optional() },
    annotations: { readOnlyHint: true }
  }, tool((input) => store.getTopicOverview(input)));

  server.registerTool("update_topic_file", {
    title: "Update topic file",
    description: "Append, replace, or replace a named Markdown section in the explicit topic. Read first and use expectedHash when avoiding stale overwrites matters.",
    inputSchema: {
      topic: topicId,
      filePath: optionalTopicFilePath,
      mode: z.enum(["append", "replace", "replace_section"]).optional(),
      content: z.string(),
      section: z.string().optional(),
      expectedHash: z.string().length(64).optional(),
      description
    }
  }, tool((input) => store.updateTopicFile(input)));

  server.registerTool("create_topic_file", {
    title: "Create topic file",
    description: "Create a supporting Markdown file inside the explicitly selected existing Topical topic.",
    inputSchema: { topic: topicId, filePath: topicFilePath, content: z.string().optional(), description }
  }, tool((input) => store.createTopicFile(input)));

  server.registerTool("delete_topic_file", {
    title: "Delete topic file",
    description: "Move a supporting Markdown file from the explicitly selected topic to Topical's .trash directory. context.md cannot be deleted.",
    inputSchema: { topic: topicId, filePath: topicFilePath, confirm: z.literal(true), description }
  }, tool((input) => store.deleteTopicFile(input)));

  server.registerTool("update_topic_metadata", {
    title: "Update topic metadata",
    description: "Update context.md frontmatter in the explicitly selected Topical topic.",
    inputSchema: { topic: topicId, title: topicTitle.optional(), summary: z.string().max(500).optional(), tags: optionalTags, description }
  }, tool((input) => store.updateTopicMetadata(input)));

  server.registerTool("delete_topic", {
    title: "Delete topic",
    description: "Move the explicitly selected Topical topic folder to Topical's .trash directory.",
    inputSchema: { topic: topicId, confirm: z.literal(true), description }
  }, tool((input) => store.deleteTopic(input)));

  server.registerTool("publish_document", {
    title: "Publish document",
    description: "Explicitly write caller-supplied standalone Markdown to a configured destination. It is not synchronization, and the new destination path must not already exist.",
    inputSchema: { topic: topicId, sourceFiles: publicationSourceFiles, destinationAlias, destinationPath, content: publicationContent, label: z.string().max(160).optional(), description }
  }, tool((input) => publications.publishDocument(input)));

  server.registerTool("list_publications", {
    title: "List publications",
    description: "Read-only list of publication checkpoints, divergence states, and advisory guidance. It never republishes or changes files.",
    inputSchema: { topic: optionalTopicId, includeArchived: z.boolean().optional() },
    annotations: { readOnlyHint: true }
  }, tool((input) => publications.listPublications(input)));

  server.registerTool("get_publication_status", {
    title: "Get publication status",
    description: "Read-only comparison of a checkpoint, selected topic sources, and destination document. Its guidance is advisory and never writes.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true }
  }, tool((input) => publications.getPublicationStatus(input)));

  server.registerTool("read_publication", {
    title: "Read publication",
    description: "Read a publication record, immutable checkpoint snapshot, and current destination document for explicit review or three-way reconciliation.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true }
  }, tool((input) => publications.readPublication(input)));

  server.registerTool("update_publication", {
    title: "Update publication",
    description: "Explicitly write a complete new publication checkpoint after review. Requires the current destination hash and never performs automatic synchronization.",
    inputSchema: { id: z.string().uuid(), content: publicationContent, expectedTargetHash: destinationHash, sourceFiles: publicationSourceFiles, description }
  }, tool((input) => publications.updatePublication(input)));

  server.registerTool("forget_publication", {
    title: "Forget publication",
    description: "Archive a publication relationship only. It does not delete or modify the independent destination document.",
    inputSchema: { id: z.string().uuid(), confirm: z.literal(true), description }
  }, tool((input) => publications.forgetPublication(input)));

  server.registerTool("reindex_topical", {
    title: "Reindex Topical",
    description: "Rebuild derived indexes after direct Markdown edits. This does not create topics, transfer notes, or publish documents.",
    inputSchema: {}
  }, tool(() => store.reindex()));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`Topical MCP failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
