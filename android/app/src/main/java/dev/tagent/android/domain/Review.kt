package dev.tagent.android.domain

import java.util.UUID

fun newIdempotencyKey(): String = UUID.randomUUID().toString()

data class StoredAttempt(
    val idempotencyKey: String?,
    val body: String,
    val confirmed: Boolean,
    val resultId: String?,
)

sealed interface SendDecision {
    data class Send(val key: String, val body: String) : SendDecision
    data class AlreadyConfirmed(val resultId: String) : SendDecision
    data class Conflict(val message: String) : SendDecision
    data class Blocked(val reason: ReviewBlock) : SendDecision
}

fun decideSend(online: Boolean, stored: StoredAttempt?, body: String, newKey: () -> String): SendDecision {
    val text = body.trim()
    if (text.isEmpty()) return SendDecision.Conflict("内容不能为空")
    if (stored?.confirmed == true) {
        return if (stored.body == text) {
            SendDecision.AlreadyConfirmed(stored.resultId ?: "")
        } else {
            SendDecision.Send(newKey(), text)
        }
    }
    if (stored?.idempotencyKey != null && stored.body != text) {
        return SendDecision.Conflict("同一幂等键不能改成不同内容，未另发")
    }
    if (!online) return SendDecision.Blocked(ReviewBlock.Offline)
    return SendDecision.Send(stored?.idempotencyKey ?: newKey(), text)
}

enum class ReviewBlock {
    Offline,
    NotLatest,
    HasQuestions,
    NotAwaiting,
    CancelPending,
}

sealed interface ApproveDecision {
    data class Send(val key: String) : ApproveDecision
    data object Confirmed : ApproveDecision
    data class Blocked(val reason: ReviewBlock) : ApproveDecision
}

fun decideApprove(
    online: Boolean,
    taskStatus: String,
    cancelRequested: Boolean,
    isLatest: Boolean,
    superseded: Boolean,
    hasQuestions: Boolean,
    storedKey: String?,
    storedPhase: String?,
    newKey: () -> String,
): ApproveDecision {
    if (storedPhase == "confirmed") return ApproveDecision.Confirmed
    if (!online) return ApproveDecision.Blocked(ReviewBlock.Offline)
    if (hasQuestions) return ApproveDecision.Blocked(ReviewBlock.HasQuestions)
    if (!isLatest || superseded) return ApproveDecision.Blocked(ReviewBlock.NotLatest)
    if (cancelRequested) return ApproveDecision.Blocked(ReviewBlock.CancelPending)
    if (taskStatus != "awaiting_review") return ApproveDecision.Blocked(ReviewBlock.NotAwaiting)
    return ApproveDecision.Send(storedKey ?: newKey())
}

fun showsApproved(phase: String?, taskStatus: String): Boolean =
    phase == "confirmed" || taskStatus == "approved" || taskStatus == "running" || taskStatus == "completed"

fun canRevisePlan(status: String, cancelRequested: Boolean): Boolean =
    !cancelRequested && status in setOf("awaiting_review", "waiting_for_input", "needs_replan", "interrupted")

fun canRejectPlan(status: String): Boolean = status == "awaiting_review" || status == "waiting_for_input"

fun reviewBlockMessage(reason: ReviewBlock): String = when (reason) {
    ReviewBlock.Offline -> "需要连接云端后才能提交，未记为成功"
    ReviewBlock.NotLatest -> "这不是最新计划，不能批准"
    ReviewBlock.HasQuestions -> "请先回答计划中的待确认问题"
    ReviewBlock.NotAwaiting -> "任务当前不能批准"
    ReviewBlock.CancelPending -> "取消正在送达，不能批准"
}
