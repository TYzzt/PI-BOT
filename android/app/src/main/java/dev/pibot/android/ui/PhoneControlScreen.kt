package dev.pibot.android.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.data.encodePhoneMap
import dev.pibot.android.data.isAcquireApplicable
import dev.pibot.android.data.phoneAssociationKey
import dev.pibot.android.data.readPhoneMap
import dev.pibot.android.data.resolvePhoneDevice
import dev.pibot.android.data.validateAcquireResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.hypot

private const val PREFS = "pibot.phone.assoc"
private const val ABSOLUTE_MS = 10 * 60 * 1000L
private const val IDLE_MS = 45_000L

private class PhoneLease {
    var deviceId: String? = null
    var sessionId: String? = null
    var hardEnd = 0L
    var idleEnd = 0L
}

/** Full-screen phone view. Preview does not hold a lease; takeover is explicit. Association stays on this app only. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhoneControlScreen(repository: PiBotRepository, botId: String?, fixedDeviceId: String?, onBack: () -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val sessionState by repository.session.collectAsStateWithLifecycle()
    val accountKey = remember(sessionState?.user?.id) { phoneAssociationKey(sessionState?.user?.id) }
    val devices by repository.devices.collectAsStateWithLifecycle()
    val bots by repository.bots.collectAsStateWithLifecycle()
    val executionId = bots?.firstOrNull { it.id == botId }?.executionDeviceId
    val lease = remember { PhoneLease() }
    var foreground by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    var deviceId by remember { mutableStateOf(fixedDeviceId) }
    var controlling by remember { mutableStateOf(false) }
    var acquirePending by remember { mutableStateOf(false) }
    var acquireEpoch by remember { mutableLongStateOf(0L) }
    var frame by remember { mutableStateOf<ImageBitmap?>(null) }
    var notice by remember { mutableStateOf("只读预览，不占用控制权") }
    var draft by remember { mutableStateOf("") }
    var retry by remember { mutableIntStateOf(0) }
    var sending by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    var statusLabel by remember { mutableStateOf<String?>(null) }
    var phoneId by remember { mutableStateOf<String?>(null) }
    var available by remember { mutableStateOf(false) }
    var occupied by remember { mutableStateOf(false) }

    fun releaseCurrentLease() {
        val sid = lease.sessionId ?: return
        val did = lease.deviceId ?: return
        lease.sessionId = null
        lease.deviceId = null
        repository.releasePhoneSessionAsync(did, sid)
    }

    fun persist(next: String) {
        if (botId.isNullOrBlank()) return
        val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        val map = readPhoneMap(prefs.getString(accountKey, null)).toMutableMap()
        map[botId] = next
        prefs.edit().putString(accountKey, encodePhoneMap(map)).apply()
    }

    fun selectDevice(nextId: String?, saveMapping: Boolean) {
        if (deviceId == nextId) return
        acquireEpoch++
        acquirePending = false
        val oldSid = lease.sessionId
        val oldDid = lease.deviceId
        lease.sessionId = null
        lease.deviceId = null
        controlling = false
        frame = null
        draft = ""
        statusLabel = null
        phoneId = null
        available = false
        occupied = false
        notice = "只读预览，不占用控制权"
        deviceId = nextId
        if (oldDid != null && oldSid != null) {
            repository.releasePhoneSessionAsync(oldDid, oldSid)
        }
        if (saveMapping && !nextId.isNullOrBlank()) {
            persist(nextId)
        }
    }

    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) {
                foreground = true
            }
            if (event == Lifecycle.Event.ON_STOP) {
                foreground = false
                acquireEpoch++
                acquirePending = false
                draft = ""
                releaseCurrentLease()
                controlling = false
                frame = null
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            owner.lifecycle.removeObserver(observer)
            acquireEpoch++
            acquirePending = false
            releaseCurrentLease()
        }
    }

    LaunchedEffect(botId, fixedDeviceId, devices, executionId, accountKey) {
        if (!fixedDeviceId.isNullOrBlank()) {
            if (deviceId != fixedDeviceId) selectDevice(fixedDeviceId, saveMapping = false)
            return@LaunchedEffect
        }
        val current = deviceId
        val live = devices.filter { it.revokedAt == null }.map { it.id }.toSet()
        if (current != null && current in live && current != fixedDeviceId) return@LaunchedEffect
        val saved = botId?.let {
            readPhoneMap(context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).getString(accountKey, null))[it]
        }
        val resolved = resolvePhoneDevice(saved, executionId, devices).deviceId
        if (resolved != deviceId) {
            selectDevice(resolved, saveMapping = false)
        }
    }

    LaunchedEffect(deviceId) {
        val id = deviceId ?: return@LaunchedEffect
        while (isActive) {
            try {
                val status = repository.phone(id, "status")
                if (deviceId == id) {
                    available = status["available"]?.jsonPrimitive?.contentOrNull == "true"
                    occupied = status["occupied"]?.jsonPrimitive?.contentOrNull == "true"
                    statusLabel = status["label"]?.jsonPrimitive?.contentOrNull
                    phoneId = status["phoneId"]?.jsonPrimitive?.contentOrNull
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (deviceId == id) {
                    available = false
                    occupied = false
                }
            }
            delay(5000)
        }
    }

    LaunchedEffect(deviceId, foreground, controlling, retry) {
        val id = deviceId
        if (!foreground || id.isNullOrBlank()) return@LaunchedEffect
        if (!controlling) {
            while (isActive) {
                try {
                    val result = repository.phone(id, "preview")
                    if (deviceId == id && !controlling && foreground) {
                        frame = decodeFrame(result)
                        notice = "只读预览 · 低帧率截图，不是视频"
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (deviceId == id) {
                        notice = "预览失败：${errorText(e)}"
                    }
                }
                delay(650)
            }
            return@LaunchedEffect
        }
        val session = lease.sessionId
        if (session == null || lease.deviceId != id) {
            controlling = false
            return@LaunchedEffect
        }
        try {
            while (isActive) {
                val now = System.currentTimeMillis()
                if (now >= lease.hardEnd) {
                    notice = "接管已到 10 分钟上限，已释放"
                    break
                }
                if (now >= lease.idleEnd) {
                    notice = "空闲超过 45 秒，已释放"
                    break
                }
                val result = repository.phone(id, "frame", buildJsonObject {
                    put("sessionId", JsonPrimitive(session))
                })
                if (deviceId == id && controlling && foreground) {
                    frame = decodeFrame(result)
                    lease.idleEnd = minOf(lease.hardEnd, System.currentTimeMillis() + IDLE_MS)
                    notice = "已接管 · 低帧率截图，不是视频"
                }
                delay(650)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (deviceId == id) {
                notice = "接管中断：${errorText(e)}"
            }
        } finally {
            releaseCurrentLease()
            frame = null
            draft = ""
            controlling = false
        }
    }

    val selected = devices.firstOrNull { it.id == deviceId && it.revokedAt == null }

    suspend fun send(event: JsonObject) {
        val session = lease.sessionId ?: return
        val device = lease.deviceId ?: return
        try {
            val body = buildJsonObject {
                put("sessionId", JsonPrimitive(session))
                put("event", event)
            }
            repository.phone(device, "input", body)
            lease.idleEnd = minOf(lease.hardEnd, System.currentTimeMillis() + IDLE_MS)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            notice = "操作未送达：${errorText(e)}"
        }
    }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text(if (controlling) "手机接管" else "手机预览") },
            navigationIcon = { TextButton(onClick = onBack) { Text("返回") } }
        )
    }) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (fixedDeviceId == null) {
                TextButton(onClick = { picking = true }) {
                    Text(selected?.let { "${it.label} · ${platformOf(it.platform)} · ${if (it.online) "在线" else "离线"}" } ?: "选择已授权的执行电脑")
                }
                DropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                    devices.filter { it.revokedAt == null }.forEach { device ->
                        DropdownMenuItem(
                            text = { Text("${device.label} · ${platformOf(device.platform)} · ${if (device.online) "在线" else "离线"}") },
                            onClick = {
                                picking = false
                                selectDevice(device.id, saveMapping = true)
                            }
                        )
                    }
                }
            } else {
                Text(selected?.let { "${it.label} · ${platformOf(it.platform)} · ${if (it.online) "在线" else "离线"}" } ?: "这台执行电脑已不可用")
            }
            Text("每台执行电脑只有节点上已启用的一台手机${statusLabel?.let { "：$it" } ?: ""}${phoneId?.let { "（$it）" } ?: ""}。不会列出更多虚拟手机。")
            Text(if (botId.isNullOrBlank()) "从设置打开时不改某个 Bot 的关联。" else "关联只保存在这台手机的本应用里，不会上传或同步。")
            Text(notice)
            if (devices.none { it.revokedAt == null }) Text("没有已授权的执行电脑。")

            frame?.let { image ->
                Image(
                    bitmap = image,
                    contentDescription = if (controlling) "手机当前画面，可以操作" else "手机只读预览",
                    modifier = Modifier
                        .widthIn(max = 280.dp)
                        .fillMaxWidth()
                        .aspectRatio(720f / 1280f)
                        .pointerInput(controlling, lease.sessionId) {
                            if (!controlling) return@pointerInput
                            awaitEachGesture {
                                val down = awaitFirstDown(requireUnconsumed = false)
                                val start = down.position
                                var end = start
                                val at = down.uptimeMillis
                                var lastAt = at
                                do {
                                    val event = awaitPointerEvent()
                                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                    end = change.position
                                    lastAt = change.uptimeMillis
                                    change.consume()
                                } while (event.changes.any { it.id == down.id && it.pressed })
                                fun x(value: Float) = (value / size.width * 720).toInt().coerceIn(0, 719)
                                fun y(value: Float) = (value / size.height * 1280).toInt().coerceIn(0, 1279)
                                val isTap = hypot(end.x - start.x, end.y - start.y) < 10
                                val event = if (isTap) {
                                    buildJsonObject {
                                        put("type", JsonPrimitive("tap"))
                                        put("x", JsonPrimitive(x(end.x)))
                                        put("y", JsonPrimitive(y(end.y)))
                                    }
                                } else {
                                    buildJsonObject {
                                        put("type", JsonPrimitive("swipe"))
                                        put("x1", JsonPrimitive(x(start.x)))
                                        put("y1", JsonPrimitive(y(start.y)))
                                        put("x2", JsonPrimitive(x(end.x)))
                                        put("y2", JsonPrimitive(y(end.y)))
                                        put("duration", JsonPrimitive((lastAt - at).coerceIn(50, 2000)))
                                    }
                                }
                                scope.launch { send(event) }
                            }
                        }
                )
            }

            if (controlling) {
                Button(onClick = {
                    releaseCurrentLease()
                    controlling = false
                    notice = "已结束接管"
                }) { Text("结束接管") }
            } else {
                Button(
                    enabled = !deviceId.isNullOrBlank() && available && !occupied && !acquirePending,
                    onClick = {
                        val id = deviceId ?: return@Button
                        val myEpoch = ++acquireEpoch
                        acquirePending = true
                        notice = "正在申请接管…"
                        scope.launch {
                            var remoteSessionToRelease: String? = null
                            try {
                                val acquired = repository.phone(id, "acquire")
                                val validation = validateAcquireResponse(acquired, System.currentTimeMillis())
                                if (validation.sessionId != null) {
                                    remoteSessionToRelease = validation.sessionId
                                }
                                if (!validation.isSuccess) {
                                    error(validation.error ?: "会话校验失败")
                                }
                                val session = validation.sessionId!!
                                val expires = validation.expiresAtMs!!
                                val now = System.currentTimeMillis()

                                if (!isAcquireApplicable(id, deviceId, myEpoch, acquireEpoch, foreground)) {
                                    error("接管环境已变更，放弃迟到会话")
                                }

                                lease.deviceId = id
                                lease.sessionId = session
                                lease.hardEnd = minOf(now + ABSOLUTE_MS, expires)
                                lease.idleEnd = minOf(lease.hardEnd, now + IDLE_MS)
                                controlling = true
                                notice = "已接管 · 低帧率截图，不是视频"
                                remoteSessionToRelease = null
                            } catch (e: CancellationException) {
                                remoteSessionToRelease?.let { orphan ->
                                    repository.releasePhoneSessionAsync(id, orphan)
                                }
                                throw e
                            } catch (e: Exception) {
                                remoteSessionToRelease?.let { orphan ->
                                    repository.releasePhoneSessionAsync(id, orphan)
                                }
                                notice = "没有接管：${errorText(e)}"
                            } finally {
                                if (acquireEpoch == myEpoch) {
                                    acquirePending = false
                                }
                            }
                        }
                    }
                ) {
                    Text(if (acquirePending) "申请中…" else "接管")
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                listOf("返回" to 4, "主页" to 3, "最近" to 187, "删除" to 67, "回车" to 66).forEach { (label, code) ->
                    TextButton(
                        enabled = controlling,
                        onClick = {
                            scope.launch {
                                send(buildJsonObject {
                                    put("type", JsonPrimitive("key"))
                                    put("code", JsonPrimitive(code))
                                })
                            }
                        }
                    ) { Text(label) }
                }
            }

            OutlinedTextField(
                value = draft,
                onValueChange = { if (it.length <= 1000) draft = it },
                enabled = controlling,
                label = { Text("发送英文、数字和符号") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth()
            )

            Button(
                enabled = controlling && draft.isNotEmpty() && !sending,
                onClick = {
                    if (draft.any { it.code !in 32..126 }) {
                        notice = "只能发送英文、数字和符号"
                    } else {
                        val text = draft
                        draft = ""
                        sending = true
                        scope.launch {
                            try {
                                send(buildJsonObject {
                                    put("type", JsonPrimitive("text"))
                                    put("text", JsonPrimitive(text))
                                })
                            } finally {
                                sending = false
                            }
                        }
                    }
                }
            ) { Text("发送到手机") }

            Text("画面和输入经已登录的 Pi 连接转发，不进入聊天，也不写入日志。关闭或进入后台会释放接管；预览不占锁。")
            if (!controlling) TextButton(onClick = { retry++ }) { Text("重新读取预览") }
            if (occupied && !controlling) Text("手机正在被占用，只读预览仍可尝试，接管要等对方释放。")
        }
    }
}

private fun platformOf(platform: String) = when (platform) {
    "linux" -> "Linux"
    "darwin" -> "macOS"
    "win32" -> "Windows"
    else -> "未知平台"
}

private suspend fun decodeFrame(result: JsonObject): ImageBitmap {
    require(result["mime"]?.jsonPrimitive?.contentOrNull == "image/jpeg")
    require(result["width"]?.jsonPrimitive?.intOrNull == 720 && result["height"]?.jsonPrimitive?.intOrNull == 1280)
    val data = result["data"]?.jsonPrimitive?.contentOrNull ?: error("无画面")
    require(data.length in 16..1_500_000 && data.startsWith("/9j/"))
    return withContext(Dispatchers.Default) {
        val bytes = Base64.decode(data, Base64.DEFAULT)
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("无效画面")
        bitmap.asImageBitmap()
    }
}
