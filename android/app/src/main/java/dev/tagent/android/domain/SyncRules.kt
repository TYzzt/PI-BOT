package dev.tagent.android.domain

data class IncomingEvent(val eventId: String, val serverCursor: Long)

fun mergeEvents(existing: List<IncomingEvent>, incoming: List<IncomingEvent>): List<IncomingEvent> {
    val byId = linkedMapOf<String, IncomingEvent>()
    (existing + incoming).forEach { item ->
        val previous = byId[item.eventId]
        if (previous == null || item.serverCursor >= previous.serverCursor) byId[item.eventId] = item
    }
    return byId.values.sortedBy { it.serverCursor }
}

fun nextCursor(current: Long, events: List<IncomingEvent>): Long =
    events.fold(current) { cursor, event -> maxOf(cursor, event.serverCursor) }

fun displayedTaskStatus(serverStatus: String, presence: String): String = serverStatus

fun deviceOfflineNote(presence: String): String? =
    if (presence == "offline") "Mac 离线，显示最后同步的状态。断线不会把任务改成失败。" else null

fun staleNote(lastSyncAt: Long?, now: Long, refreshFailed: Boolean, maxAgeMillis: Long = 120_000): String? {
    if (refreshFailed) return "暂时连不上云端，状态可能过期"
    if (lastSyncAt != null && now - lastSyncAt > maxAgeMillis) return "状态可能过期"
    return null
}

fun cancelNote(status: String, cancelRequested: Boolean): String? =
    if (cancelRequested && status != "cancelled") "取消待送达" else null

fun taskStatusLabel(status: String): String = when (status) {
    "queued" -> "排队中"
    "waiting_for_device" -> "等待 Mac"
    "planning" -> "正在规划"
    "awaiting_review" -> "等待审阅"
    "approved" -> "已批准"
    "running" -> "执行中"
    "waiting_for_input" -> "等待补充"
    "waiting_for_local_action" -> "需要在 Mac 上操作"
    "needs_replan" -> "需要重新规划"
    "interrupted" -> "已中断"
    "completed" -> "已完成"
    "failed" -> "失败"
    "cancelled" -> "已取消"
    "rejected" -> "已拒绝"
    else -> status
}

fun presenceLabel(presence: String?): String = when (presence) {
    "online" -> "在线"
    "offline" -> "离线"
    else -> "未知"
}

fun availabilityLabel(availability: String): String = when (availability) {
    "available" -> "可用"
    "unavailable" -> "不可用"
    else -> availability
}

val TERMINAL_TASK = setOf("completed", "failed", "cancelled", "rejected")

fun canRequestCancel(status: String, cancelRequested: Boolean): Boolean =
    status !in TERMINAL_TASK && !cancelRequested
