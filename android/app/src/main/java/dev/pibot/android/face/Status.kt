package dev.pibot.android.face

private val SEARCH_TOOLS = setOf("web_search", "search_files", "list_files", "read_file")
const val SLEEP_AFTER_MS = 3 * 86_400_000L
private const val AFTERGLOW_MS = 6_000L

/** Same mapping as `moodFor` in `packages/bot-face/src/status.ts`. */
fun moodFor(status: String?, tool: String? = null, finishedAt: Long? = null, lastActiveAt: Long? = null, now: Long = System.currentTimeMillis()): String {
    when (status) {
        "queued" -> return "thinking"
        "running" -> return when {
            tool == "ask_agent" -> "waiting"
            tool != null -> if (tool in SEARCH_TOOLS) "searching" else "working"
            else -> "thinking"
        }
        "waiting_approval" -> return "waiting"
        "completed" -> if (finishedAt != null && now - finishedAt < AFTERGLOW_MS) return "celebrate"
        "failed" -> if (finishedAt != null && now - finishedAt < AFTERGLOW_MS) return "error"
    }
    if (lastActiveAt != null && now - lastActiveAt > SLEEP_AFTER_MS) return "sleeping"
    return "idle"
}

/** "7 天" style label shown under a sleeping bot. */
fun sleepLabel(lastActiveAt: Long, now: Long = System.currentTimeMillis()): String? {
    val days = (now - lastActiveAt) / 86_400_000L
    return if (days >= 1) "$days 天" else null
}
