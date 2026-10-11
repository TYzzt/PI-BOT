package dev.pibot.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pibot.android.BuildConfig
import dev.pibot.android.data.Device
import dev.pibot.android.data.PiBotRepository
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(repository: PiBotRepository, onBack: () -> Unit) {
    val session by repository.session.collectAsStateWithLifecycle()
    val mac by repository.mac.collectAsStateWithLifecycle()
    val live by repository.live.collectAsStateWithLifecycle()
    var device by remember { mutableStateOf<Device?>(mac.device) }
    var changing by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { runCatching { device = repository.refreshMe().mac.device } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Paper),
            )
        },
        containerColor = Paper,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp)) {
            Group("账号") {
                Item("用户", session?.user?.let { it.displayName.ifBlank { it.username } } ?: "")
                Item("服务器", session?.serverUrl ?: "")
                Item("实时连接", if (live) "已连接" else "未连接", last = true)
            }
            Group("Mac") {
                val d = device
                if (d == null) {
                    Text("还没有绑定 Mac。在 Mac 上安装 Pi Bot 并用同一个账号登录，Bot 就能在 Mac 上读写资料库、执行命令。", color = Muted, fontSize = 14.sp, modifier = Modifier.padding(vertical = 8.dp))
                } else {
                    Item("设备", d.label)
                    Item("状态", if (mac.online) "在线" else "离线" + (d.lastSeenAt?.let { " · 最后在线 ${dayLabel(it)} ${clockTime(it)}" } ?: ""), last = true)
                }
                Text("Mac 离线时，发给 Bot 的消息在云端回复：只能聊天和联网搜索，看不到资料库。", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
            }
            Spacer(Modifier.height(20.dp))
            OutlinedButton(onClick = { changing = true }, modifier = Modifier.fillMaxWidth()) { Text("修改密码") }
            Spacer(Modifier.height(10.dp))
            OutlinedButton(onClick = { repository.logout() }, modifier = Modifier.fillMaxWidth()) { Text("退出登录", color = Danger) }
            Spacer(Modifier.height(20.dp))
            Text("Pi Bot ${BuildConfig.VERSION_NAME}", color = Muted, fontSize = 12.sp, modifier = Modifier.fillMaxWidth())
        }
    }
    if (changing) PasswordDialog(repository) { changing = false }
}

@Composable
private fun Group(title: String, content: @Composable () -> Unit) {
    Text(title, fontWeight = FontWeight.SemiBold, color = Muted, fontSize = 13.sp, modifier = Modifier.padding(start = 4.dp, top = 12.dp, bottom = 6.dp))
    Column(Modifier.fillMaxWidth().background(Card, RoundedCornerShape(18.dp)).padding(horizontal = 16.dp, vertical = 6.dp)) { content() }
}

@Composable
private fun Item(label: String, value: String, last: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Text(label, modifier = Modifier.weight(0.35f))
        Text(value, color = Muted, modifier = Modifier.weight(0.65f))
    }
    if (!last) HorizontalDivider(color = Line)
}

@Composable
private fun PasswordDialog(repository: PiBotRepository, onClose: () -> Unit) {
    var old by remember { mutableStateOf("") }
    var new by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("修改密码") },
        text = {
            Column {
                OutlinedTextField(old, { old = it }, label = { Text("原密码") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(new, { new = it }, label = { Text("新密码（至少 8 位）") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                error?.let { Text(it, color = Danger, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && old.isNotEmpty() && new.length >= 8, onClick = {
                busy = true
                scope.launch {
                    try {
                        repository.changePassword(old, new)
                        onClose()
                    } catch (e: Exception) {
                        error = errorText(e)
                    } finally {
                        busy = false
                    }
                }
            }) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("取消") } },
    )
}
