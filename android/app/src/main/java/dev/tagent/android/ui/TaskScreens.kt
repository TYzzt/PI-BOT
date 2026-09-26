package dev.tagent.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.tagent.android.data.TagentRepository
import dev.tagent.android.data.api.API_JSON
import dev.tagent.android.data.api.PlanBody
import dev.tagent.android.data.api.PlanQuestion
import dev.tagent.android.data.db.EventEntity
import dev.tagent.android.data.db.MetaEntity
import dev.tagent.android.data.db.OutboxEntity
import dev.tagent.android.data.db.PlanEntity
import dev.tagent.android.data.db.TaskEntity
import dev.tagent.android.domain.ActionException
import dev.tagent.android.domain.ApproveDecision
import dev.tagent.android.domain.cancelNote
import dev.tagent.android.domain.canRejectPlan
import dev.tagent.android.domain.canRequestCancel
import dev.tagent.android.domain.canRevisePlan
import dev.tagent.android.domain.decideApprove
import dev.tagent.android.domain.deviceOfflineNote
import dev.tagent.android.domain.displayedTaskStatus
import dev.tagent.android.domain.QuestionPick
import dev.tagent.android.domain.answersReady
import dev.tagent.android.domain.formatQuestionAnswers
import dev.tagent.android.domain.progressLines
import dev.tagent.android.domain.questionKey
import dev.tagent.android.domain.questionPrompt
import dev.tagent.android.domain.reviewBlockMessage
import dev.tagent.android.domain.showsApproved
import dev.tagent.android.domain.showsLocalOnly
import dev.tagent.android.domain.staleNote
import dev.tagent.android.domain.taskStatusLabel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch

@Composable
fun TaskListScreen(repository: TagentRepository, onOpen: (String) -> Unit) {
    val tasks by repository.observeTasks().collectAsState(initial = emptyList())
    val projects by repository.observeProjects().collectAsState(initial = emptyList())
    val names = projects.associate { it.projectId to it.displayName }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Text("任务", style = MaterialTheme.typography.headlineMedium)
        if (tasks.isEmpty()) {
            Text("还没有云端任务。从项目里提交一条需求。", Modifier.padding(top = 24.dp))
        } else {
            LazyColumn {
                items(tasks, key = { it.taskId }) { task ->
                    Column(Modifier.fillMaxWidth().clickable { onOpen(task.taskId) }.padding(vertical = 14.dp)) {
                        Text(names[task.projectId] ?: "项目", style = MaterialTheme.typography.labelLarge)
                        Text(task.requirement.lineSequence().firstOrNull().orEmpty(), style = MaterialTheme.typography.titleMedium)
                        Text(taskStatusLabel(displayedTaskStatus(task.status, task.devicePresence)))
                        cancelNote(task.status, task.cancelRequested)?.let { Text(it) }
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
fun TaskDetailScreen(repository: TagentRepository, taskId: String, onBack: () -> Unit) {
    val model = viewModel(key = taskId) { TaskDetailViewModel(repository, taskId) }
    val task = model.task
    val plan = model.plans.find { it.planId == model.selectedPlanId }
    val body = plan?.bodyOrNull()
    val questions = body?.questions?.filter { questionPrompt(it).isNotBlank() }.orEmpty()
    Column(Modifier.fillMaxSize()) {
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TextButton(onClick = onBack) { Text("返回") }
        if (task == null) {
            Text("正在读取本机缓存")
            return@Column
        }
        Text(taskStatusLabel(displayedTaskStatus(task.status, task.devicePresence)), style = MaterialTheme.typography.labelLarge)
        cancelNote(task.status, task.cancelRequested)?.let { Text(it) }
        deviceOfflineNote(task.devicePresence)?.let { Text(it) }
        staleNote(model.meta?.lastSyncAt, System.currentTimeMillis(), model.meta?.refreshFailed == true)?.let { Text(it) }
        Text("更新于 ${formatEpoch(model.meta?.lastSyncAt)}", style = MaterialTheme.typography.labelMedium)
        Text(task.requirement, style = MaterialTheme.typography.titleLarge)
        if (model.plans.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                model.plans.forEach { plan ->
                    FilterChip(
                        selected = plan.planId == model.selectedPlanId,
                        onClick = { model.select(plan.planId) },
                        label = { Text("v${plan.version}" + if (plan.planId == task.latestPlanId) " 最新" else " 历史") },
                    )
                }
            }
        }
        if (plan == null) {
            Text("计划还没发布。Mac 在线后会在这里出现。")
        } else if (body == null) {
            Text("正在读取计划正文")
        } else {
            PlanDocument(body)
            if (questions.isNotEmpty()) QuestionList(questions, model.picks, model::setPick)
        }
        val eventPairs = model.events.map { it.type to it.payloadJson }
        progressLines(eventPairs).forEach { line ->
            Text(line.title, style = MaterialTheme.typography.titleSmall)
            if (line.detail.isNotBlank()) Text(line.detail)
        }
        if (showsLocalOnly(eventPairs)) Text("代码详情在 Mac 查看，这里只有摘要。")
        model.notice?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (plan != null && body != null && questions.isEmpty()) {
            OutlinedTextField(model.feedback, { model.feedback = it }, Modifier.fillMaxWidth(), label = { Text("修改意见") }, minLines = 3)
            Button(onClick = { model.revise(plan) }, enabled = !model.busy && model.feedback.isNotBlank() && canRevisePlan(task.status, task.cancelRequested), modifier = Modifier.fillMaxWidth()) {
                Text(if (model.reviseBox?.phase == "submitting") "正在发送" else "要求修改")
            }
        }
        if (plan != null && body != null) {
            OutlinedButton(onClick = { model.reject(plan) }, enabled = !model.busy && !showsApproved(model.approve?.phase, task.status) && canRejectPlan(task.status), modifier = Modifier.fillMaxWidth()) { Text("拒绝") }
        }
    }
    if (task != null) TaskActionBar(model, task, plan, questions)
    }
}

@Composable
private fun PlanDocument(body: PlanBody) {
    Text(body.goal, style = MaterialTheme.typography.titleMedium)
    Section("范围", body.scope)
    Section("不包含", body.nonGoals)
    if (body.modules.isNotEmpty()) Text("影响模块：" + body.modules.joinToString("、"))
    Text("步骤", style = MaterialTheme.typography.titleSmall)
    body.steps.forEach { step ->
        Text(step.title, style = MaterialTheme.typography.bodyLarge)
        if (step.description.isNotBlank()) Text(step.description)
    }
    Section("验证", body.verification)
    Section("验收", body.acceptance)
}

@Composable
private fun QuestionList(questions: List<PlanQuestion>, picks: Map<String, QuestionPick>, onPick: (String, QuestionPick) -> Unit) {
    Text("需要你确认的问题", style = MaterialTheme.typography.titleMedium)
    questions.forEachIndexed { index, question ->
        val key = questionKey(question, index)
        val pick = picks[key] ?: QuestionPick()
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("${index + 1}. ${questionPrompt(question)}", style = MaterialTheme.typography.titleSmall)
            if (question is PlanQuestion.Choice) {
                question.choice.options.forEach { option ->
                    val selected = pick.optionIds.contains(option.id)
                    Row(Modifier.fillMaxWidth().clickable {
                        val next = if (question.choice.allowMultiple) {
                            if (selected) pick.optionIds - option.id else pick.optionIds + option.id
                        } else {
                            setOf(option.id)
                        }
                        onPick(key, pick.copy(optionIds = next))
                    }, verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        if (question.choice.allowMultiple) Checkbox(selected, onCheckedChange = null) else RadioButton(selected, onClick = null)
                        Text(option.label, Modifier.padding(start = 8.dp))
                    }
                }
            }
            OutlinedTextField(
                pick.other,
                { onPick(key, pick.copy(other = it)) },
                Modifier.fillMaxWidth(),
                label = { Text(if (question is PlanQuestion.Legacy) "回答" else "其他") },
                minLines = 1,
            )
        }
    }
}

@Composable
private fun TaskActionBar(model: TaskDetailViewModel, task: TaskEntity, plan: PlanEntity?, questions: List<PlanQuestion>) {
    val hasQuestions = questions.isNotEmpty()
    val latest = plan != null && task.latestPlanId == plan.planId && plan.supersededAt == null
    val decision = if (plan == null) null else decideApprove(
        online = model.online,
        taskStatus = task.status,
        cancelRequested = task.cancelRequested,
        isLatest = task.latestPlanId == plan.planId,
        superseded = plan.supersededAt != null,
        hasQuestions = hasQuestions,
        storedKey = model.approve?.idempotencyKey,
        storedPhase = model.approve?.phase,
        newKey = { "preview" },
    )
    val approved = showsApproved(model.approve?.phase, task.status)
    val ready = hasQuestions && answersReady(questions, model.picks)
    Surface(Modifier.fillMaxWidth(), tonalElevation = 3.dp) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (approved) Text("服务端已确认批准")
            if (decision is ApproveDecision.Blocked && !hasQuestions) Text(reviewBlockMessage(decision.reason))
            if (hasQuestions && !approved) Text("先提交选择。Mac 会生成新计划，之后才能确认执行。")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (hasQuestions) {
                    Button(
                        onClick = { if (plan != null) model.submitChoices(plan, questions) },
                        enabled = ready && latest && !model.busy && canRevisePlan(task.status, task.cancelRequested),
                        modifier = Modifier.weight(1f),
                    ) { Text(if (model.reviseBox?.phase == "submitting") "正在提交" else "提交选择") }
                } else {
                    Button(
                        onClick = { if (plan != null) model.approve(plan, false) },
                        enabled = decision is ApproveDecision.Send && !model.busy,
                        modifier = Modifier.weight(1f),
                    ) { Text(if (model.approve?.phase == "submitting") "正在提交" else "确认执行") }
                }
                if (canRequestCancel(task.status, task.cancelRequested)) {
                    OutlinedButton(onClick = { model.cancel() }, enabled = !model.busy, modifier = Modifier.weight(1f)) { Text("取消") }
                }
            }
        }
    }
}

@Composable
private fun Section(title: String, lines: List<String>) {
    if (lines.isEmpty()) return
    Text(title, style = MaterialTheme.typography.titleSmall)
    lines.forEach { Text(it) }
}

@OptIn(ExperimentalCoroutinesApi::class)
class TaskDetailViewModel(private val repository: TagentRepository, private val taskId: String) : ViewModel() {
    var task by mutableStateOf<TaskEntity?>(null)
    var plans by mutableStateOf<List<PlanEntity>>(emptyList())
    var events by mutableStateOf<List<EventEntity>>(emptyList())
    var meta by mutableStateOf<MetaEntity?>(null)
    var selectedPlanId by mutableStateOf<String?>(null)
    var feedback by mutableStateOf("")
    var notice by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    var online by mutableStateOf(repository.isOnline())
    var approve by mutableStateOf<OutboxEntity?>(null)
    var reviseBox by mutableStateOf<OutboxEntity?>(null)
    var picks by mutableStateOf<Map<String, QuestionPick>>(emptyMap())

    init {
        viewModelScope.launch { repository.observeTask(taskId).collect { task = it; if (selectedPlanId == null) selectedPlanId = it?.latestPlanId } }
        viewModelScope.launch { repository.observePlans(taskId).collect { plans = it } }
        viewModelScope.launch { repository.observeEvents(taskId).collect { events = it } }
        viewModelScope.launch { repository.observeMeta().collect { meta = it } }
        viewModelScope.launch {
            androidx.compose.runtime.snapshotFlow { selectedPlanId }.collect { id ->
                online = repository.isOnline()
                if (id == null) return@collect
                runCatching { repository.ensurePlan(id) }
                val draft = repository.peekOutbox("revise:$id")
                if (feedback.isBlank() && draft != null) feedback = draft.body
            }
        }
        viewModelScope.launch {
            androidx.compose.runtime.snapshotFlow { selectedPlanId }.flatMapLatest { id ->
                if (id == null) flowOf(null) else repository.observeOutbox("approve:$id")
            }.collect { approve = it }
        }
        viewModelScope.launch {
            androidx.compose.runtime.snapshotFlow { selectedPlanId }.flatMapLatest { id ->
                if (id == null) flowOf(null) else repository.observeOutbox("revise:$id")
            }.collect { reviseBox = it }
        }
    }

    fun select(planId: String) {
        val previous = selectedPlanId
        if (previous != null && previous != planId) repository.rememberDraft("revise:$previous", "revise", previous, feedback)
        selectedPlanId = planId
        feedback = ""
        picks = emptyMap()
    }

    fun setPick(key: String, pick: QuestionPick) {
        picks = picks + (key to pick)
    }

    fun submitChoices(plan: PlanEntity, questions: List<PlanQuestion>) {
        if (!answersReady(questions, picks)) return
        act { repository.revise(plan, formatQuestionAnswers(questions, picks)); picks = emptyMap() }
    }

    fun approve(plan: PlanEntity, hasQuestions: Boolean) {
        val current = task ?: return
        act { repository.approve(current, plan, hasQuestions) }
    }

    fun revise(plan: PlanEntity) = act { repository.revise(plan, feedback) }

    fun reject(plan: PlanEntity) {
        val current = task ?: return
        act { repository.reject(current, plan) }
    }

    fun cancel() = act { repository.cancel(taskId) }

    private fun act(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        notice = null
        online = repository.isOnline()
        viewModelScope.launch {
            try {
                block()
            } catch (error: ActionException) {
                notice = error.message
            } finally {
                busy = false
                online = repository.isOnline()
            }
        }
    }

    override fun onCleared() {
        val planId = selectedPlanId ?: return
        repository.rememberDraft("revise:$planId", "revise", planId, feedback)
    }
}

private fun PlanEntity.bodyOrNull(): PlanBody? =
    bodyJson?.let { runCatching { API_JSON.decodeFromString(PlanBody.serializer(), it) }.getOrNull() }
