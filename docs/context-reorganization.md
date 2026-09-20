# Reviewed context reorganization

Use **Organize context** on a saved Markdown file to move substantial sections into focused supporting files. The analysis is advisory: it never applies changes on its own. Choose sections and destination paths, select **Preview changes**, review the source before/after and all supporting content, then give a change description and select **Apply reviewed changes**.

Keep purpose, current status, immediate decisions, next actions, and a concise file map in context. Evidence, historical observations, detailed plans and handoffs can live in `research/`, `history/`, or their owning issue/plan folder. These are conventions, not mandatory folders. A nested work-area context can be organized independently.

## Contract

| MCP tool | Inputs and result |
| --- | --- |
| `analyze_topic_context` | `topic`, optional `filePath` (default `context.md`). Returns advisory findings, current source hash, and up to 100 extractable level 2–6 sections with exact `start` offsets. |
| `preview_topic_reorganization` | `topic`, optional `filePath`, `expectedHash`, `extractions: [{start, destination}]`. Returns exact source before/after, supporting-file contents, size comparison, and `previewHash`. Read-only. |
| `apply_topic_reorganization` | The same inputs, plus reviewed `previewHash` and a change `description`. Preserves supporting files, then replaces the source, updating history, catalogues, search, and tasks. |

HTTP provides `POST /api/v1/reorganization/preview` and `/apply`, with the same inputs and existing origin/CSRF requirements. `GET /api/v1/topics/:topic/context-analysis` accepts optional `filePath`.

Destinations are relative to the topic root, including for nested source files. Choose 1–20 non-overlapping sections, each with a distinct visible `.md` destination. Selecting a parent includes its subsections. The preview supports source files up to 250,000 characters and up to 1,000,000 characters of supporting output. For larger sources, split material through reviewed ordinary edits first.

## Preservation and review

- Original prose, code, and Markdown formatting are retained. Relative Markdown link/image destinations are rebased for their new folder; required reference definitions are copied. Source definitions are retained for other references.
- Extracted headings remain in the source as links, including child headings, keeping existing source heading anchors stable. This intentionally leaves more headings than a hand-written topic map. You can simplify the map later after reviewing inbound links.
- TODOs move with their section and retain completion state. File-wide task exclusions are preserved in both source and extracted material. The completed operation has one task owner; an interrupted operation can temporarily have duplicates.
- No semantic summarization, automatic stale-status resolution, whole-file rename, cross-topic move, deletion, or publication update occurs. HTML elements, nested reference definitions, and footnote definitions require manual review instead of automatic extraction. Existing publications remain independent checkpoints and may become stale.
- The source replacement exactly matches the preview, including frontmatter. Its filesystem timestamp, catalogue and history record the edit; frontmatter is not rewritten as an unreviewed side effect.

A preview is bound to its source hash and exact extraction inputs. Changed sources, altered inputs, or destinations containing different content fail. An identical destination can be reused after an interrupted operation. There is no stored plan cache, semantic index, background optimizer, or new authoritative task store.

## Interrupted operations

Writes are serialized within one store process. Supporting files are installed atomically without replacing existing destinations, checked again, and only then is the source atomically replaced. This is a recoverable multi-file sequence, not a cross-process filesystem transaction. Concurrent external editors should finish before applying.

On `PARTIAL_REORGANIZATION`, inspect the returned source path, `preserved` file paths, and `sourceWritten` flag. Read all affected files. If the source was not shortened, its original content remains available; keep the preserved files, refresh analysis, and preview again. Identical files are reusable. If a preserved file has evolved, choose a new destination or reconcile it manually—do not overwrite it to retry.

If the source was written but indexing or audit work failed, reindex and inspect history before further changes. Reindex rebuilds derived search/task state but does not invent missing audit events. A successful extraction is not a revision snapshot/undo system; restoration is a separate reviewed edit using the preserved material.
