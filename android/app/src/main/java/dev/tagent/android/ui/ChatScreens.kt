package dev.tagent.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.tagent.android.data.TagentRepository
import dev.tagent.android.data.api.CloudModelPublic
import dev.tagent.android.data.db.ChatRunEntity
import dev.tagent.android.data.db.ConversationListItem
import dev.tagent.android.data.db.MessageEntity
import dev.tagent.android.domain.ActionException
import dev.tagent.android.domain.TERMINAL_CHAT
import dev.tagent.android.domain.canCancelChat
import dev.tagent.android.domain.CLOUD_TARGET
import dev.tagent.android.domain.assistantLabel
import dev.tagent.android.domain.chatRunLabel
import dev.tagent.android.domain.conversationSourceLabel
import dev.tagent.android.domain.displayedTaskStatus
import dev.tagent.android.domain.messageStatusLabel
import dev.tagent.android.domain.planInProgress
import dev.tagent.android.domain.taskStatusLabel
import kotlinx.coroutines.launch

@Composable
fun ChatListScreen(repository: TagentRepository, onOpen: (String) -> Unit) {
    val conversations by repository.observeConversations().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var picking by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("聊天", style = MaterialTheme.typography.headlineMedium)
            TextButton(onClick = { scope.launch { runCatching { repository.catchUp() } } }) { Text("刷新") }
        }
        Text("Mac 共享会话的源码和工具日志留在 Mac；云端问答由服务器执行，Mac 关机也能用。", style = MaterialTheme.typography.bodyMedium)
        OutlinedButton(onClick = { notice = null; picking = true }, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text("新建云端会话") }
        notice?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (conversations.isEmpty()) {
            Text("还没有会话。在 Mac 上开启共享，或新建云端会话。", Modifier.padding(top = 24.dp))
        } else {
            LazyColumn {
                items(conversations, key = { it.id }) { conversation ->
                    ConversationRow(conversation, onClick = { onOpen(conversation.id) })
                    HorizontalDivider()
                }
            }
        }
    }
    if (picking) {
        CloudModelDialog(repository, title = "新建云端会话", confirm = "新建", onDismiss = { picking = false }) { modelId ->
            val id = repository.createCloudConversation(modelId)
            picking = false
            onOpen(id)
        }
    }
}

/** Lets the user pick a cloud model, then runs [action]; errors stay in the dialog. */
@Composable
private fun CloudModelDialog(repository: TagentRepository, title: String, confirm: String, onDismiss: () -> Unit, action: suspend (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var models by remember { mutableStateOf<List<CloudModelPublic>?>(null) }
    var selected by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        try {
            val list = repository.cloudModels()
            models = list
            selected = (list.firstOrNull { it.config.isDefault } ?: list.firstOrNull())?.id
        } catch (e: ActionException) {
            error = e.message
            models = emptyList()
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                when {
                    models == null -> Text("正在读取云端模型…")
                    models!!.isEmpty() && error == null -> Text("还没有可用模型。在 Mac 的设置里添加后，本机和云端都会使用它。")
                }
                models.orEmpty().forEach { m ->
                    val mark = if (m.id == selected) "● " else "○ "
                    Text(mark + m.config.name + " · " + m.config.modelId, Modifier.fillMaxWidth().clickable { selected = m.id }.padding(vertical = 8.dp))
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && selected != null, onClick = {
                val modelId = selected ?: return@TextButton
                busy = true
                error = null
                scope.launch {
                    try { action(modelId) } catch (e: ActionException) { error = e.message } finally { busy = false }
                }
            }) { Text(if (busy) "处理中" else confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun ConversationRow(conversation: ConversationListItem, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 14.dp)) {
        Text(conversation.title, style = MaterialTheme.typography.titleMedium)
        val project = conversation.projectName?.let { " · $it" }.orEmpty()
        val plan = conversation.taskStatus?.let { " · ${taskStatusLabel(displayedTaskStatus(it, conversation.presence ?: "offline"))}" }.orEmpty()
        val sharing = if (conversation.shared) "" else " · 已停止共享"
        Text(conversationSourceLabel(conversation.target, conversation.kind, conversation.deviceLabel, conversation.presence, conversation.handoffCount) + project + plan + sharing)
    }
}

@Composable
fun ChatScreen(repository: TagentRepository, conversationId: String, onBack: () -> Unit) {
    val model = viewModel(key = conversationId) { ChatViewModel(repository, conversationId) }
    DisposableEffect(conversationId) {
        repository.watchConversation(conversationId)
        onDispose { repository.unwatchConversation(conversationId) }
    }
    val conversation = model.conversation
    val active = model.run?.takeIf { it.state !in TERMINAL_CHAT }
    val target = conversation?.target ?: "mac"
    val projectChat = conversation?.kind == "read_code" && !conversation.projectId.isNullOrBlank() && target != CLOUD_TARGET
    val planning = planInProgress(conversation?.taskStatus)
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = onBack) { Text("返回") }
        Text(conversation?.title ?: "会话", style = MaterialTheme.typography.headlineSmall)
        conversation?.let {
            Text(conversationSourceLabel(it.target, it.kind, it.deviceLabel, it.presence, it.handoffCount))
            if (!it.shared) Text("已停止共享，不能继续提问")
        }
        model.run?.let { run ->
            Text(chatRunLabel(run.state, run.cancelRequested, conversation?.presence, target))
            if (canCancelChat(run.state) && !run.cancelRequested) {
                OutlinedButton(onClick = { model.cancel() }, enabled = !model.busy) { Text("取消") }
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            items(model.messages, key = { it.messageId }) { message -> MessageRow(message, assistantLabel(target)) }
            conversation?.taskId?.let { taskId ->
                item(key = "plan-$taskId") { ConversationPlan(repository, taskId) }
            }
        }
        Text(
            when {
                target == CLOUD_TARGET -> "云端助手可联网搜索（服务器已配置时），不能访问 Mac 上的项目和文件。"
                projectChat && model.mode == "plan" -> "先讨论方案，确认后执行。源码和 diff 留在 Mac。"
                else -> "源码、diff 和工具日志留在 Mac。这里只显示已同步的对话。"
            },
            style = MaterialTheme.typography.bodySmall,
        )
        model.notice?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (projectChat) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = model.mode == "read", onClick = { model.selectMode("read") }, label = { Text("提问") }, enabled = !model.locked)
                FilterChip(selected = model.mode == "plan", onClick = { model.selectMode("plan") }, label = { Text("计划") }, enabled = !model.locked)
            }
        }
        OutlinedTextField(
            model.text,
            { if (!model.locked) model.text = it },
            Modifier.fillMaxWidth(),
            label = { Text(if (projectChat && model.mode == "plan") "计划" else "继续提问") },
            minLines = 2,
            enabled = !model.locked && active == null && !planning && conversation?.shared != false,
        )
        Button(
            onClick = { model.send() },
            enabled = !model.busy && model.text.isNotBlank() && active == null && !planning && conversation?.shared != false,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (model.busy) "正在发送" else "发送") }
        if (model.canDiscard) TextButton(onClick = { model.discard() }) { Text("放弃这条草稿") }
    }
}

@Composable
private fun MessageRow(message: MessageEntity, assistant: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        val who = if (message.role == "user") "你" else assistant
        val status = messageStatusLabel(message.status)?.let { " · $it" }.orEmpty()
        Text("$who$status", style = MaterialTheme.typography.labelLarge)
        Text(message.content)
    }
}

@Composable
fun ProjectChatsScreen(repository: TagentRepository, projectId: String, onOpen: (String) -> Unit, onBack: () -> Unit) {
    val conversations by repository.observeConversations().collectAsState(initial = emptyList())
    val projects by repository.observeProjects().collectAsState(initial = emptyList())
    val project = projects.find { it.projectId == projectId }
    val rows = conversations.filter { it.projectId == projectId }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        TextButton(onClick = onBack) { Text("返回") }
        Text(project?.displayName ?: "项目", style = MaterialTheme.typography.headlineMedium)
        Text("在已有对话里继续提问。要改代码时，在输入框选「计划」。", style = MaterialTheme.typography.bodyMedium)
        if (rows.isEmpty()) {
            Text("还没有这个项目的对话。在 Mac 上打开该项目的对话后，会出现在这里。", Modifier.padding(top = 24.dp))
        } else {
            LazyColumn {
                items(rows, key = { it.id }) { conversation ->
                    ConversationRow(conversation, onClick = { onOpen(conversation.id) })
                    HorizontalDivider()
                }
            }
        }
    }
}

class ChatViewModel(private val repository: TagentRepository, private val conversationId: String) : ViewModel() {
    var conversation by mutableStateOf<ConversationListItem?>(null)
    var messages by mutableStateOf<List<MessageEntity>>(emptyList())
    var run by mutableStateOf<ChatRunEntity?>(null)
    var text by mutableStateOf("")
    var notice by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    var locked by mutableStateOf(false)
    var canDiscard by mutableStateOf(false)
    var mode by mutableStateOf("read")

    init {
        viewModelScope.launch { repository.observeConversation(conversationId).collect { conversation = it } }
        viewModelScope.launch { repository.observeMessages(conversationId).collect { messages = it } }
        viewModelScope.launch { repository.observeLatestChatRun(conversationId).collect { run = it } }
        viewModelScope.launch {
            val planBox = repository.peekOutbox(draftId("plan"))
            val chatBox = repository.peekOutbox(draftId("read"))
            val box = when {
                planBox != null && planBox.phase != "confirmed" && planBox.idempotencyKey != null -> {
                    mode = "plan"
                    planBox
                }
                chatBox != null && chatBox.phase != "confirmed" -> chatBox
                else -> null
            }
            if (box?.phase == "confirmed") {
                repository.clearOutbox(box.id)
            } else if (box != null) {
                text = box.body
                locked = box.idempotencyKey != null
                canDiscard = locked
                notice = box.error
            }
        }
    }

    fun selectMode(next: String) {
        if (locked || next == mode) return
        mode = next
    }

    fun send() {
        if (busy) return
        busy = true
        notice = null
        val sending = mode
        viewModelScope.launch {
            try {
                repository.sendQuestion(conversationId, text, sending)
                repository.clearOutbox(draftId(sending))
                text = ""
                locked = false
                canDiscard = false
            } catch (error: ActionException) {
                notice = error.message
                val box = repository.peekOutbox(draftId(sending))
                locked = box?.idempotencyKey != null
                canDiscard = locked
                if (!locked) repository.rememberDraft(draftId(sending), if (sending == "plan") "plan" else "chat", conversationId, text)
            } finally {
                busy = false
            }
        }
    }

    fun cancel() {
        val current = run ?: return
        if (busy || !canCancelChat(current.state)) return
        busy = true
        notice = null
        viewModelScope.launch {
            try {
                repository.cancelChat(current.runId)
            } catch (error: ActionException) {
                notice = error.message
            } finally {
                busy = false
            }
        }
    }

    fun discard() {
        viewModelScope.launch {
            repository.clearOutbox(draftId(mode))
            text = ""
            notice = null
            locked = false
            canDiscard = false
        }
    }

    override fun onCleared() {
        if (!locked && text.isNotBlank()) repository.rememberDraft(draftId(mode), if (mode == "plan") "plan" else "chat", conversationId, text)
    }

    private fun draftId(which: String) = if (which == "plan") "plan:$conversationId" else "chat:$conversationId"
}
