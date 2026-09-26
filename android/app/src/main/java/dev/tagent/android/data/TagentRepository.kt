package dev.tagent.android.data

import dev.tagent.android.data.api.API_JSON
import dev.tagent.android.data.api.ApiException
import dev.tagent.android.data.api.ChatRunPublic
import dev.tagent.android.data.api.CloudModelPublic
import dev.tagent.android.data.api.ConversationPublic
import dev.tagent.android.data.api.DevicePublic
import dev.tagent.android.data.api.EventPublic
import dev.tagent.android.data.api.MessagePublic
import dev.tagent.android.data.api.PlanPublic
import dev.tagent.android.data.api.PlanSummary
import dev.tagent.android.data.api.ProjectPublic
import dev.tagent.android.data.api.TagentApi
import dev.tagent.android.data.api.TaskDetail
import dev.tagent.android.data.api.TaskSummary
import dev.tagent.android.data.api.WsEnvelope
import dev.tagent.android.data.api.WsSubscribe
import dev.tagent.android.data.db.ChatRunEntity
import dev.tagent.android.data.db.ConversationEntity
import dev.tagent.android.data.db.DeviceEntity
import dev.tagent.android.data.db.EventEntity
import dev.tagent.android.data.db.MessageEntity
import dev.tagent.android.data.db.MetaEntity
import dev.tagent.android.data.db.OutboxEntity
import dev.tagent.android.data.db.PlanEntity
import dev.tagent.android.data.db.ProjectEntity
import dev.tagent.android.data.db.TagentDao
import dev.tagent.android.data.db.TagentDatabase
import dev.tagent.android.data.db.TaskEntity
import dev.tagent.android.domain.ActionException
import dev.tagent.android.domain.ApproveDecision
import dev.tagent.android.domain.QuestionDecision
import dev.tagent.android.domain.ReviewBlock
import dev.tagent.android.domain.SendDecision
import dev.tagent.android.domain.ServerUrl
import dev.tagent.android.domain.StoredAttempt
import dev.tagent.android.domain.TERMINAL_CHAT
import dev.tagent.android.domain.decideApprove
import dev.tagent.android.domain.decideQuestion
import dev.tagent.android.domain.decideSend
import dev.tagent.android.domain.newIdempotencyKey
import dev.tagent.android.domain.parseServerUrl
import dev.tagent.android.domain.questionBlockMessage
import dev.tagent.android.domain.reviewBlockMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.UUID

class TagentRepository(
    private val database: TagentDatabase,
    private val session: SessionStore,
    private val api: TagentApi,
    private val http: OkHttpClient,
    private val online: () -> Boolean,
    private val allowCleartext: Boolean,
    private val scope: CoroutineScope,
) {
    private val dao: TagentDao = database.dao()
    private val mutex = Mutex()
    private var syncJob: Job? = null
    private var socket: WebSocket? = null
    @Volatile private var openConversationId: String? = null

    val loggedIn: StateFlow<Boolean> = session.loggedIn
    val baseUrl: Flow<String> = session.baseUrl

    fun isOnline(): Boolean = online()

    fun observeProjects() = dao.observeProjects()
    fun observeTasks() = dao.observeTasks()
    fun observeTask(taskId: String) = dao.observeTask(taskId)
    fun observePlans(taskId: String) = dao.observePlans(taskId)
    fun observeEvents(taskId: String) = dao.observeEvents(taskId)
    fun observeMeta() = dao.observeMeta()
    fun observeOutbox(id: String) = dao.observeOutbox(id)
    fun observeConversations() = dao.observeConversations()
    fun observeConversation(conversationId: String) = dao.observeConversation(conversationId)
    fun observeMessages(conversationId: String) = dao.observeMessages(conversationId)
    fun observeLatestChatRun(conversationId: String) = dao.observeLatestChatRun(conversationId)

    suspend fun peekOutbox(id: String): OutboxEntity? = dao.outbox(id)

    suspend fun login(rawUrl: String, password: String) {
        val url = parseServerUrl(rawUrl, allowCleartext)
        session.setBaseUrl(url.base)
        val token = withContext(Dispatchers.IO) { api.login(url.base, password) }
        session.saveToken(token.accessToken, token.expiresIn)
        startForegroundSync()
    }

    fun logout() {
        stopForegroundSync()
        session.clearToken()
    }

    fun startForegroundSync() {
        syncJob?.cancel()
        syncJob = scope.launch {
            runCatching { catchUp() }
            if (isActive) connectSocket()
        }
    }

    fun stopForegroundSync() {
        syncJob?.cancel()
        socket?.close(1000, "background")
        socket = null
    }

    suspend fun catchUp() {
        mutex.withLock {
            val url = session.currentUrl(allowCleartext) ?: return
            val token = session.token() ?: return
            try {
                val devices = withContext(Dispatchers.IO) { api.devices(url, token) }
                val projects = withContext(Dispatchers.IO) { api.projects(url, token) }
                val tasks = withContext(Dispatchers.IO) { api.tasks(url, token) }
                val conversations = withContext(Dispatchers.IO) { api.conversations(url, token) }
                dao.replaceDirectory(devices.map { it.toEntity() }, projects.map { it.toEntity() }, tasks.map { it.toEntity() })
                dao.replaceConversations(conversations.map { it.toEntity() })
                val open = openConversationId
                if (open != null && conversations.any { it.id == open }) loadMessages(url, token, open)
                var after = dao.meta()?.cursor ?: 0
                while (true) {
                    val page = withContext(Dispatchers.IO) { api.events(url, token, after) }
                    if (page.events.isNotEmpty()) dao.insertEvents(page.events.map { it.toEntity() })
                    val next = maxOf(after, page.nextCursor)
                    if (!page.hasMore || next == after) {
                        after = next
                        break
                    }
                    after = next
                }
                val previous = dao.meta()
                dao.upsertMeta(MetaEntity(cursor = after, lastSyncAt = System.currentTimeMillis(), refreshFailed = false).let {
                    if (previous == null) it else it.copy(cursor = after)
                })
            } catch (error: ApiException) {
                if (error.status == 401) session.clearToken()
                markFailed()
                throw error
            } catch (error: IOException) {
                markFailed()
                throw error
            }
        }
    }

    suspend fun createTask(projectId: String, text: String): String {
        val id = "create:$projectId"
        when (val decision = prepareSend(id, "create", projectId, text)) {
            is SendDecision.AlreadyConfirmed -> return decision.resultId
            is SendDecision.Conflict -> throw ActionException(decision.message)
            is SendDecision.Blocked -> throw ActionException(reviewBlockMessage(decision.reason))
            is SendDecision.Send -> {
                try {
                    val detail = withContext(Dispatchers.IO) {
                        api.createTask(requireUrl(), requireToken(), projectId, decision.body, decision.key)
                    }
                    saveDetail(detail)
                    confirm(id, detail.taskId)
                    return detail.taskId
                } catch (error: Exception) {
                    fail(id, error)
                    throw asAction(error, "网络中断，未创建任务")
                }
            }
        }
    }

    suspend fun approve(task: TaskEntity, plan: PlanEntity, hasQuestions: Boolean) {
        val id = "approve:${plan.planId}"
        val stored = dao.outbox(id)
        val decision = decideApprove(
            online = online(),
            taskStatus = task.status,
            cancelRequested = task.cancelRequested,
            isLatest = task.latestPlanId == plan.planId,
            superseded = plan.supersededAt != null,
            hasQuestions = hasQuestions,
            storedKey = stored?.idempotencyKey,
            storedPhase = stored?.phase,
            newKey = ::newIdempotencyKey,
        )
        when (decision) {
            ApproveDecision.Confirmed -> return
            is ApproveDecision.Blocked -> throw ActionException(reviewBlockMessage(decision.reason))
            is ApproveDecision.Send -> {
                dao.upsertOutbox(OutboxEntity(id, "approve", plan.planId, decision.key, plan.contentHash, "submitting", null, null))
                try {
                    withContext(Dispatchers.IO) {
                        api.approve(requireUrl(), requireToken(), plan.planId, plan.version, plan.contentHash, decision.key)
                    }
                    confirm(id, plan.planId)
                    refreshTask(task.taskId)
                } catch (error: Exception) {
                    fail(id, error)
                    throw asAction(error, "网络中断，未批准")
                }
            }
        }
    }

    suspend fun reject(task: TaskEntity, plan: PlanEntity) {
        val id = "reject:${plan.planId}"
        when (val decision = prepareSend(id, "reject", plan.planId, "reject")) {
            is SendDecision.AlreadyConfirmed -> return
            is SendDecision.Conflict -> throw ActionException(decision.message)
            is SendDecision.Blocked -> throw ActionException(reviewBlockMessage(decision.reason))
            is SendDecision.Send -> {
                try {
                    val detail = withContext(Dispatchers.IO) { api.reject(requireUrl(), requireToken(), plan.planId, decision.key) }
                    saveDetail(detail)
                    confirm(id, detail.taskId)
                } catch (error: Exception) {
                    fail(id, error)
                    throw asAction(error, "网络中断，未拒绝")
                }
            }
        }
    }

    suspend fun revise(plan: PlanEntity, feedback: String) {
        val id = "revise:${plan.planId}"
        when (val decision = prepareSend(id, "revise", plan.planId, feedback)) {
            is SendDecision.AlreadyConfirmed -> return
            is SendDecision.Conflict -> throw ActionException(decision.message)
            is SendDecision.Blocked -> throw ActionException(reviewBlockMessage(decision.reason))
            is SendDecision.Send -> {
                try {
                    val detail = withContext(Dispatchers.IO) {
                        api.revise(requireUrl(), requireToken(), plan.planId, decision.body, decision.key)
                    }
                    saveDetail(detail)
                    confirm(id, detail.taskId)
                } catch (error: Exception) {
                    fail(id, error)
                    throw asAction(error, "网络中断，修改意见未发送")
                }
            }
        }
    }

    suspend fun cancel(taskId: String) {
        if (!online()) throw ActionException(reviewBlockMessage(ReviewBlock.Offline))
        val id = "cancel:$taskId"
        val existing = dao.outbox(id)
        dao.upsertOutbox(OutboxEntity(id, "cancel", taskId, existing?.idempotencyKey ?: newIdempotencyKey(), "", "submitting", null, null))
        try {
            val detail = withContext(Dispatchers.IO) { api.cancel(requireUrl(), requireToken(), taskId) }
            saveDetail(detail)
            confirm(id, detail.taskId)
        } catch (error: Exception) {
            fail(id, error)
            throw asAction(error, "网络中断，取消未送达")
        }
    }

    fun watchConversation(conversationId: String) {
        openConversationId = conversationId
        scope.launch { runCatching { refreshConversation(conversationId) } }
    }

    fun unwatchConversation(conversationId: String) {
        if (openConversationId == conversationId) openConversationId = null
    }

    suspend fun refreshConversation(conversationId: String) {
        mutex.withLock {
            val url = session.currentUrl(allowCleartext) ?: return
            val token = session.token() ?: return
            loadMessages(url, token, conversationId)
        }
    }

    suspend fun sendQuestion(conversationId: String, text: String): String {
        val active = dao.activeChatRun(conversationId)
        val shared = dao.conversationShared(conversationId) != false
        when (val gate = decideQuestion(online(), active?.state, shared, text)) {
            is QuestionDecision.Blocked -> throw ActionException(questionBlockMessage(gate.reason))
            QuestionDecision.Send -> Unit
        }
        val id = "chat:$conversationId"
        when (val decision = prepareSend(id, "chat", conversationId, text)) {
            is SendDecision.AlreadyConfirmed -> return decision.resultId
            is SendDecision.Conflict -> throw ActionException(decision.message)
            is SendDecision.Blocked -> throw ActionException(reviewBlockMessage(decision.reason))
            is SendDecision.Send -> {
                try {
                    val run = withContext(Dispatchers.IO) {
                        api.sendMessage(requireUrl(), requireToken(), conversationId, decision.body, decision.key)
                    }
                    dao.upsertChatRun(run.toEntity(System.currentTimeMillis()))
                    dao.upsertMessages(listOf(run.toPendingMessage(decision.body)))
                    confirm(id, run.id)
                    runCatching { refreshConversation(conversationId) }
                    return run.id
                } catch (error: Exception) {
                    fail(id, error)
                    throw asAction(error, "网络中断，问题未提交")
                }
            }
        }
    }

    suspend fun cloudModels(): List<CloudModelPublic> {
        if (!online()) throw ActionException("需要连接云端后才能读取云端模型")
        try {
            return withContext(Dispatchers.IO) { api.cloudModels(requireUrl(), requireToken()) }.filter { !it.deleted }
        } catch (error: Exception) {
            throw asAction(error, "网络中断，未读取到云端模型")
        }
    }

    /** Creates a cloud conversation and returns its id; Mac presence does not matter. */
    suspend fun createCloudConversation(modelId: String): String {
        if (!online()) throw ActionException("需要连接云端后才能新建云端会话")
        val id = UUID.randomUUID().toString()
        try {
            val created = withContext(Dispatchers.IO) { api.createCloudConversation(requireUrl(), requireToken(), id, "云端问答", modelId) }
            dao.upsertConversations(listOf(created.toEntity()))
            return created.id
        } catch (error: Exception) {
            throw asAction(error, "网络中断，云端会话未创建")
        }
    }

    /** Starts a cloud conversation seeded with the shared history of a Mac conversation; the source is untouched. */
    suspend fun handoffToCloud(conversationId: String, modelId: String): String {
        if (!online()) throw ActionException("需要连接云端后才能转到云端")
        val id = UUID.randomUUID().toString()
        try {
            val created = withContext(Dispatchers.IO) { api.handoff(requireUrl(), requireToken(), id, conversationId, modelId, UUID.randomUUID().toString()) }
            dao.upsertConversations(listOf(created.toEntity()))
            return created.id
        } catch (error: Exception) {
            throw asAction(error, "网络中断，未能转到云端")
        }
    }

    suspend fun cancelChat(runId: String) {
        if (!online()) throw ActionException("网络中断，取消未送达")
        try {
            val run = withContext(Dispatchers.IO) { api.cancelChatRun(requireUrl(), requireToken(), runId) }
            dao.upsertChatRun(run.toEntity(System.currentTimeMillis()))
            runCatching { refreshConversation(run.conversationId) }
        } catch (error: Exception) {
            throw asAction(error, "网络中断，取消未送达")
        }
    }

    fun rememberDraft(id: String, kind: String, targetId: String, text: String) {
        scope.launch {
            val current = dao.outbox(id)
            if (current?.idempotencyKey != null || current?.phase == "confirmed") return@launch
            dao.upsertOutbox(OutboxEntity(id, kind, targetId, null, text, "draft", current?.error, null))
        }
    }

    suspend fun clearOutbox(id: String) {
        val current = dao.outbox(id) ?: return
        if (current.phase == "submitting") return
        dao.deleteOutbox(id)
    }

    suspend fun ensurePlan(planId: String) {
        if (dao.plan(planId)?.bodyJson != null) return
        val plan = withContext(Dispatchers.IO) { api.plan(requireUrl(), requireToken(), planId) }
        savePlan(plan)
    }

    private suspend fun refreshShared(event: EventPublic) {
        mutex.withLock {
            val url = session.currentUrl(allowCleartext) ?: return
            val token = session.token() ?: return
            val conversations = withContext(Dispatchers.IO) { api.conversations(url, token) }
            dao.replaceConversations(conversations.map { it.toEntity() })
            val open = openConversationId
            if (open != null) loadMessages(url, token, open)
            if (event.type == "chat_run.changed") {
                val runId = event.payload.stringField("id")
                if (runId != null) {
                    val run = withContext(Dispatchers.IO) { api.chatRun(url, token, runId) }
                    dao.upsertChatRun(run.toEntity(System.currentTimeMillis()))
                }
            }
        }
    }

    private suspend fun loadMessages(url: ServerUrl, token: String, conversationId: String) {
        var after = 0
        val collected = mutableListOf<MessagePublic>()
        var pending = emptyList<MessagePublic>()
        while (true) {
            val page = withContext(Dispatchers.IO) { api.messages(url, token, conversationId, after) }
            collected += page.messages
            pending = page.pendingMessages
            if (!page.hasMore || page.nextCursor <= after) break
            after = page.nextCursor
        }
        val byId = linkedMapOf<String, MessagePublic>()
        (collected + pending).forEach { message ->
            val previous = byId[message.id]
            if (previous == null || message.sequence > previous.sequence || (message.sequence == previous.sequence && message.version >= previous.version)) {
                byId[message.id] = message
            }
        }
        dao.replaceMessages(conversationId, byId.values.map { it.toEntity() })
        val now = System.currentTimeMillis()
        val runIds = buildSet {
            addAll(pending.map { it.runId })
            addAll(collected.filter { it.status !in TERMINAL_CHAT }.map { it.runId })
            addAll(dao.activeChatRunIds(conversationId))
        }
        runIds.forEach { runId ->
            val run = withContext(Dispatchers.IO) { api.chatRun(url, token, runId) }
            dao.upsertChatRun(run.toEntity(now))
        }
    }

    private suspend fun refreshTask(taskId: String) {
        val detail = withContext(Dispatchers.IO) { api.task(requireUrl(), requireToken(), taskId) }
        saveDetail(detail)
        val latest = detail.latestPlanId
        if (latest != null && dao.plan(latest)?.bodyJson == null) {
            savePlan(withContext(Dispatchers.IO) { api.plan(requireUrl(), requireToken(), latest) })
        }
    }

    private suspend fun connectSocket() {
        val url = session.currentUrl(allowCleartext) ?: return
        val token = session.token() ?: return
        val cursor = dao.meta()?.cursor ?: 0
        socket?.close(1000, "reconnect")
        val request = Request.Builder().url(url.eventsSocket).header("Authorization", "Bearer $token").build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(API_JSON.encodeToString(WsSubscribe(after = cursor)))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { ingest(text) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scope.launch { markFailed() }
            }
        })
    }

    private suspend fun ingest(text: String) {
        val event = runCatching { API_JSON.decodeFromString(WsEnvelope.serializer(), text) }.getOrNull()?.event ?: return
        mutex.withLock {
            dao.insertEvents(listOf(event.toEntity()))
            val current = dao.meta() ?: MetaEntity()
            dao.upsertMeta(current.copy(cursor = maxOf(current.cursor, event.serverCursor), lastSyncAt = System.currentTimeMillis(), refreshFailed = false))
        }
        val taskId = event.taskId
        if (taskId != null) runCatching { refreshTask(taskId) }
        if (event.type in SHARED_CHANGE_TYPES) runCatching { refreshShared(event) }
    }

    private suspend fun prepareSend(id: String, kind: String, targetId: String, text: String): SendDecision {
        val stored = dao.outbox(id)?.toAttempt()
        val decision = decideSend(online(), stored, text, ::newIdempotencyKey)
        when (decision) {
            is SendDecision.Send -> dao.upsertOutbox(OutboxEntity(id, kind, targetId, decision.key, decision.body, "submitting", null, stored?.resultId))
            is SendDecision.Blocked -> {
                if (stored?.idempotencyKey == null) {
                    dao.upsertOutbox(OutboxEntity(id, kind, targetId, null, text.trim(), "draft", reviewBlockMessage(decision.reason), null))
                }
            }
            is SendDecision.Conflict -> {
                val current = dao.outbox(id)
                if (current != null) dao.upsertOutbox(current.copy(error = decision.message))
            }
            is SendDecision.AlreadyConfirmed -> Unit
        }
        return decision
    }

    private suspend fun confirm(id: String, resultId: String) {
        val current = dao.outbox(id) ?: return
        dao.upsertOutbox(current.copy(phase = "confirmed", error = null, resultId = resultId))
    }

    private suspend fun fail(id: String, error: Exception) {
        val current = dao.outbox(id) ?: return
        dao.upsertOutbox(current.copy(phase = "failed", error = actionText(error, "网络中断，未完成提交")))
    }

    private suspend fun saveDetail(detail: TaskDetail) {
        dao.upsertTask(detail.toEntity())
        detail.plans.forEach { summary ->
            dao.insertPlanIgnore(summary.toEntity(detail.taskId))
            dao.updatePlanMeta(summary.planId, detail.taskId, summary.version, summary.contentHash, summary.createdAt, summary.supersededAt)
        }
    }

    private suspend fun savePlan(plan: PlanPublic) {
        dao.insertPlanIgnore(plan.toEntity())
        dao.updatePlanMeta(plan.planId, plan.taskId, plan.version, plan.contentHash, plan.createdAt, plan.supersededAt)
        dao.updatePlanBody(plan.planId, API_JSON.encodeToString(plan.body))
    }

    private suspend fun markFailed() {
        val current = dao.meta() ?: MetaEntity()
        dao.upsertMeta(current.copy(refreshFailed = true))
    }

    private suspend fun requireUrl() = session.currentUrl(allowCleartext) ?: throw ActionException("请先登录")

    private fun requireToken(): String {
        session.token()?.let { return it }
        session.clearToken()
        throw ActionException("登录已过期，请重新登录")
    }
}

private fun OutboxEntity.toAttempt() = StoredAttempt(idempotencyKey, body, phase == "confirmed", resultId)

private fun DevicePublic.toEntity() = DeviceEntity(deviceId, label, presence, lastSeenAt, revokedAt)

private fun ProjectPublic.toEntity() = ProjectEntity(projectId, deviceId, displayName, availability, updatedAt)

private fun TaskSummary.toEntity() = TaskEntity(
    taskId, projectId, targetDeviceId, requirement, status, cancelRequested, cancelRequestedAt, latestPlanId, devicePresence, createdAt, updatedAt,
)

private fun TaskDetail.toEntity() = TaskEntity(
    taskId, projectId, targetDeviceId, requirement, status, cancelRequested, cancelRequestedAt, latestPlanId, devicePresence, createdAt, updatedAt,
)

private fun PlanSummary.toEntity(taskId: String) = PlanEntity(planId, taskId, version, contentHash, createdAt, supersededAt, null)

private fun PlanPublic.toEntity() = PlanEntity(planId, taskId, version, contentHash, createdAt, supersededAt, null)

private fun EventPublic.toEntity() = EventEntity(eventId, serverCursor, type, taskId, occurredAt, payload.toString())

private fun ConversationPublic.toEntity() = ConversationEntity(
    id, deviceId.orEmpty(), version, title, kind, modelConfigId, projectId, taskId, shared, shareVersion, deleted,
    target = target, handoffCount = handoff?.messageCount ?: 0,
)

private fun MessagePublic.toEntity() = MessageEntity(
    id, conversationId, deviceId.orEmpty(), version, runId, role, content, status, sequence,
)

private fun ChatRunPublic.toPendingMessage(text: String) = MessageEntity(
    messageId, conversationId, deviceId.orEmpty(), version = 0, runId = id, role = "user", content = text, status = "queued", sequence = 0,
)

private fun ChatRunPublic.toEntity(seenAt: Long) = ChatRunEntity(
    id, conversationId, deviceId.orEmpty(), version, messageId, text, state, shareVersion, acked, cancelRequested, localRunId, seenAt,
)

private fun JsonObject.stringField(name: String): String? {
    val value = this[name]
    return if (value is JsonPrimitive) value.contentOrNull else null
}

private val SHARED_CHANGE_TYPES = setOf("conversation.changed", "message.changed", "chat_run.changed")

private fun asAction(error: Exception, offline: String): Exception = when (error) {
    is ActionException -> error
    is ApiException -> ActionException(error.message ?: "请求失败")
    is IOException -> ActionException(offline)
    else -> ActionException(error.message ?: offline)
}

private fun actionText(error: Exception, offline: String): String = asAction(error, offline).message ?: offline
