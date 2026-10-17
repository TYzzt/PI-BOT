# Pi Hermes Memory — managed-storage fork

Upstream: https://github.com/chandra447/pi-hermes-memory, npm **0.9.10**, MIT.

This focused fork retains the upstream content scanner and lookup normalization
verbatim, and adapts the upstream write policy in `policy.ts`. The memory tools and policy-only lifecycle integration are adapted in
`extension.ts`; persistence/mutations, searchable history and background review
are ported to the bot-scoped PostgreSQL service (`server/src/memory.ts`).
The upstream file-backed MemoryStore and SQLite index are replaced, rather than
running a second local memory authority. Snapshot injection, explicit/inferred
entries, correction/removal, bounded recall and review-before-compaction remain.
Global session scanning, filesystem exports, skill registration and subprocess
fallbacks are intentionally absent. All stores are bound to authenticated runs.

Upstream updates must be reviewed against 0.9.10, preserving LICENSE and this
change notice. No upstream package installer or lifecycle scripts run in clients.
