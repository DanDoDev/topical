# Workflows and tasks

Topical supports on-call, project, documentation, and planning starters. Nested work areas remain ordinary folders within a topic.

## Create and resume

Choose a starting structure in **New topic**. Within a topic, use **New issue, plan, or draft**, choose the parent context, and review it before creating linked work. The MCP equivalents are `create_topic` with optional `template` (`oncall`, `project`, `documentation`, `planning`) and `create_work_area`.

Issues create `issues/<slug>/context.md`; plans create `plans/<slug>/context.md`; drafts create `drafts/<slug>.md`, relative to the parent's directory. The parent receives an Active work link. A retry can finish a partial operation or reuse an unchanged starter, but cannot overwrite evolved work. On `PARTIAL_WORKFLOW`, inspect the returned target and parent, read current hashes, then retry. Multi-file creation is a recoverable sequence, not a filesystem-wide transaction.

Root context is the active-work map. Issue and plan contexts own status, decisions, and actions. Supporting files hold evidence/research. Dated handoffs link to those records. Suggested states are working, blocked, ready for review, and complete; paths remain stable. Publication is a separate checkpoint.

## Actionable checkboxes

```markdown
## Next actions
- [ ] Confirm affected regions.
- [x] Capture a failing trace.
```

Nested and ordered task lists are supported. Quotes, code examples, raw HTML, and frontmatter are excluded. A standalone `<!-- topical:tasks off -->` comment followed by a blank line excludes the entire file. Draft starters include it so reusable procedures do not become personal follow-ups. Keep drafting/review actions in parent context. Each task has one owning file; handoffs and root maps link to it instead of copying checkboxes.

## Query and complete

**Tasks** shows global actions. **Tasks in this area** starts with the topic and current folder scope. Select a topic by title (load more choices as needed), and filter by path and completion status. Open a task's source to read its context; completion/reopening edits its original checkbox.

| MCP tool | Contract |
| --- | --- |
| `list_tasks` | Optional `topic`, `pathPrefix`, `status` (`open`, `completed`, `all`), `cursor`, `limit` (1–100). Returns bounded tasks, scoped counts, pagination, and index freshness. |
| `set_task_completed` | `topic`, `filePath`, `offset`, `completed`, `expectedHash`, `description`. Pass indexed `sourceHash` as the expected hash. |
| `create_work_area` | `topic`, `kind`, `slug`, `title`, optional `brief` and `parentFile`, required `expectedHash` and `description`. Read the parent first. |

HTTP exposes `GET /api/v1/tasks`, `PATCH /api/v1/task`, and `POST /api/v1/work-areas` with the same contracts and existing origin/CSRF protections. Topic creation accepts `template` as an alternative to nonempty initial Markdown.

Path filtering matches an exact file or folder boundary: `issues/a` excludes `issues/ab`. Results sort by topic ID, path, and checkbox position. Counts cover the topic/path scope before completion filtering. Previews are bounded to 2,000 characters and headings to 300; full content stays in Markdown. Offsets are opaque UTF-16 source positions tied to a file hash, not permanent task IDs. Refresh and review after conflicts.

Pagination is offset-based within a stable sort, not a snapshot. Restart paging if tasks change; the UI does this after its own task edits.

## Indexing

Task rows live in the existing disposable `.topical-cache/search.sqlite`. Normal writes replace only the changed file's tasks in the same transaction as its search records. Deletion removes them, restoration recreates them, and cache rebuild reconstructs them from Markdown. Queries do not reopen source files or rewrite the cache.

Direct external edits require **System → Reindex** or `reindex_topical`. Refresh reloads the current index, without scanning files. Index freshness is not an individual task's modification time. Priority, due dates, owners, recurrence, dependencies, and permanent task IDs are not interpreted in this version.
