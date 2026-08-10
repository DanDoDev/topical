---
name: topical-workflow
description: Use when a user mentions Topical, existing topical notes, shared working context, prior notes, or asks to create, find, read, or update context through the Topical MCP. Resolve the explicit Topical topic with MCP discovery before using terminal paths or creating a Codex task.
---

# Topical Workflow

Treat Topical as a shared Markdown topic store. Do not confuse a Topical topic with a Codex task, chat, workspace, or repository.

## Discover the topic

1. Check whether `mcp__topical__*` tools are available before using the terminal or asking for a filename.
2. Call `search_topics` when the user gives a project, feature, or note term. Call `list_topics` when they refer only to existing notes or context.
3. Choose the explicit topic ID from the returned topics. Never infer it from the current Codex project or workspace name.
4. If no suitable topic exists, create one with `create_topic`. If several are plausible, ask the user which topic to use.

When the user says to start or create a topical, interpret that as a request to create or use a Topical MCP topic unless they explicitly ask for a Codex task or chat.

## Read and update safely

1. Call `get_topic_overview` after selecting a topic.
2. Read only the relevant Markdown files with `read_topic_file`.
3. For a modification based on a prior read, pass that file hash as `expectedHash` to `update_topic_file`.
4. Supply a concise description for every mutation.

Do not ask for a filesystem path merely to locate existing Topical notes. If Topical MCP tools are unavailable, say that clearly and then request an alternative.

## Recover an unavailable MCP

If Topical is enabled but its tools are missing or the connection closes during startup:

1. Inspect the MCP startup stderr. Adding the topic directory as a workspace root does not configure or change the MCP runtime.
2. Run the configured executable and server path with `--doctor --json`, forwarding the same `TOPICAL_ROOT` environment.
3. Topical v0.4 requires Node 24.x. Do not rely on a desktop or IDE host resolving `node` through an interactive NVM shell; configure the absolute executable returned by `nvm which 24`.
4. If dependencies or `better-sqlite3` fail to load, activate Node 24 and run `npm ci` in the Topical checkout.
5. Restart the MCP host after correcting its configuration, then retry `search_topics` or `list_topics`.

Read-only terminal diagnostics are allowed for recovery. Do not edit the Topical topic store directly to bypass an unavailable MCP.

## Publications

Treat publications as explicit independent Markdown checkpoints. Read the topic sources and publication status before drafting. `guidance` is advisory only; only `publish_document` or `update_publication` can change a destination document.
