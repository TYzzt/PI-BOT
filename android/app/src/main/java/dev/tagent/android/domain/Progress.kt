package dev.tagent.android.domain

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class EventPayload(
    @SerialName("step_id") val stepId: String? = null,
    val title: String? = null,
    val summary: String? = null,
    @SerialName("tool_name") val toolName: String? = null,
    val status: String? = null,
    @SerialName("exit_code") val exitCode: Int? = null,
    val verification: String? = null,
    @SerialName("duration_ms") val durationMs: Long? = null,
    val visibility: String? = null,
)

data class ProgressLine(val title: String, val detail: String)

private val payloadJson = Json { ignoreUnknownKeys = true }

fun progressLines(events: List<Pair<String, String>>): List<ProgressLine> {
    val lines = mutableListOf<ProgressLine>()
    events.forEach { (type, raw) ->
        val payload = runCatching { payloadJson.decodeFromString(EventPayload.serializer(), raw) }.getOrDefault(EventPayload())
        when (type) {
            "step.started", "step.updated", "step.completed", "step.failed" -> {
                val state = when (type) {
                    "step.started" -> "开始"
                    "step.updated" -> "进行中"
                    "step.completed" -> "完成"
                    else -> "失败"
                }
                val title = payload.title ?: payload.stepId ?: "步骤"
                lines += ProgressLine(title, listOfNotNull(state, payload.summary).joinToString(" · "))
            }
            "tool.started", "tool.finished" -> {
                val name = payload.toolName ?: "工具"
                val bits = listOfNotNull(
                    if (type == "tool.started") "开始" else payload.status,
                    payload.exitCode?.let { "退出码 $it" },
                    verificationLabel(payload.verification),
                    payload.durationMs?.let { "${it} ms" },
                    payload.summary,
                )
                lines += ProgressLine(name, bits.joinToString(" · "))
            }
            "artifact.available" -> {
                val where = if (payload.visibility == "shared") payload.summary ?: "共享摘要" else "在 Mac 查看"
                lines += ProgressLine("本地成果", where)
            }
        }
    }
    return lines
}

fun showsLocalOnly(events: List<Pair<String, String>>): Boolean = events.any { (type, raw) ->
    if (type != "artifact.available") return@any false
    val payload = runCatching { payloadJson.decodeFromString(EventPayload.serializer(), raw) }.getOrNull()
    payload?.visibility != "shared"
}

private fun verificationLabel(value: String?): String? = when (value) {
    "passed" -> "验证通过"
    "failed" -> "验证失败"
    "not_run" -> "未验证"
    "cancelled" -> "验证已取消"
    else -> null
}
