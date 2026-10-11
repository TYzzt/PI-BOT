package dev.pibot.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pibot.android.data.Approval
import dev.pibot.android.data.Bot
import dev.pibot.android.data.Message
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.data.ToolEntry
import dev.pibot.android.domain.Timeline
import dev.pibot.android.domain.mood
import dev.pibot.android.domain.toolLabel
import dev.pibot.android.face.PiBotFace
import dev.pibot.android.face.seedOf
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimelineScreen(repository: PiBotRepository, botId: String, onBack: () -> Unit, onEdit: () -> Unit, onFiles: () -> Unit) {
    val bot by repository.bot(botId).collectAsStateWithLifecycle(null)
    val timeline by repository.timeline(botId).collectAsStateWithLifecycle(Timeline())
    val mac by repository.mac.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    var loadingMore by remember { mutableStateOf(false) }
    val now = rememberNow()

    LaunchedEffect(botId) {
        runCatching { repository.refreshBot(botId); repository.loadTail(botId) }.onFailure { error = errorText(it) }
    }
    val current = bot
    if (current == null) {
        Box(Modifier.fillMaxSize().background(Paper))
        return
    }
    val run = current.latestRun
    val active = run?.active == true
    val mood = current.mood(now, timeline.runningTool)

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        PiBotFace(current.avatar, mood, 44.dp, seed = seedOf(current.id))
                        Spacer(Modifier.size(8.dp))
                        Column {
                            Text(current.name, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                if (mac.online) "在 Mac 上工作 · ~/pi-bot/${current.slug}" else "Mac 离线 · 在云端回复",
                                fontSize = 12.sp, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                actions = {
                    TextButton(onClick = onFiles, enabled = mac.online) { Text("资料库") }
                    IconButton(onClick = onEdit) { Icon(Icons.Filled.Edit, "编辑") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Paper),
            )
        },
        containerColor = Paper,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            val list = rememberLazyListState()
            val reversed = remember(timeline.messages) { timeline.messages.asReversed() }
            val atTop by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index == list.layoutInfo.totalItemsCount - 1 } }
            LaunchedEffect(atTop, timeline.hasMore) {
                if (atTop && timeline.hasMore && !loadingMore) {
                    loadingMore = true
                    runCatching { repository.loadMore(botId) }.onFailure { error = errorText(it) }
                    loadingMore = false
                }
            }
            LazyColumn(
                state = list,
                reverseLayout = true,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(current.pendingApprovals, key = { "approval-${it.id}" }) { approval ->
                    ApprovalCard(approval) { approve ->
                        scope.launch { runCatching { repository.decide(approval, approve) }.onFailure { error = errorText(it) } }
                    }
                }
                items(reversed, key = { it.id }) { message -> MessageItem(message) }
                if (timeline.loaded && timeline.messages.isEmpty()) {
                    item { Intro(current) }
                }
            }
            error?.let {
                Text(it, color = Danger, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            Composer(
                botName = current.name,
                active = active,
                onSend = { text ->
                    error = null
                    scope.launch { runCatching { repository.send(botId, text) }.onFailure { error = errorText(it) } }
                },
                onStop = { run?.let { r -> scope.launch { runCatching { repository.cancel(botId, r.id) }.onFailure { error = errorText(it) } } } },
            )
        }
    }
}

@Composable
private fun Intro(bot: Bot) {
    Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("和 ${bot.name} 打个招呼", fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(4.dp))
        Text(bot.persona.ifBlank { "它会记住你们的对话。" }, color = Muted, fontSize = 13.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun MessageItem(message: Message) {
    val user = message.role == "user"
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
        if (!user && message.tools.isNotEmpty()) {
            ToolChips(message.tools)
            Spacer(Modifier.height(6.dp))
        }
        val bubble = Modifier
            .widthIn(max = 320.dp)
            .background(if (user) Ink else Card, RoundedCornerShape(18.dp))
            .padding(horizontal = 14.dp, vertical = 10.dp)
        Box(bubble) {
            when {
                user -> Text(message.content, color = Color.White, lineHeight = 21.sp)
                message.content.isBlank() && message.status == "running" -> Text("…", color = Muted)
                message.content.isBlank() && message.status == "cancelled" -> Text("已停止", color = Muted)
                else -> MarkdownText(message.content)
            }
        }
        Spacer(Modifier.height(3.dp))
        val note = when (message.status) {
            "failed" -> "失败"
            "cancelled" -> "已停止"
            else -> if (!user && message.executor == "cloud") "云端" else null
        }
        Text(listOfNotNull(dayLabel(message.createdAt) + " " + clockTime(message.createdAt), note).joinToString(" · "), fontSize = 11.sp, color = if (message.status == "failed") Danger else Muted)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ToolChips(tools: List<ToolEntry>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.widthIn(max = 340.dp)) {
        for (tool in tools) {
            val dot = when (tool.state) {
                "running" -> Accent
                "failed" -> Danger
                else -> Good
            }
            Row(
                Modifier.background(Color(0xFFEFEBE5), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(6.dp).background(dot, CircleShape))
                Spacer(Modifier.size(6.dp))
                Text(toolLabel(tool.name), fontSize = 12.sp)
                tool.summary?.takeIf { it.isNotBlank() }?.let {
                    Spacer(Modifier.size(6.dp))
                    Text(it, fontSize = 11.sp, color = Muted, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 180.dp))
                }
            }
        }
    }
}

@Composable
private fun ApprovalCard(approval: Approval, onDecide: (Boolean) -> Unit) {
    var deciding by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().background(AccentSoft, RoundedCornerShape(18.dp)).padding(14.dp),
    ) {
        Text("想访问资料库以外的位置", fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Text(approval.path, fontFamily = FontFamily.Monospace, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().background(Card, RoundedCornerShape(8.dp)).padding(8.dp))
        if (approval.reason.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(approval.reason, color = Ink.copy(alpha = 0.8f))
        }
        Spacer(Modifier.height(10.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            OutlinedButton(onClick = { deciding = true; onDecide(false) }, enabled = !deciding) { Text("拒绝") }
            Spacer(Modifier.size(8.dp))
            Button(onClick = { deciding = true; onDecide(true) }, enabled = !deciding) { Text("允许本次任务访问") }
        }
    }
}

@Composable
private fun Composer(botName: String, active: Boolean, onSend: (String) -> Unit, onStop: () -> Unit) {
    var text by remember { mutableStateOf("") }
    Row(
        Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp)
            .background(Card, RoundedCornerShape(26.dp)).padding(start = 4.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextField(
            text, { text = it },
            placeholder = { Text(if (active) "$botName 正在忙…" else "给 $botName 发消息") },
            maxLines = 5,
            modifier = Modifier.weight(1f),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent,
                unfocusedContainerColor = Color.Transparent,
                disabledContainerColor = Color.Transparent,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                disabledIndicatorColor = Color.Transparent,
            ),
            enabled = !active,
        )
        if (active) {
            IconButton(onClick = onStop, colors = IconButtonDefaults.iconButtonColors(containerColor = Ink, contentColor = Color.White)) {
                Box(Modifier.size(12.dp).background(Color.White, RoundedCornerShape(2.dp)))
            }
        } else {
            IconButton(
                onClick = { val t = text.trim(); if (t.isNotEmpty()) { onSend(t); text = "" } },
                enabled = text.isNotBlank(),
                colors = IconButtonDefaults.iconButtonColors(containerColor = Accent, contentColor = Color.White, disabledContainerColor = Line, disabledContentColor = Muted),
            ) { Icon(Icons.AutoMirrored.Filled.Send, "发送", Modifier.size(20.dp)) }
        }
    }
}
