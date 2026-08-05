# Topical MCP

[![CI](https://github.com/DanDoDev/topical/actions/workflows/ci.yml/badge.svg)](https://github.com/DanDoDev/topical/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Topical is a local-first, Markdown-based context store for agents and people. Every topic is a folder whose `context.md` is the source of truth. `index.json` files are maintained metadata and audit logs that can be rebuilt after manual edits.

Search indexes are derived data. The server builds them once at startup (or when `reindex_topical` is called), then updates only the affected topic after each mutation. Normal list and search calls do not rebuild or rewrite indexes.

Topical is currently pre-1.0. Back up important topic folders before upgrading across versions while the storage and tool contracts are still evolving.

## Install and configure

```bash
git clone https://github.com/DanDoDev/topical.git
cd topical
nvm use
npm ci
cp .env.example .env
# Edit TOPICAL_ROOT in .env
# Optionally configure named publication roots
```

The included `.nvmrc` pins development to Node.js 20.19.0.

Add this server to your MCP configuration:

```json
{
  "mcpServers": {
    "topical": {
      "command": "node",
      "args": ["/absolute/path/to/topical/src/server.js"],
      "env": {
        "TOPICAL_ROOT": "/absolute/path/to/topical-files"
      }
    }
  }
}
```

`TOPICAL_ROOT` supplied by MCP configuration takes precedence over `.env`. The server creates the root directory and its `index.json` on first use.

## Choosing a topic

`TOPICAL_ROOT` is the shared parent directory for every Topical note folder. It is not a project-specific note file, and a Topical topic is not a Codex task, chat, workspace, or repository. When the user refers to existing topical notes or shared context, call `search_topics` or `list_topics` first, then pass the selected topic ID explicitly to read or write tools. Do not infer a topic from the current Codex project name.

If no matching topic exists, use `create_topic`; if several topics match, ask the user which one to use.

## Optional Codex workflow skill

This repository includes [`skills/topical-workflow`](skills/topical-workflow/SKILL.md), a concise Codex skill that triggers Topical discovery when users mention topical notes or prior working context. Install or link that folder into your Codex skills directory, then restart Codex so other agents use the workflow automatically.

## Publications

A publication is an explicit one-way Markdown checkpoint from a central topic to a configured project directory. It is not a sync relationship and neither the topic nor the destination document automatically wins when both change. The destination stays a normal standalone Markdown file for people and other agents to edit freely.

Configure named destinations instead of sending arbitrary absolute paths to MCP tools:

```bash
TOPICAL_PUBLISH_ROOTS=docs=/absolute/path/to/project/docs;notes=/absolute/path/to/notes
```

`publish_document` creates the destination file plus a central checkpoint record and immutable snapshot. The calling agent supplies the polished Markdown; Topical does not summarize or generate it. `get_publication_status` reports `unchanged`, `topic_evolved`, `document_evolved`, `both_evolved`, `document_missing`, `source_incomplete`, or `destination_unavailable`, with read-only guidance for the next explicit human or agent decision. `update_publication` requires the current destination SHA-256 hash, and `forget_publication` archives only the relationship—it never deletes the destination file.

## Topic layout

```text
topical-files/
  index.json
  hue-lighting-effects/
    context.md
    index.json
    implementation-plan.md
    tickets/effects-api.md
```

`context.md` includes YAML-style frontmatter for the topic title, summary, tags, and timestamps. Its body remains ordinary Markdown. Extra Markdown files are for focused context such as a sub-feature, ticket, PR, or research thread.

## Tools

- `search_topics` searches titles, tags, and all Markdown content.
- `list_topics` lists topics by recent activity, title, or creation time.
- `create_topic`, `read_topic_file`, and `update_topic_file` manage core context.
- `get_topic_overview` returns a bounded briefing, file inventory, and recent history before an agent reads detailed notes.
- `create_topic_file` and `delete_topic_file` manage supporting Markdown files.
- `update_topic_metadata` edits frontmatter safely.
- `delete_topic` moves a topic to `.trash` instead of permanently deleting it.
- `reindex_topical` rebuilds derived indexes after manual filesystem edits.
- Publication tools create and review explicit independent Markdown checkpoints; they never synchronize files automatically.

All mutation tools require a one-sentence `description`. It is recorded in the relevant topic history and surfaced in the root index's recent activity.

## MCP contract

| Tool | Important inputs | Result |
| --- | --- | --- |
| `search_topics` | `query`, optional `tags`, `limit` | Matching topic files with snippets and relevance scores. |
| `list_topics` | optional `sort`, `tags` | Topic summaries, metadata, file count, and latest action. |
| `create_topic` | `title`, `summary`, `tags`, `initialContent`, `description` | Topic ID and `context.md` path. |
| `read_topic_file` | `topic`, optional `filePath` | Markdown content and a SHA-256 `hash`. |
| `get_topic_overview` | `topic`, optional `maxChars` | Bounded `context.md` briefing, file inventory, and recent history. |
| `update_topic_file` | `topic`, `filePath`, `mode`, `content`, optional `section`, `expectedHash`, `description` | Updated file path and hash. |
| `create_topic_file` | `topic`, `filePath`, `content`, `description` | New supporting Markdown file and hash. |
| `delete_topic_file` | `topic`, `filePath`, `confirm: true`, `description` | Soft-delete destination. |
| `update_topic_metadata` | `topic`, optional `title`, `summary`, `tags`, `description` | Updated frontmatter metadata. |
| `delete_topic` | `topic`, `confirm: true`, `description` | Soft-delete destination. |
| `reindex_topical` | none | Rebuilt root index. |
| `publish_document` | `topic`, sources, destination alias/path, `content`, `description` | Creates an explicit standalone Markdown checkpoint. |
| `list_publications` | optional `topic`, `includeArchived` | Publication records with divergence states. |
| `get_publication_status` / `read_publication` | publication `id` | Checkpoint state, snapshot, and current document. |
| `update_publication` | `id`, `content`, current `expectedTargetHash`, `description` | Conflict-safe new checkpoint. |
| `forget_publication` | `id`, `confirm: true`, `description` | Archives the relationship; leaves the document untouched. |

Agents should normally search before creating, then read before updating. For updates made from a prior read, pass that read's `hash` as `expectedHash` to prevent an accidental stale overwrite.

For publications, use the same focused retrieval: get an overview, read only the selected topic files, inspect any existing publication status, then draft the complete Markdown outside the MCP call. A `guidance` result may recommend review or reconciliation, but it never publishes or changes a file; publication remains an explicit `publish_document` or `update_publication` call.

For efficient model context, use this sequence:

1. `search_topics` to find likely topic files from the lexical index.
2. `get_topic_overview` to understand the topic and select the small number of relevant files.
3. `read_topic_file` only for those files, then make a focused update.

`search_topics` ranks exact title, tag, heading, path, and body-term matches. It reads only a bounded set of candidate Markdown files to produce final snippets; it does not scan every file on every query.

### Example topic

```md
---
title: "Hue lighting effects"
summary: "Implementation context for adding reusable effects to the Hue lights integration."
tags: ["hue", "lighting", "feature"]
created_at: 2026-07-18T14:00:00.000Z
updated_at: 2026-07-18T14:00:00.000Z
---

# Hue lighting effects

## Decisions

- Add reusable effect presets behind a device capability check.
- Preserve existing on/off, brightness, and color behavior for unsupported lights.
```

## Safety model

- Topic identifiers are slugified and paths must stay inside the configured root.
- `TOPICAL_ROOT` must be an absolute, dedicated real directory (not `/`, your home directory, or a symbolic link).
- Symlinks anywhere inside the topic root are rejected, so a malicious or accidental link cannot make a read or write escape the configured folder.
- Supporting files must be `.md`; `context.md` cannot be deleted.
- Markdown writes are capped at 5 MiB per file.
- Writes use temporary files followed by rename; index data is rebuildable.
- Updates can include `expectedHash`, preventing an agent from overwriting content it read before somebody else changed it.

## Contributing and security

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and safety invariants. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## License

Topical is available under the [MIT License](LICENSE).
