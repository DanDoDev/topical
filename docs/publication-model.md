# Topical publication model

## Purpose

Topical keeps evolving working context in a central Markdown topic store. A publication turns selected topic context into a polished, standalone Markdown document in a project folder.

A publication is a checkpoint, not synchronization. The central topic and the destination document may both evolve after publication, and Topical does not automatically choose a source of truth or overwrite either side.

## What lives where

- Central Topical: working notes, topic audit history, publication records, and immutable publication snapshots.
- Project repository: ordinary Markdown documents that people and any agent can edit without Topical installed.
- No repository-local Topical store, manifest, index, or Git workflow is required.

## Safe publication workflow

1. Search the topic and read only the relevant files.
2. Produce a compact, complete Markdown document.
3. Publish to a named destination root and safe relative .md path.
4. Topical records source-file hashes, destination hash, timestamp, history, and a central immutable snapshot.
5. Later, inspect the checkpoint before making any further change.

A new publication refuses an existing file. Updating a known publication requires the current destination SHA-256 hash, so an external edit cannot be silently overwritten. Forgetting a publication archives only the central relationship; the document remains untouched.

## Divergence states

| State | Meaning |
| --- | --- |
| unchanged | Topic sources and document both still match the checkpoint. |
| topic_evolved | Selected topic sources changed; the document has not. |
| document_evolved | The document changed outside the checkpoint; sources have not. |
| both_evolved | Both sides changed and require an explicit three-way review. |
| document_missing | The destination file was removed. |
| source_incomplete | A selected topic source is unavailable. |
| destination_unavailable | The configured destination root cannot be accessed. |

These states describe divergence only. They never trigger automatic sync, merge, import, or delete operations.

## Configuration

Publication destinations are configured as aliases, not passed as arbitrary absolute paths:

```bash
TOPICAL_PUBLISH_ROOTS=docs=/absolute/path/to/project/docs;notes=/absolute/path/to/notes
```

The MCP receives an alias plus a relative Markdown path. It rejects traversal, non-Markdown destinations, symlinks in protected paths, and writes outside the configured root.

## Scope of v1

V1 supports complete standalone Markdown files. Managed sections, automatic adoption of existing documents, background sync, auto-merge, Git automation, and semantic import are intentionally out of scope.
