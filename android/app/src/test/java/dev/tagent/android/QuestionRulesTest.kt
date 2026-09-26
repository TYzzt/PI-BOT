package dev.tagent.android

import dev.tagent.android.data.api.API_JSON
import dev.tagent.android.data.api.PlanBody
import dev.tagent.android.data.api.PlanChoice
import dev.tagent.android.data.api.PlanOption
import dev.tagent.android.data.api.PlanQuestion
import dev.tagent.android.domain.ApproveDecision
import dev.tagent.android.domain.QuestionPick
import dev.tagent.android.domain.ReviewBlock
import dev.tagent.android.domain.answersReady
import dev.tagent.android.domain.decideApprove
import dev.tagent.android.domain.formatQuestionAnswers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QuestionRulesTest {
    private val choice = PlanQuestion.Choice(
        PlanChoice("channel", "频道缺失时", listOf(PlanOption("error", "直接报错"), PlanOption("fallback", "回退当前频道")), false),
    )

    @Test
    fun unfinishedChoiceCannotSubmit() {
        assertFalse(answersReady(listOf(choice), emptyMap()))
        val picks = mapOf("channel" to QuestionPick(setOf("error")))
        assertTrue(answersReady(listOf(choice), picks))
        assertEquals("问题「频道缺失时」选择：直接报错", formatQuestionAnswers(listOf(choice), picks))
    }

    @Test
    fun legacyQuestionNeedsTextAndBlocksExecution() {
        val legacy = PlanQuestion.Legacy("请提供期望结果")
        assertFalse(answersReady(listOf(legacy), emptyMap()))
        val picks = mapOf("legacy:0" to QuestionPick(other = "返回 5"))
        assertEquals("问题「请提供期望结果」选择：返回 5", formatQuestionAnswers(listOf(legacy), picks))
        val blocked = decideApprove(true, "awaiting_review", false, true, false, hasQuestions = true, null, null) { "new" }
        assertEquals(ApproveDecision.Blocked(ReviewBlock.HasQuestions), blocked)
    }

    @Test
    fun planBodyReadsBothQuestionShapes() {
        val body = API_JSON.decodeFromString(
            PlanBody.serializer(),
            """{"goal":"g","questions":["旧问题",{"id":"channel","prompt":"频道缺失时","allow_multiple":true,"options":[{"id":"error","label":"直接报错"},{"id":"fallback","label":"回退当前频道"}]}]}""",
        )
        assertTrue(body.questions[0] is PlanQuestion.Legacy)
        val chosen = body.questions[1] as PlanQuestion.Choice
        assertEquals("频道缺失时", chosen.choice.prompt)
        assertTrue(chosen.choice.allowMultiple)
    }
}
