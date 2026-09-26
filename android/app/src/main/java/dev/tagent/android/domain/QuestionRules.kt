package dev.tagent.android.domain

import dev.tagent.android.data.api.PlanQuestion

data class QuestionPick(val optionIds: Set<String> = emptySet(), val other: String = "")

fun questionKey(question: PlanQuestion, index: Int): String = when (question) {
    is PlanQuestion.Legacy -> "legacy:$index"
    is PlanQuestion.Choice -> question.choice.id.ifBlank { "legacy:$index" }
}

fun questionPrompt(question: PlanQuestion): String = when (question) {
    is PlanQuestion.Legacy -> question.prompt
    is PlanQuestion.Choice -> question.choice.prompt
}

fun answersReady(questions: List<PlanQuestion>, picks: Map<String, QuestionPick>): Boolean =
    questions.indices.all { index ->
        val question = questions[index]
        val pick = picks[questionKey(question, index)] ?: QuestionPick()
        val other = pick.other.trim()
        when (question) {
            is PlanQuestion.Legacy -> other.isNotEmpty()
            is PlanQuestion.Choice -> {
                val count = question.choice.options.count { pick.optionIds.contains(it.id) }
                if (question.choice.allowMultiple) count > 0 || other.isNotEmpty() else count == 1 || (count == 0 && other.isNotEmpty())
            }
        }
    }

fun formatQuestionAnswers(questions: List<PlanQuestion>, picks: Map<String, QuestionPick>): String =
    questions.mapIndexed { index, question ->
        val pick = picks[questionKey(question, index)] ?: QuestionPick()
        val other = pick.other.trim()
        val selected = when (question) {
            is PlanQuestion.Legacy -> other
            is PlanQuestion.Choice -> {
                val labels = question.choice.options.filter { pick.optionIds.contains(it.id) }.joinToString("、") { it.label }
                when {
                    labels.isNotEmpty() && other.isNotEmpty() -> "$labels；其他：$other"
                    labels.isNotEmpty() -> labels
                    other.isNotEmpty() -> "其他：$other"
                    else -> ""
                }
            }
        }
        "问题「${questionPrompt(question)}」选择：$selected"
    }.joinToString("\n")
