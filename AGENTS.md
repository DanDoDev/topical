# Working on Topical

Read `ROADMAP.md` before making changes. It is the durable project plan and handoff record.

- Keep `context.md` as the human-facing source of truth; JSON indexes are rebuildable derived metadata.
- Update `ROADMAP.md` whenever a milestone or a locked design decision changes.
- Run `npm test` after changes to the store. Run the MCP smoke test when dependencies are available.
- Do not weaken safe path checks, audit descriptions, soft deletion, or `expectedHash` conflict protection without an explicit documented decision.
