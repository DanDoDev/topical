# Topical roadmap

## Current release: v0.3

Topical is a local-first Node.js MCP for human-readable Markdown context. It provides safe topic CRUD, incremental lexical search, bounded overviews, conflict-safe file updates, and soft deletion.

Version 0.3 adds explicit publication checkpoints: a central topic can produce independent Markdown documentation in an authorized project folder without creating a repository-local Topical store or a synchronization relationship.

## Completed

- Central topic folders with context.md, audit indexes, and supporting Markdown files.
- Atomic writes, safe relative paths, symlink rejection, size limits, soft deletion, and expected-hash conflict protection.
- Incremental lexical indexing and bounded topic overviews for efficient agent context use.
- Stdio MCP tools with Zod schemas and protocol-level tests.
- Publication roots configured by alias, immutable central snapshots, divergence detection, and guarded republishing.

## Next decisions

- Review index behavior against representative large topic sets and measure search performance.
- Consider an optional agent skill that teaches search, overview, focused read, and explicit publication review.
- Decide backup and retention policy for trash and publication snapshots.
- Choose release versioning and distribution approach.

## Publication workflow

Use Topical as working context, publish complete polished Markdown intentionally, and treat later divergence as a review task. No side is automatically authoritative.
