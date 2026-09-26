package dev.tagent.android

import dev.tagent.android.domain.ApproveDecision
import dev.tagent.android.domain.IncomingEvent
import dev.tagent.android.domain.ReviewBlock
import dev.tagent.android.domain.SendDecision
import dev.tagent.android.domain.StoredAttempt
import dev.tagent.android.domain.canRejectPlan
import dev.tagent.android.domain.canRevisePlan
import dev.tagent.android.domain.cancelNote
import dev.tagent.android.domain.decideApprove
import dev.tagent.android.domain.decideSend
import dev.tagent.android.domain.deviceOfflineNote
import dev.tagent.android.domain.displayedTaskStatus
import dev.tagent.android.domain.mergeEvents
import dev.tagent.android.domain.nextCursor
import dev.tagent.android.domain.parseServerUrl
import dev.tagent.android.domain.progressLines
import dev.tagent.android.domain.showsApproved
import dev.tagent.android.domain.showsLocalOnly
import dev.tagent.android.domain.staleNote
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewRulesTest {
    @Test
    fun retriesTheSameIdempotencyKey() {
        val first = decideSend(true, null, "修复登录", { "key-1" })
        val send = first as SendDecision.Send
        val stored = StoredAttempt(send.key, send.body, confirmed = false, resultId = null)
        val retry = decideSend(true, stored, "修复登录", { "key-2" }) as SendDecision.Send
        assertEquals("key-1", retry.key)
        assertEquals("修复登录", retry.body)
    }

    @Test
    fun differentBodyDoesNotCreateAnotherTask() {
        val stored = StoredAttempt("key-1", "修复登录", confirmed = false, resultId = null)
        val decision = decideSend(true, stored, "换成别的需求", { "key-2" })
        assertTrue(decision is SendDecision.Conflict)
    }

    @Test
    fun offlineDoesNotShowApprovalSuccess() {
        val decision = decideApprove(false, "awaiting_review", false, true, false, false, null, null) { "new" }
        assertEquals(ApproveDecision.Blocked(ReviewBlock.Offline), decision)
        assertFalse(showsApproved(null, "awaiting_review"))
        assertFalse(showsApproved("submitting", "awaiting_review"))
        assertFalse(showsApproved("failed", "awaiting_review"))
    }

    @Test
    fun oldPlanAndOpenQuestionsCannotBeApproved() {
        val old = decideApprove(true, "awaiting_review", false, isLatest = false, superseded = false, hasQuestions = false, null, null) { "new" }
        val superseded = decideApprove(true, "awaiting_review", false, true, superseded = true, false, null, null) { "new" }
        val questions = decideApprove(true, "awaiting_review", false, true, false, hasQuestions = true, null, null) { "new" }
        assertEquals(ApproveDecision.Blocked(ReviewBlock.NotLatest), old)
        assertEquals(ApproveDecision.Blocked(ReviewBlock.NotLatest), superseded)
        assertEquals(ApproveDecision.Blocked(ReviewBlock.HasQuestions), questions)
        assertTrue(canRevisePlan("needs_replan", false))
        assertFalse(canRevisePlan("running", false))
        assertTrue(canRejectPlan("waiting_for_input"))
        assertFalse(canRejectPlan("running"))
    }

    @Test
    fun serverConfirmationIsTheOnlyApproval() {
        val confirmed = decideApprove(false, "awaiting_review", false, true, false, false, "key", "confirmed") { "new" }
        assertEquals(ApproveDecision.Confirmed, confirmed)
        assertTrue(showsApproved("confirmed", "awaiting_review"))
        assertTrue(showsApproved(null, "approved"))
    }

    @Test
    fun eventsDedupByIdAndCursorMovesForward() {
        val existing = listOf(IncomingEvent("a", 1), IncomingEvent("b", 2))
        val incoming = listOf(IncomingEvent("b", 2), IncomingEvent("c", 4))
        val merged = mergeEvents(existing, incoming)
        assertEquals(listOf("a", "b", "c"), merged.map { it.eventId })
        assertEquals(4, nextCursor(2, incoming))
    }

    @Test
    fun offlineDeviceDoesNotTurnTheTaskIntoFailure() {
        assertEquals("running", displayedTaskStatus("running", "offline"))
        assertEquals("Mac 离线，显示最后同步的状态。断线不会把任务改成失败。", deviceOfflineNote("offline"))
        assertNull(deviceOfflineNote("online"))
        assertEquals("取消待送达", cancelNote("running", true))
        assertNull(cancelNote("cancelled", true))
        assertEquals("暂时连不上云端，状态可能过期", staleNote(1, 10_000, refreshFailed = true))
    }

    @Test
    fun progressHidesSourceAndKeepsLocalArtifactsOnTheMac() {
        val events = listOf(
            "tool.finished" to """{"tool_name":"bash","status":"ok","exit_code":0,"verification":"not_run","duration_ms":12}""",
            "artifact.available" to """{"visibility":"local_only","summary":"diff should stay local"}""",
        )
        val lines = progressLines(events)
        assertEquals("bash", lines[0].title)
        assertTrue(lines[0].detail.contains("未验证"))
        assertFalse(lines[0].detail.contains("diff"))
        assertEquals("在 Mac 查看", lines[1].detail)
        assertTrue(showsLocalOnly(events))
    }

    @Test
    fun cleartextIsLimitedToLoopbackAndTheEmulator() {
        assertEquals("http://10.0.2.2:8000", parseServerUrl("http://10.0.2.2:8000/", true).base)
        assertEquals("ws://10.0.2.2:8000/ws/events", parseServerUrl("http://10.0.2.2:8000", true).eventsSocket)
        assertEquals("http://192.168.1.108:8000", parseServerUrl("http://192.168.1.108:8000", true).base)
        assertEquals("https://example.com", parseServerUrl("https://example.com", false).base)
        assertFails { parseServerUrl("http://example.com", true) }
        assertFails { parseServerUrl("http://8.8.8.8:8000", true) }
        assertFails { parseServerUrl("http://192.168.1.108:8000", false) }
        assertFails { parseServerUrl("http://10.0.2.2:8000", false) }
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
        } catch (_: IllegalArgumentException) {
            return
        }
        throw AssertionError("expected IllegalArgumentException")
    }
}
