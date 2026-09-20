# Structured work in Topical

These conventions support user-requested work. They do not authorize unrelated creation, publication, or reorganization.

## Start and resume

Discover the existing topic first. New topics can use `create_topic` with `template: oncall`, `project`, `documentation`, or `planning`; omit initial content when using a template. Only root context is created, with no empty folder tree.

Read the overview and selected work-area context before following relevant links. Root context owns purpose, priorities, and active-work links. Work-area context owns detailed status, decisions, unknowns, and actions. Keep paths stable when status changes.

For distinct substantial work, read the parent context then call `create_work_area` with kind (`issue`, `plan`, `draft`), title, lowercase slug, optional factual brief, parent file, reviewed hash, and audit description. Paths are relative to the parent's directory: `issues/<slug>/context.md`, `plans/<slug>/context.md`, or `drafts/<slug>.md`. Small notes can use `create_topic_file` directly.

The tool creates the file and adds an Active work link. A partial failure returns target and parent paths: inspect both, then retry with current hashes. Never overwrite evolved work to retry scaffolding.

## On-call and investigation

For “track this incident,” first check for its identifier or existing issue. Record supplied facts and impact, distinguish hypotheses from observations, and capture unknowns, decisions, and actions in the issue context. Add evidence or timeline files when substantive material warrants them. Link evidence instead of copying it into root context.

For “prepare a handoff,” reconcile outcomes and actions, then create a dated `handoffs/YYYY-MM-DD.md` linking to owning issue records. Use ordinary bullet links instead of duplicating editable checkboxes. Do not invent owners, deadlines, severity, or resolutions.

## Planning

For “plan this change,” capture objectives, constraints, alternatives, decisions, delivery steps, and validation. Research can grow into a supporting file. Keep proposed decisions marked as proposed until accepted. Actions belong with the plan that owns them.

## Document writing

For “draft a runbook/proposal/review,” create a draft under the relevant work area. Establish audience and purpose, use verified sources, and make unresolved claims visible. Maintain one draft per deliverable unless alternatives serve a concrete comparison.

Draft starters exclude all checkboxes from Tasks. Keep authoring/review actions in parent context. Remove the exclusion marker deliberately if the document itself should own actionable tasks.

Suggested states are working, blocked, ready for review, and complete. Completing a draft does not publish it; publication remains explicit.

## Finish and organize

Update current status, decisions, and remaining actions in the owning work area. Root context needs only a concise summary or link change. Prefer current status over accumulating contradictory dated status paragraphs.

If existing context needs restructuring, propose concrete extractions and link changes. Preserve source material in supporting files before shortening the original, using reviewed hashes. Use the [reviewed reorganization workflow](reorganization.md) for requested cleanup. Creating work alone does not authorize reorganizing existing material.
