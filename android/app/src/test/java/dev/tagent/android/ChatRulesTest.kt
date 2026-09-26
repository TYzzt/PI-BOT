package dev.tagent.android

import dev.tagent.android.domain.ChatMessageSnapshot
import dev.tagent.android.domain.QuestionBlock
import dev.tagent.android.domain.QuestionDecision
import dev.tagent.android.domain.chatRunLabel
import dev.tagent.android.domain.decideQuestion
import dev.tagent.android.domain.mergeChatMessages
import dev.tagent.android.domain.questionBlockMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatRulesTest {
    @Test
    fun busyConversationCannotSendAnotherQuestion() {
        val decision = decideQuestion(online = true, activeRunState = "running", shared = true, text = "继续解释")
        assertEquals(QuestionDecision.Blocked(QuestionBlock.Busy), decision)
        assertEquals("这条会话还有未结束的问题", questionBlockMessage(QuestionBlock.Busy))
    }

    @Test
    fun offlineDoesNotConfirmTheQuestion() {
        val decision = decideQuestion(online = false, activeRunState = null, shared = true, text = "继续解释")
        assertEquals(QuestionDecision.Blocked(QuestionBlock.Offline), decision)
        assertTrue(questionBlockMessage(QuestionBlock.Offline).contains("未记为已提交"))
        val queuedOffline = decideQuestion(online = false, activeRunState = "queued", shared = true, text = "继续解释")
        assertEquals(QuestionDecision.Blocked(QuestionBlock.Offline), queuedOffline)
    }

    @Test
    fun finishedRunCanReceiveAnotherQuestion() {
        val decision = decideQuestion(online = true, activeRunState = "completed", shared = true, text = "再问一次")
        assertEquals(QuestionDecision.Send, decision)
    }

    @Test
    fun messagesMergeByIdAndPreferHigherSequence() {
        val existing = listOf(
            ChatMessageSnapshot("a", sequence = 1, version = 4),
            ChatMessageSnapshot("b", sequence = 2, version = 1),
        )
        val incoming = listOf(
            ChatMessageSnapshot("a", sequence = 1, version = 2),
            ChatMessageSnapshot("b", sequence = 5, version = 1),
            ChatMessageSnapshot("c", sequence = 0, version = 1),
        )
        val merged = mergeChatMessages(existing, incoming)
        assertEquals(listOf("a", "b", "c"), merged.map { it.id })
        assertEquals(4, merged.first { it.id == "a" }.version)
        assertEquals(5, merged.first { it.id == "b" }.sequence)
        assertEquals(0, merged.first { it.id == "c" }.sequence)
    }

    @Test
    fun runLabelsShowQueueGenerationAndCancel() {
        assertEquals("排队，等 Mac 恢复", chatRunLabel("queued", false, "offline"))
        assertEquals("排队", chatRunLabel("queued", false, "online"))
        assertEquals("生成中", chatRunLabel("running", false, "online"))
        assertEquals("取消中", chatRunLabel("running", true, "online"))
        assertEquals("完成", chatRunLabel("completed", false, "online"))
        assertEquals("失败", chatRunLabel("failed", false, "offline"))
        assertEquals("已中断", chatRunLabel("interrupted", false, "online"))
    }
}
