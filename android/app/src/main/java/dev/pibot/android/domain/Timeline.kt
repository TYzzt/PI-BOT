package dev.pibot.android.domain

import dev.pibot.android.data.Bot
import dev.pibot.android.data.Message
import dev.pibot.android.face.moodFor
import dev.pibot.android.face.sleepLabel
import java.time.Instant

/** One bot's loaded timeline: messages in `seq` order, plus whether older pages exist. */
data class Timeline(val messages: List<Message> = emptyList(), val hasMore: Boolean = false, val loaded: Boolean = false) {
    /** Union by id (newer copies win), ordered by seq. */
    fun merge(incoming: List<Message>, hasMore: Boolean = this.hasMore): Timeline {
        val byId = LinkedHashMap<String, Message>()
        for (m in messages) byId[m.id] = m
        for (m in incoming) byId[m.id] = m
        return copy(messages = byId.values.sortedBy { it.seq }, hasMore = hasMore, loaded = true)
    }

    /** Streaming text for a running reply; ignored once the message has finished. */
    fun applyDelta(messageId: String, content: String): Timeline {
        val i = messages.indexOfFirst { it.id == messageId }
        if (i < 0 || messages[i].status != "running" || messages[i].content.length > content.length) return this
        return copy(messages = messages.toMutableList().also { it[i] = it[i].copy(content = content) })
    }

    val oldestSeq: Int? get() = messages.firstOrNull()?.seq

    /** Tool the bot is running right now, for the character's mood. */
    val runningTool: String? get() = messages.lastOrNull { it.status == "running" }?.tools?.lastOrNull { it.state == "running" }?.name
}

fun epochMillis(iso: String?): Long? = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

fun Bot.mood(now: Long = System.currentTimeMillis(), tool: String? = null): String = moodFor(
    status = latestRun?.status,
    tool = tool,
    finishedAt = epochMillis(latestRun?.finishedAt),
    lastActiveAt = epochMillis(lastActiveAt),
    now = now,
)

/** One-line status under a bot's name in lists. */
fun Bot.statusLine(now: Long = System.currentTimeMillis()): String {
    if (pendingApprovals.isNotEmpty()) return "等你批准…"
    when (latestRun?.status) {
        "queued" -> return "排队中…"
        "running" -> return if (latestRun.executor == "cloud") "在云端思考…" else "工作中…"
        "waiting_approval" -> return "等你批准…"
        "failed" -> if (lastMessage?.status == "failed") return "出错了"
    }
    if (mood(now) == "sleeping") return "睡着了 · " + (epochMillis(lastActiveAt)?.let { sleepLabel(it, now) } ?: "")
    return lastMessage?.preview?.let(::plainPreview)?.takeIf { it.isNotEmpty() } ?: "还没有对话，打个招呼吧"
}

/** First meaningful line of a reply without Markdown marks. */
fun plainPreview(text: String): String =
    text.lineSequence()
        .map { it.trim().replace(Regex("^(#{1,6}|[-*+>]|\\d+[.)])\\s+"), "").replace("`", "").replace("**", "").trim() }
        .firstOrNull { it.isNotEmpty() && !it.startsWith("|") } ?: ""

val TOOL_LABELS = mapOf(
    "list_files" to "查看目录",
    "read_file" to "读取文件",
    "search_files" to "搜索文件",
    "write_file" to "写入文件",
    "edit_file" to "修改文件",
    "run_command" to "执行命令",
    "request_outside_access" to "申请访问",
    "web_search" to "联网搜索",
)

fun toolLabel(name: String) = TOOL_LABELS[name] ?: name.ifBlank { "工具" }
