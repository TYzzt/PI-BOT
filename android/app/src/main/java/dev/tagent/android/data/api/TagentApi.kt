package dev.tagent.android.data.api

import dev.tagent.android.domain.ServerUrl
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
data class TokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("expires_in") val expiresIn: Long,
)

@Serializable
data class DevicePublic(
    @SerialName("device_id") val deviceId: String,
    val label: String,
    val presence: String,
    @SerialName("last_seen_at") val lastSeenAt: String? = null,
    @SerialName("revoked_at") val revokedAt: String? = null,
)

@Serializable
data class ProjectPublic(
    @SerialName("project_id") val projectId: String,
    @SerialName("device_id") val deviceId: String,
    @SerialName("display_name") val displayName: String,
    val availability: String,
    @SerialName("updated_at") val updatedAt: String,
)

@Serializable
data class PlanStep(
    @SerialName("step_id") val stepId: String = "",
    val title: String = "",
    val description: String = "",
)

@Serializable
data class PlanOption(val id: String = "", val label: String = "")

@Serializable
data class PlanChoice(
    val id: String = "",
    val prompt: String = "",
    val options: List<PlanOption> = emptyList(),
    @SerialName("allow_multiple") val allowMultiple: Boolean = false,
)

@Serializable(with = PlanQuestionSerializer::class)
sealed interface PlanQuestion {
    data class Legacy(val prompt: String) : PlanQuestion
    data class Choice(val choice: PlanChoice) : PlanQuestion
}

object PlanQuestionSerializer : KSerializer<PlanQuestion> {
    override val descriptor = buildClassSerialDescriptor("PlanQuestion")

    override fun deserialize(decoder: Decoder): PlanQuestion {
        val json = decoder as JsonDecoder
        val element = json.decodeJsonElement()
        return when {
            element is JsonPrimitive && element.isString -> PlanQuestion.Legacy(element.content)
            element is JsonObject -> PlanQuestion.Choice(json.json.decodeFromJsonElement(PlanChoice.serializer(), element))
            else -> PlanQuestion.Legacy("")
        }
    }

    override fun serialize(encoder: Encoder, value: PlanQuestion) {
        val json = encoder as JsonEncoder
        when (value) {
            is PlanQuestion.Legacy -> json.encodeString(value.prompt)
            is PlanQuestion.Choice -> json.encodeSerializableValue(PlanChoice.serializer(), value.choice)
        }
    }
}

@Serializable
data class PlanBody(
    val goal: String = "",
    val scope: List<String> = emptyList(),
    @SerialName("non_goals") val nonGoals: List<String> = emptyList(),
    val modules: List<String> = emptyList(),
    val steps: List<PlanStep> = emptyList(),
    val verification: List<String> = emptyList(),
    val acceptance: List<String> = emptyList(),
    val questions: List<PlanQuestion> = emptyList(),
)

@Serializable
data class PlanSummary(
    @SerialName("plan_id") val planId: String,
    val version: Int,
    @SerialName("content_hash") val contentHash: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("superseded_at") val supersededAt: String? = null,
)

@Serializable
data class PlanPublic(
    @SerialName("plan_id") val planId: String,
    @SerialName("task_id") val taskId: String,
    val version: Int,
    @SerialName("content_hash") val contentHash: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("superseded_at") val supersededAt: String? = null,
    val body: PlanBody,
)

@Serializable
data class RunPublic(
    @SerialName("run_id") val runId: String,
    val phase: String,
    val state: String,
    @SerialName("updated_at") val updatedAt: String,
)

@Serializable
data class TaskSummary(
    @SerialName("task_id") val taskId: String,
    @SerialName("project_id") val projectId: String,
    @SerialName("target_device_id") val targetDeviceId: String,
    val requirement: String,
    val status: String,
    @SerialName("cancel_requested") val cancelRequested: Boolean,
    @SerialName("cancel_requested_at") val cancelRequestedAt: String? = null,
    @SerialName("latest_plan_id") val latestPlanId: String? = null,
    @SerialName("device_presence") val devicePresence: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
)

@Serializable
data class TaskDetail(
    @SerialName("task_id") val taskId: String,
    @SerialName("project_id") val projectId: String,
    @SerialName("target_device_id") val targetDeviceId: String,
    val requirement: String,
    val status: String,
    @SerialName("cancel_requested") val cancelRequested: Boolean,
    @SerialName("cancel_requested_at") val cancelRequestedAt: String? = null,
    @SerialName("latest_plan_id") val latestPlanId: String? = null,
    @SerialName("device_presence") val devicePresence: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
    val plans: List<PlanSummary> = emptyList(),
    val runs: List<RunPublic> = emptyList(),
)

@Serializable
data class ApprovalPublic(
    @SerialName("approval_id") val approvalId: String,
    @SerialName("run_id") val runId: String,
    val version: Int,
    @SerialName("content_hash") val contentHash: String,
)

@Serializable
data class EventPublic(
    @SerialName("event_id") val eventId: String,
    @SerialName("server_cursor") val serverCursor: Long,
    val type: String,
    @SerialName("task_id") val taskId: String? = null,
    @SerialName("occurred_at") val occurredAt: String,
    val payload: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class EventPage(
    val events: List<EventPublic> = emptyList(),
    @SerialName("next_cursor") val nextCursor: Long,
    @SerialName("has_more") val hasMore: Boolean,
)

@Serializable
private data class LoginBody(val password: String)

@Serializable
private data class TaskCreateBody(
    @SerialName("project_id") val projectId: String,
    val requirement: String,
    @SerialName("idempotency_key") val idempotencyKey: String,
)

@Serializable
private data class ApproveBody(
    val version: Int,
    @SerialName("content_hash") val contentHash: String,
    @SerialName("idempotency_key") val idempotencyKey: String,
)

@Serializable
private data class RejectBody(@SerialName("idempotency_key") val idempotencyKey: String)

@Serializable
private data class ReviseBody(val feedback: String, @SerialName("idempotency_key") val idempotencyKey: String)

@Serializable
private class EmptyBody

@Serializable
data class PlanSendPublic(
    val mode: String,
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("message_id") val messageId: String,
    @SerialName("task_id") val taskId: String,
    val action: String,
)

@Serializable
private data class SendMessageBody(
    val text: String,
    @SerialName("request_id") val requestId: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val mode: String? = null,
)

@Serializable
data class HandoffPublic(
    @SerialName("from_conversation_id") val fromConversationId: String,
    @SerialName("message_count") val messageCount: Int,
)

// device_id is null for cloud-executed documents.
@Serializable
data class ConversationPublic(
    val id: String,
    @SerialName("device_id") val deviceId: String? = null,
    val version: Int,
    val title: String,
    val kind: String,
    val target: String = "mac",
    val handoff: HandoffPublic? = null,
    @SerialName("model_config_id") val modelConfigId: String,
    @SerialName("project_id") val projectId: String? = null,
    @SerialName("task_id") val taskId: String? = null,
    val shared: Boolean = true,
    @SerialName("share_version") val shareVersion: Int = 1,
    val deleted: Boolean = false,
)

@Serializable
data class MessagePublic(
    val id: String,
    @SerialName("device_id") val deviceId: String? = null,
    val version: Int,
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("run_id") val runId: String,
    val role: String,
    val content: String,
    val status: String,
    val sequence: Int,
)

@Serializable
data class ChatRunPublic(
    val id: String,
    @SerialName("device_id") val deviceId: String? = null,
    val version: Int,
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("message_id") val messageId: String,
    val text: String,
    val state: String,
    @SerialName("share_version") val shareVersion: Int,
    val acked: Boolean,
    @SerialName("cancel_requested") val cancelRequested: Boolean,
    @SerialName("local_run_id") val localRunId: String? = null,
    val error: String? = null,
)

@Serializable
data class CloudModelConfig(val name: String, @SerialName("model_id") val modelId: String, @SerialName("is_default") val isDefault: Boolean = false)

@Serializable
data class CloudModelPublic(
    val id: String,
    val version: Int,
    val config: CloudModelConfig,
    val deleted: Boolean = false,
    @SerialName("source_model_id") val sourceModelId: String? = null,
)

@Serializable
private data class CloudConversationBody(
    @SerialName("expected_version") val expectedVersion: Int,
    @SerialName("request_id") val requestId: String,
    val title: String,
    @SerialName("model_config_id") val modelConfigId: String,
)

@Serializable
private data class HandoffBody(@SerialName("request_id") val requestId: String, @SerialName("model_config_id") val modelConfigId: String)

@Serializable
data class MessagePage(
    @SerialName("pending_messages") val pendingMessages: List<MessagePublic> = emptyList(),
    val messages: List<MessagePublic> = emptyList(),
    @SerialName("next_cursor") val nextCursor: Int = 0,
    @SerialName("has_more") val hasMore: Boolean = false,
)

@Serializable
data class WsSubscribe(val type: String = "subscribe", val after: Long)

@Serializable
data class WsEnvelope(val type: String, val event: EventPublic? = null, val detail: String? = null)

@Serializable
data class ConfigReason(val code: String, val detail: String = "")

@Serializable
data class DeviceConfigState(
    @SerialName("device_id") val deviceId: String,
    val label: String = "",
    val state: String,
    @SerialName("checked_version") val checkedVersion: Int = 0,
    val reasons: List<ConfigReason> = emptyList(),
    @SerialName("applied_version") val appliedVersion: Int = 0,
)

@Serializable
data class SkillFile(val path: String, val content: String)

@Serializable
data class SkillRequires(
    val commands: List<String> = emptyList(),
    val platforms: List<String> = emptyList(),
    val scripts: List<String> = emptyList(),
    val mcp: List<String> = emptyList(),
)

@Serializable
data class SkillConfig(
    val name: String,
    val description: String = "",
    val content: String,
    val files: List<SkillFile> = emptyList(),
    val runtime: String = "mac",
    val enabled: Boolean = true,
    val requires: SkillRequires = SkillRequires(),
    @SerialName("install_hint") val installHint: String? = null,
)

@Serializable
data class McpEnv(val name: String, val value: String? = null, @SerialName("secret_ref") val secretRef: String? = null)

@Serializable
data class McpConfig(
    val name: String,
    val transport: String = "stdio",
    val command: String? = null,
    val args: List<String> = emptyList(),
    val url: String? = null,
    @SerialName("timeout_ms") val timeoutMs: Int = 30000,
    val env: List<McpEnv> = emptyList(),
    val runtime: String = "mac",
    val enabled: Boolean = true,
    @SerialName("disabled_tools") val disabledTools: List<String> = emptyList(),
)

@Serializable
data class SkillPublic(
    val id: String,
    val version: Int,
    @SerialName("content_hash") val contentHash: String,
    val deleted: Boolean = false,
    val devices: List<DeviceConfigState> = emptyList(),
    val config: SkillConfig,
)

@Serializable
data class McpServerPublic(
    val id: String,
    val version: Int,
    @SerialName("content_hash") val contentHash: String,
    val deleted: Boolean = false,
    val devices: List<DeviceConfigState> = emptyList(),
    val config: McpConfig,
)

@Serializable
private data class SkillWriteBody(@SerialName("expected_version") val expectedVersion: Int, @SerialName("request_id") val requestId: String, val config: SkillConfig)

@Serializable
private data class McpWriteBody(@SerialName("expected_version") val expectedVersion: Int, @SerialName("request_id") val requestId: String, val config: McpConfig)

@Serializable
private data class ConfigDeleteBody(@SerialName("expected_version") val expectedVersion: Int, @SerialName("request_id") val requestId: String)

class ApiException(val status: Int, message: String) : Exception(message)

class TagentApi(private val http: OkHttpClient, private val json: Json = API_JSON) {
    fun login(baseUrl: String, password: String): TokenResponse =
        post("$baseUrl/auth/login", null, LoginBody(password))

    fun devices(url: ServerUrl, token: String): List<DevicePublic> = get("${url.base}/devices", token)

    fun projects(url: ServerUrl, token: String): List<ProjectPublic> = get("${url.base}/projects", token)

    fun tasks(url: ServerUrl, token: String): List<TaskSummary> = get("${url.base}/tasks", token)

    fun task(url: ServerUrl, token: String, taskId: String): TaskDetail = get("${url.base}/tasks/$taskId", token)

    fun plan(url: ServerUrl, token: String, planId: String): PlanPublic = get("${url.base}/plans/$planId", token)

    fun createTask(url: ServerUrl, token: String, projectId: String, requirement: String, key: String): TaskDetail =
        post("${url.base}/tasks", token, TaskCreateBody(projectId, requirement, key))

    fun approve(url: ServerUrl, token: String, planId: String, version: Int, hash: String, key: String): ApprovalPublic =
        post("${url.base}/plans/$planId/approve", token, ApproveBody(version, hash, key))

    fun reject(url: ServerUrl, token: String, planId: String, key: String): TaskDetail =
        post("${url.base}/plans/$planId/reject", token, RejectBody(key))

    fun revise(url: ServerUrl, token: String, planId: String, feedback: String, key: String): TaskDetail =
        post("${url.base}/plans/$planId/revise", token, ReviseBody(feedback, key))

    fun cancel(url: ServerUrl, token: String, taskId: String): TaskDetail =
        post("${url.base}/tasks/$taskId/cancel", token, EmptyBody())

    fun events(url: ServerUrl, token: String, after: Long): EventPage =
        get("${url.base}/events?after=$after&limit=100", token)

    fun conversations(url: ServerUrl, token: String): List<ConversationPublic> = get("${url.base}/conversations", token)

    fun conversation(url: ServerUrl, token: String, conversationId: String): ConversationPublic =
        get("${url.base}/conversations/$conversationId", token)

    fun messages(url: ServerUrl, token: String, conversationId: String, after: Int): MessagePage =
        get("${url.base}/conversations/$conversationId/messages?after=$after&limit=200", token)

    fun sendMessage(url: ServerUrl, token: String, conversationId: String, text: String, requestId: String): ChatRunPublic =
        post("${url.base}/conversations/$conversationId/messages", token, SendMessageBody(text, requestId))

    fun sendPlan(url: ServerUrl, token: String, conversationId: String, text: String, requestId: String): PlanSendPublic =
        post("${url.base}/conversations/$conversationId/messages", token, SendMessageBody(text, requestId, "plan"))

    fun chatRun(url: ServerUrl, token: String, runId: String): ChatRunPublic = get("${url.base}/chat-runs/$runId", token)

    fun cancelChatRun(url: ServerUrl, token: String, runId: String): ChatRunPublic =
        post("${url.base}/chat-runs/$runId/cancel", token, EmptyBody())

    fun cloudModels(url: ServerUrl, token: String): List<CloudModelPublic> = get("${url.base}/cloud/models", token)

    fun createCloudConversation(url: ServerUrl, token: String, id: String, title: String, modelId: String): ConversationPublic =
        put("${url.base}/cloud/conversations/$id", token, CloudConversationBody(0, id, title, modelId))

    fun handoff(url: ServerUrl, token: String, id: String, sourceId: String, modelId: String, requestId: String): ConversationPublic =
        post("${url.base}/cloud/conversations/$id/handoff-from/$sourceId", token, HandoffBody(requestId, modelId))

    fun skills(url: ServerUrl, token: String): List<SkillPublic> = get("${url.base}/configs/skills", token)

    fun mcpServers(url: ServerUrl, token: String): List<McpServerPublic> = get("${url.base}/configs/mcp-servers", token)

    fun putSkill(url: ServerUrl, token: String, id: String, expectedVersion: Int, requestId: String, config: SkillConfig): SkillPublic =
        put("${url.base}/configs/skills/$id", token, SkillWriteBody(expectedVersion, requestId, config))

    fun putMcp(url: ServerUrl, token: String, id: String, expectedVersion: Int, requestId: String, config: McpConfig): McpServerPublic =
        put("${url.base}/configs/mcp-servers/$id", token, McpWriteBody(expectedVersion, requestId, config))

    /** [path] is "skills" or "mcp-servers". */
    fun deleteConfig(url: ServerUrl, token: String, path: String, id: String, expectedVersion: Int, requestId: String): JsonObject =
        post("${url.base}/configs/$path/$id/delete", token, ConfigDeleteBody(expectedVersion, requestId))

    private inline fun <reified T> get(url: String, token: String): T = execute(Request.Builder().url(url).header("Authorization", "Bearer $token").build())

    private inline fun <reified T, reified B> post(url: String, token: String?, body: B): T {
        val builder = Request.Builder().url(url).post(json.encodeToString(body).toRequestBody(JSON))
        if (token != null) builder.header("Authorization", "Bearer $token")
        return execute(builder.build())
    }

    private inline fun <reified T, reified B> put(url: String, token: String, body: B): T =
        execute(Request.Builder().url(url).put(json.encodeToString(body).toRequestBody(JSON)).header("Authorization", "Bearer $token").build())

    private inline fun <reified T> execute(request: Request): T {
        http.newCall(request).execute().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) throw ApiException(response.code, errorMessage(response.code, text))
            return json.decodeFromString(text)
        }
    }
}

fun errorMessage(status: Int, body: String): String {
    val detail = runCatching {
        val element = API_JSON.parseToJsonElement(body)
        if (element is JsonObject) {
            val value = element["detail"]
            if (value is JsonPrimitive) value.contentOrNull else null
        } else {
            null
        }
    }.getOrNull()
    return detail?.takeIf { it.isNotBlank() } ?: "请求失败（$status）"
}

private val JSON = "application/json".toMediaType()

val API_JSON: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
