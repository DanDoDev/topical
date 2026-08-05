# Topical roadmap

## Purpose

Topical is a local-first system for keeping human-readable context and notes in Markdown. A Node.js MCP server is the data plane: it reads, searches, creates, and updates topic files while maintaining lightweight JSON indexes and audit history.

This document is the project handoff point. Update the checklist and the **Current status** section whenever a milestone changes. A new agent should start here, then read `README.md` and inspect the current working tree.

## Locked v1 decisions

- Build a standalone JavaScript/Node.js stdio MCP server first. An optional Codex plugin/skill may be added later to guide when agents use the tools; it is not the enforcement layer.
- The topic Markdown files are the human-facing source of truth. JSON indexes are derived metadata/audit logs and must be rebuildable with `reindex_topical`.
- The configured `TOPICAL_ROOT` directory contains every topic. MCP configuration supplies this value in production; a local `.env` is supported for development.
- Every topic has `context.md` and `index.json`. `context.md` carries title, summary, tags, and timestamps in frontmatter; its body is normal Markdown.
- Supporting context lives in additional `.md` files, including nested paths when useful (for example `prs/123.md`).
- Every mutation requires a concise, one-sentence `description`, recorded in history.
- File paths are constrained to safe relative Markdown paths. Topic IDs are lower-case slugs.
- Deletes are soft deletes: data is moved to `$TOPICAL_ROOT/.trash/`; `context.md` cannot be removed by itself.
- Changes use atomic temp-file + rename writes. `expectedHash` enables conflict detection for edits based on stale reads.
- Publications are explicit one-way Markdown checkpoints to configured destination aliases. They are not sync relationships, and neither side automatically becomes authoritative.

## Target layout

```text
$TOPICAL_ROOT/
  index.json
  hue-lighting-effects/
    context.md
    index.json
    implementation-plan.md
    prs/123.md
  .trash/
```

## Required v1 MCP tools

- [x] `search_topics` — search topic metadata and Markdown content, returning paths and snippets.
- [x] `list_topics` — filter by tags and sort by recent activity, title, or creation time.
- [x] `create_topic` — initialize a topic folder, context frontmatter, and history.
- [x] `read_topic_file` — read a file and return a content hash.
- [x] `get_topic_overview` — return bounded current context, related files, and recent history for model-efficient retrieval.
- [x] `update_topic_file` — append, replace, or replace a named Markdown section; optionally require `expectedHash`.
- [x] `create_topic_file` — create a supporting Markdown file.
- [x] `delete_topic_file` — soft-delete a supporting Markdown file with explicit confirmation.
- [x] `update_topic_metadata` — safely update context frontmatter.
- [x] `delete_topic` — soft-delete a topic with explicit confirmation.
- [x] `reindex_topical` — rebuild index data after direct human filesystem edits.

## Publication checkpoints

- [x] Configure named destination roots; reject arbitrary destination paths, traversal, and symlink escapes.
- [x] Store central publication records, immutable snapshots, and source fingerprints outside normal topic search.
- [x] Add create-only publication, status, read, guarded update, and archive-relationship MCP tools.
- [x] Return read-only, explicit-action guidance with every publication status result.
- [x] Validate the complete publish → status → read → guarded update → forget flow through a live MCP client.
- [x] Publish the project documentation as independent repository Markdown documents.

## Milestones

### 1. Core topic store

- [x] Define the Markdown/frontmatter and JSON schemas.
- [x] Implement path validation, atomic writes, audit history, search, indexes, conflict hashes, and soft deletion.
- [x] Add automated tests for every operation and error boundary.
- [ ] Review the index schema against representative real-world topics.

### 2. MCP surface

- [x] Add the stdio MCP server and Zod input schemas.
- [x] Install dependencies and verify MCP SDK compatibility.
- [x] Smoke-test every tool through an MCP client or protocol-level test.
- [x] Provide an example MCP configuration and startup validation.

### 3. Documentation and workflow

- [x] Document the basic local setup and safety model in `README.md`.
- [x] Document exact tool arguments, responses, errors, and topic-file examples.
- [x] Add the versioned `topical-workflow` skill for MCP discovery, search-before-create, and read-before-update behavior.
- [ ] Decide whether to package that skill and server as a distributable Codex plugin.

### 3.1 Search and context optimization

- [x] Make indexes incremental: mutations refresh only their topic; reads do not reindex.
- [x] Build derived lexical document metadata with title/tag/heading/body terms for ranked retrieval.
- [x] Add bounded topic overviews to keep model context focused.
- [x] Add regression coverage proving list/search do not rewrite the root index.

### 4. Release readiness

- [x] Test manual Markdown edits followed by reindexing.
- [x] Test concurrent/stale writes via `expectedHash`.
- [x] Test paths that attempt traversal, unsupported extensions, protected-file deletion, and symlink escapes.
- [x] Run the complete test suite and document the verification result.
- [x] Adopt the MIT License and add continuous integration, dependency updates, and security reporting guidance.
- [ ] Choose the release versioning and distribution approach.

## Current status

Version 0.3 adds explicit standalone publication checkpoints and clear topic-routing guidance. Central topics retain working context, while project Markdown documents remain independent artifacts with no automatic source of truth or synchronization. The MCP initialization instructions, tool descriptions, and optional `topical-workflow` skill distinguish Topical topics from Codex tasks, chats, workspaces, and projects. Destination aliases, path and symlink protections, immutable snapshots, divergence states, and expected-hash republishing are covered by live MCP tests. Packaging the optional skill and choosing a release distribution approach remain.

## Continuation protocol

1. Read this file and `README.md`.
2. Run `git status --short` before editing; preserve unrelated user changes.
3. Work one milestone at a time and update the relevant checkbox plus **Current status** after completing it.
4. Run the narrowest relevant test after every meaningful change, then run the full suite before handoff.
5. Keep implementation decisions aligned with **Locked v1 decisions**. Record any approved change to those decisions here before implementing it.
