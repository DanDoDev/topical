# Review and organize existing context

Use this workflow when the user requests cleanup, restructuring, or a thinner topic context. Routine capture and task completion do not trigger cleanup. Follow the user's existing authorization; do not repeatedly request permission already granted for the reviewed scope.

Discover the topic and read its overview, then analyze the specific source with `analyze_topic_context` (`filePath` defaults to `context.md`). Findings are advisory. Read the source and relevant linked files to distinguish current decisions, dated evidence, historical plans, and remaining actions. Do not infer completion or obsolete decisions from age alone.

Keep purpose, concise current state, immediate decisions/questions, next actions, and links in the routing context. Select substantial sections to preserve in focused files under the owning issue/plan, `research/`, `history/`, or other existing conventions. Prefer meaningful names and avoid creating empty structure. A historical destination name does not automatically exclude its TODOs: resolve task status explicitly, never hide open work merely to shorten a list.

Call `preview_topic_reorganization` with the analyzed source hash as `expectedHash`, the same `filePath`, and `extractions: [{start, destination}]`. Offsets come from analysis; destination paths are relative to the topic root. Select a parent section or its children, not both. Review exact source before/after, each preserved file, link rebasing, task ownership, and any size increase. Preview performs no writes and returns a `previewHash`.

Apply only within the user's authorized cleanup scope, using the unchanged inputs plus the reviewed `previewHash` and a concrete description. If approval of a proposal is still needed, present the concrete preview before asking; do not apply dependent changes until approval arrives. On conflict, refresh and review rather than silently retrying.

Extraction preserves Markdown material, retains original headings as forwarding links, and moves TODOs instead of copying them. Source frontmatter remains unchanged. File-level task exclusions are preserved. HTML elements, nested reference definitions, and footnote definitions require manual handling. Existing publications are not rewritten.

After extraction, read the resulting context and owning files, check task counts/status and relevant links, and reconcile the current status only from evidence already reviewed. Concise rewritten summaries or a smaller link map are separate hash-guarded edits: preserve historical detail first and review inbound anchors before removing retained headings. No generated summary should replace the only copy of evidence.

On `PARTIAL_REORGANIZATION`, inspect the source and every returned preserved path before retrying. If the source remains intact, identical preserved files can be reused with a freshly reviewed preview. If destinations changed, reconcile or choose a new path. If `sourceWritten` is true, reindex to repair derived state and review history; reindex does not reconstruct missing audit events. Do not blindly repeat apply or delete preserved copies.
