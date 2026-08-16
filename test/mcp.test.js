import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server registers and calls Topical tools over stdio", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topical-mcp-test-"));
  const publicationRoot = await mkdtemp(path.join(os.tmpdir(), "topical-publication-test-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("src/server.js")],
    env: { ...process.env, TOPICAL_ROOT: root, TOPICAL_PUBLISH_ROOTS: "docs=" + publicationRoot },
    stderr: "pipe"
  });
  const client = new Client({ name: "topical-test-client", version: "0.1.0" });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  await client.connect(transport);
  t.after(async () => { await transport.close(); });

  assert.match(client.getInstructions() || "", /TOPICAL_ROOT is the shared parent directory/);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["create_topic", "create_topic_file", "delete_topic", "delete_topic_file", "forget_publication", "get_publication_status", "get_system_health", "get_topic_overview", "list_history", "list_publications", "list_tags", "list_topics", "list_trash", "publish_document", "read_publication", "read_topic_file", "reindex_topical", "restore_trash", "search_topics", "update_publication", "update_topic_file", "update_topic_metadata"].sort(),
    stderr.join("")
  );
  const createTopicTool = tools.tools.find((tool) => tool.name === "create_topic");
  const searchTopicsTool = tools.tools.find((tool) => tool.name === "search_topics");
  assert.match(createTopicTool.description, /does not create a Codex task/);
  assert.match(searchTopicsTool.description, /explicit topic/);
  assert.equal(searchTopicsTool.annotations?.readOnlyHint, true);
  assert.match(createTopicTool.inputSchema.properties.title.description, /Human title for a new Topical note folder/);

  const created = await client.callTool({
    name: "create_topic",
    arguments: { title: "MCP verification", summary: "Live protocol test.", tags: ["test"], description: "Created a topic through the live MCP protocol." }
  });
  assert.equal(created.isError, false, JSON.stringify(created));
  const body = JSON.parse(created.content[0].text);
  assert.equal(body.topic, "mcp-verification");

  const listed = await client.callTool({ name: "list_topics", arguments: { tags: ["test"] } });
  const listedBody = JSON.parse(listed.content[0].text);
  assert.equal(listedBody.topics[0].id, "mcp-verification");
  assert.equal(listedBody.page.nextCursor, null);

  const read = await client.callTool({ name: "read_topic_file", arguments: { topic: "mcp-verification" } });
  const readBody = JSON.parse(read.content[0].text);
  assert.match(readBody.content, /MCP verification/);

  const appended = await client.callTool({
    name: "update_topic_file",
    arguments: {
      topic: "mcp-verification",
      content: "# Notes\n\nThe MCP round trip works.",
      expectedHash: readBody.hash,
      description: "Recorded the successful MCP round trip."
    }
  });
  assert.equal(appended.isError, false, JSON.stringify(appended));
  const appendedBody = JSON.parse(appended.content[0].text);

  const stale = await client.callTool({
    name: "update_topic_file",
    arguments: {
      topic: "mcp-verification",
      content: "stale",
      expectedHash: readBody.hash,
      description: "Exercised the structured conflict response."
    }
  });
  const staleBody = JSON.parse(stale.content[0].text);
  assert.equal(stale.isError, true);
  assert.equal(staleBody.error.code, "CONFLICT");
  assert.equal(staleBody.error.details.currentHash, appendedBody.hash);

  const extraFile = await client.callTool({
    name: "create_topic_file",
    arguments: { topic: "mcp-verification", filePath: "checks/live.md", content: "Protocol test evidence.", description: "Added live protocol test evidence." }
  });
  assert.equal(extraFile.isError, false, JSON.stringify(extraFile));
  const extraFileBody = JSON.parse(extraFile.content[0].text);

  const metadata = await client.callTool({
    name: "update_topic_metadata",
    arguments: { topic: "mcp-verification", tags: ["test", "verified"], expectedHash: appendedBody.hash, description: "Marked the topic as protocol verified." }
  });
  assert.equal(metadata.isError, false, JSON.stringify(metadata));
  const metadataBody = JSON.parse(metadata.content[0].text);

  const taxonomy = await client.callTool({ name: "list_tags", arguments: { query: "verified", limit: 10 } });
  const taxonomyBody = JSON.parse(taxonomy.content[0].text);
  assert.equal(taxonomyBody.tags[0].key, "verified");

  const history = await client.callTool({ name: "list_history", arguments: { topic: "mcp-verification", limit: 2 } });
  const historyBody = JSON.parse(history.content[0].text);
  assert.equal(historyBody.events.length, 2);
  assert.ok(historyBody.page.total >= 3);

  const health = await client.callTool({ name: "get_system_health", arguments: {} });
  const healthBody = JSON.parse(health.content[0].text);
  assert.equal(healthBody.status, "ready");
  assert.equal(healthBody.markdownAuthority, true);

  const overview = await client.callTool({ name: "get_topic_overview", arguments: { topic: "mcp-verification", maxChars: 500 } });
  const overviewBody = JSON.parse(overview.content[0].text);
  assert.equal(overviewBody.metadata.id, "mcp-verification");
  assert.equal(overviewBody.files.length, 2);

  const searched = await client.callTool({ name: "search_topics", arguments: { query: "protocol test evidence" } });
  const searchedBody = JSON.parse(searched.content[0].text);
  assert.equal(searchedBody.matchMode, "strict");
  assert.equal(searchedBody.topics[0].files[0].path, "checks/live.md");

  const published = await client.callTool({
    name: "publish_document",
    arguments: { topic: "mcp-verification", sourceFiles: ["context.md", "checks/live.md"], destinationAlias: "docs", destinationPath: "guides/verification.md", content: "# Published verification\n", description: "Published a standalone verification guide." }
  });
  assert.equal(published.isError, false, JSON.stringify(published));
  const publication = JSON.parse(published.content[0].text);
  const publicationStatus = await client.callTool({ name: "get_publication_status", arguments: { id: publication.id } });
  const publicationStatusBody = JSON.parse(publicationStatus.content[0].text);
  assert.equal(publicationStatusBody.state, "unchanged");
  assert.deepEqual(publicationStatusBody.guidance, { action: "none", message: "The topic sources and document still match this checkpoint.", requiresExplicitAction: true });
  const publicationList = await client.callTool({ name: "list_publications", arguments: { topic: "mcp-verification" } });
  assert.equal(JSON.parse(publicationList.content[0].text).publications[0].guidance.action, "none");
  const readPublication = await client.callTool({ name: "read_publication", arguments: { id: publication.id } });
  const readPublicationBody = JSON.parse(readPublication.content[0].text);
  const revised = await client.callTool({ name: "update_publication", arguments: { id: publication.id, content: "# Revised verification\n", expectedTargetHash: readPublicationBody.record.targetHash, description: "Published a revised verification guide." } });
  assert.equal(revised.isError, false, JSON.stringify(revised));
  const forgotten = await client.callTool({ name: "forget_publication", arguments: { id: publication.id, confirm: true, description: "Archived the publication relationship." } });
  assert.equal(forgotten.isError, false, JSON.stringify(forgotten));

  const reindexed = await client.callTool({ name: "reindex_topical", arguments: {} });
  assert.equal(reindexed.isError, false, JSON.stringify(reindexed));

  const deletedFile = await client.callTool({
    name: "delete_topic_file",
    arguments: { topic: "mcp-verification", filePath: "checks/live.md", expectedHash: extraFileBody.hash, confirm: true, description: "Archived the live protocol evidence file." }
  });
  assert.equal(deletedFile.isError, false, JSON.stringify(deletedFile));
  const deletedFileBody = JSON.parse(deletedFile.content[0].text);
  const trash = await client.callTool({ name: "list_trash", arguments: { topic: "mcp-verification" } });
  assert.equal(JSON.parse(trash.content[0].text).entries[0].id, deletedFileBody.trash.id);
  const restoredFile = await client.callTool({
    name: "restore_trash",
    arguments: { id: deletedFileBody.trash.id, expectedHash: extraFileBody.hash, description: "Restored the live protocol evidence file." }
  });
  assert.equal(restoredFile.isError, false, JSON.stringify(restoredFile));

  const deletedTopic = await client.callTool({
    name: "delete_topic",
    arguments: { topic: "mcp-verification", expectedHash: metadataBody.hash, confirm: true, description: "Archived the protocol verification topic." }
  });
  assert.equal(deletedTopic.isError, false, JSON.stringify(deletedTopic));
  const deletedTopicBody = JSON.parse(deletedTopic.content[0].text);
  const restoredTopic = await client.callTool({
    name: "restore_trash",
    arguments: { id: deletedTopicBody.trash.id, expectedHash: metadataBody.hash, description: "Restored the protocol verification topic." }
  });
  assert.equal(restoredTopic.isError, false, JSON.stringify(restoredTopic));
});
