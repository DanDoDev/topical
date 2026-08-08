# Contributing to Topical

Thanks for helping improve Topical. Small, focused pull requests are easiest to review.

## Development setup

```bash
nvm use
npm ci
npm test
```

Node.js 24 LTS is required. Copy `.env.example` to `.env` only for local manual testing; never commit real topic paths, credentials, or private notes.

## Pull requests

1. Search existing issues and pull requests before starting overlapping work.
2. Explain the user-facing behavior and tradeoffs in the pull request description.
3. Add or update tests for every behavior change.
4. Run `npm test` and `npm audit` before submitting.
5. Update `README.md` when a public contract changes.

Preserve these safety guarantees unless a change is explicitly designed, documented, and tested:

- All paths remain inside their configured roots.
- Symlinks cannot bypass root boundaries.
- Markdown writes remain size-limited and atomic.
- Destructive operations remain soft deletes with explicit confirmation.
- Stale writes remain protected by expected hashes.
- Publication guidance remains read-only; publishing remains explicit.

Report security issues privately according to [SECURITY.md](SECURITY.md), not in a public issue.
