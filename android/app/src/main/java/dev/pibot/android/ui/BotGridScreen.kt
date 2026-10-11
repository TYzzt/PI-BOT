package dev.pibot.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pibot.android.data.Bot
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.domain.mood
import dev.pibot.android.domain.statusLine
import dev.pibot.android.face.PiBotFace
import dev.pibot.android.face.seedOf
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotGridScreen(repository: PiBotRepository, onOpen: (String) -> Unit, onCreate: () -> Unit, onSettings: () -> Unit) {
    val bots by repository.bots.collectAsStateWithLifecycle()
    val mac by repository.mac.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val now = rememberNow()

    suspend fun refresh() {
        try {
            repository.refreshBots()
            error = null
        } catch (e: Exception) {
            error = errorText(e)
        }
    }
    LaunchedEffect(Unit) { refresh() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("我的 Bot", fontWeight = FontWeight.Bold) },
                actions = {
                    MacChip(mac.online)
                    IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, contentDescription = "设置") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Paper),
            )
        },
        floatingActionButton = {
            if (!bots.isNullOrEmpty()) {
                ExtendedFloatingActionButton(onClick = onCreate, icon = { Icon(Icons.Filled.Add, null) }, text = { Text("新建 Bot") }, containerColor = Accent, contentColor = Color.White)
            }
        },
        containerColor = Paper,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            val list = bots
            when {
                list == null && error == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                list == null -> EmptyState(ORANGE, "error", "加载失败", error ?: "") { Button(onClick = { scope.launch { refresh() } }) { Text("重试") } }
                list.isEmpty() -> EmptyState(
                    ORANGE, "celebrate", "新建你的第一个 Bot",
                    "每个 Bot 有自己的性格和长期记忆。Mac 在线时它们在 Mac 上读写资料库、跑命令；Mac 离线时在云端陪你聊天和搜索。",
                ) { Button(onClick = onCreate) { Text("新建 Bot") } }
                else -> Column(Modifier.fillMaxSize()) {
                    if (!mac.online) OfflineBanner()
                    error?.let { Text(it, color = Danger, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(150.dp),
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(list, key = { it.id }) { bot -> BotCard(bot, now) { onOpen(bot.id) } }
                    }
                }
            }
        }
    }
}

@Composable
private fun OfflineBanner() {
    Text(
        "Mac 离线：新消息会在云端回复，只能聊天和联网搜索，看不到资料库。",
        color = Color(0xFF8A5A00),
        fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).background(Color(0xFFFFF4D6), RoundedCornerShape(12.dp)).padding(12.dp),
    )
}

@Composable
private fun BotCard(bot: Bot, now: Long, onClick: () -> Unit) {
    val waiting = bot.pendingApprovals.isNotEmpty()
    Column(
        Modifier
            .fillMaxWidth()
            .background(Card, RoundedCornerShape(22.dp))
            .clickable(onClick = onClick)
            .padding(14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box {
            PiBotFace(bot.avatar, bot.mood(now), 104.dp, seed = seedOf(bot.id))
            if (waiting) Box(Modifier.align(Alignment.TopEnd).size(12.dp).background(Accent, CircleShape))
        }
        Spacer(Modifier.height(6.dp))
        Text(bot.name, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(2.dp))
        Text(
            bot.statusLine(now),
            color = if (waiting) Accent else Muted,
            fontSize = 13.sp,
            maxLines = 2,
            minLines = 2,
            textAlign = TextAlign.Center,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
