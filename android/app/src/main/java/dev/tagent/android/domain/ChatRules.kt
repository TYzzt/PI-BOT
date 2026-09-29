package dev.tagent.android.domain

val TERMINAL_CHAT = setOf("completed", "failed", "cancelled", "interrupted")

/** A linked coding task is still planning or executing, so this conversation cannot take another run. */
val PLAN_IN_PROGRESS = setOf("queued", "waiting_for_device", "planning", "approved", "running", "waiting_for_local_action")

fun planInProgress(status: String?): Boolean = status != null && status in PLAN_IN_PROGRESS

enum class QuestionBlock {
    Offline,
    Busy,
    Empty,
    NotShared,
}

sealed interface QuestionDecision {
    data object Send : QuestionDecision
    data class Blocked(val reason: QuestionBlock) : QuestionDecision
}

fun decideQuestion(online: Boolean, activeRunState: String?, shared: Boolean, text: String): QuestionDecision {
    if (text.trim().isEmpty()) return QuestionDecision.Blocked(QuestionBlock.Empty)
    if (!shared) return QuestionDecision.Blocked(QuestionBlock.NotShared)
    if (!online) return QuestionDecision.Blocked(QuestionBlock.Offline)
    if (activeRunState != null && activeRunState !in TERMINAL_CHAT) return QuestionDecision.Blocked(QuestionBlock.Busy)
    return QuestionDecision.Send
}

fun questionBlockMessage(reason: QuestionBlock): String = when (reason) {
    QuestionBlock.Offline -> "需要连接云端后才能发送，未记为已提交"
    QuestionBlock.Busy -> "这条会话还有未结束的问题"
    QuestionBlock.Empty -> "内容不能为空"
    QuestionBlock.NotShared -> "会话已停止共享，不能继续提问"
}

data class ChatMessageSnapshot(val id: String, val sequence: Int, val version: Int)

fun mergeChatMessages(existing: List<ChatMessageSnapshot>, incoming: List<ChatMessageSnapshot>): List<ChatMessageSnapshot> {
    val byId = linkedMapOf<String, ChatMessageSnapshot>()
    (existing + incoming).forEach { item ->
        val previous = byId[item.id]
        if (previous == null || item.sequence > previous.sequence || (item.sequence == previous.sequence && item.version >= previous.version)) {
            byId[item.id] = item
        }
    }
    return byId.values.sortedWith(compareBy({ if (it.sequence == 0) 1 else 0 }, { it.sequence }))
}

fun chatRunLabel(state: String, cancelRequested: Boolean, presence: String?, target: String = "mac"): String = when {
    state == "queued" && target == "cloud" -> "排队，等待云端领取"
    state == "queued" && presence == "offline" -> "排队，等 Mac 恢复"
    state == "queued" -> "排队"
    (state == "running" && cancelRequested) || (cancelRequested && state !in TERMINAL_CHAT) -> "取消中"
    state == "running" -> "生成中"
    state == "completed" -> "完成"
    state == "failed" -> "失败"
    state == "cancelled" -> "已取消"
    state == "interrupted" -> "已中断"
    else -> state
}

fun messageStatusLabel(status: String): String? = when (status) {
    "queued" -> "排队"
    "running" -> "生成中"
    "failed" -> "失败"
    "cancelled" -> "已取消"
    "interrupted" -> "已中断"
    else -> null
}

fun conversationKindLabel(kind: String): String = when (kind) {
    "ask" -> "问答"
    "read_code" -> "只读代码"
    else -> kind
}

fun canCancelChat(state: String): Boolean = state !in TERMINAL_CHAT

const val CLOUD_TARGET = "cloud"

/** Cloud conversations run on the server worker, so Mac presence is irrelevant to them. */
fun conversationSourceLabel(target: String, kind: String, deviceLabel: String?, presence: String?, handoffCount: Int = 0): String =
    if (target == CLOUD_TARGET) {
        "云端问答" + if (handoffCount > 0) " · 由 Mac 会话转来（$handoffCount 条）" else ""
    } else {
        "${conversationKindLabel(kind)} · ${deviceLabel ?: "Mac"} · ${presenceLabel(presence)}"
    }

fun assistantLabel(target: String): String = if (target == CLOUD_TARGET) "云端助手" else "Mac"

/** Only shared Mac conversations can seed a cloud conversation; cloud ones already are. */
fun canHandoff(target: String, shared: Boolean): Boolean = target != CLOUD_TARGET && shared
