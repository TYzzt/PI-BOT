/** Adapted from pi-hermes-memory 0.9.10 src/constants.ts (MIT).
 * Changes: bot-scoped PostgreSQL storage; completed work may yield durable conclusions.
 */
export const MEMORY_WRITE_POLICY = `Save durable information to persistent memory that survives across sessions. Memory is searchable in future turns, so keep it compact and focused on facts that will still matter later.

WHEN TO SAVE (do this proactively, don't wait to be asked):
- User corrects you or says 'remember this' / 'don't do that again'
- User shares a preference, habit, or personal detail (name, role, timezone, coding style)
- You discover something about the environment (OS, installed tools, project structure)
- You learn a convention, API quirk, or workflow specific to this user's setup
- You identify a stable fact that will be useful again in future sessions

PRIORITY: User preferences and corrections > environment facts > procedural knowledge.

Do NOT save temporary task progress or TODO state. Save verified durable conclusions with their source; keep execution progress in task checkpoints.`;
