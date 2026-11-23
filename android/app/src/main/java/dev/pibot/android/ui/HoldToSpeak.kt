package dev.pibot.android.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A result can arrive before release (e.g. after silence); never send before release. */
@Composable
internal fun HoldToSpeak(botId: String, enabled: Boolean, onActive: (Boolean) -> Unit, onError: (String?) -> Unit, onRecognized: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val reportActive by rememberUpdatedState(onActive)
    val reportError by rememberUpdatedState(onError)
    val accept by rememberUpdatedState(onRecognized)
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        reportError(if (granted) "已允许麦克风，请再次按住说话" else "需要麦克风权限才能输入语音指令")
    }
    var recognizer by remember(botId) { mutableStateOf<SpeechRecognizer?>(null) }
    var released by remember(botId) { mutableStateOf(false) }
    var result by remember(botId) { mutableStateOf<String?>(null) }
    var timeout by remember(botId) { mutableStateOf<Job?>(null) }
    fun close(cancel: Boolean) {
        val current = recognizer
        recognizer = null
        released = false
        result = null
        timeout?.cancel()
        timeout = null
        if (current != null) {
            if (cancel) current.cancel()
            current.destroy()
            reportActive(false)
        }
    }
    fun finish(value: String) {
        close(false)
        if (value.isBlank()) reportError("未识别到语音，请重试") else accept(value.trim())
    }
    fun start(): Boolean {
        if (recognizer != null) return false
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permission.launch(Manifest.permission.RECORD_AUDIO)
            return false
        }
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            reportError("此设备没有可用的系统语音识别服务")
            return false
        }
        try {
            val current = SpeechRecognizer.createSpeechRecognizer(context)
            recognizer = current
            reportError(null)
            reportActive(true)
            current.setRecognitionListener(object : RecognitionListener {
                override fun onResults(results: Bundle?) {
                    if (recognizer !== current) return
                    val value = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    if (released) finish(value) else result = value
                }
                override fun onError(error: Int) {
                    if (recognizer !== current) return
                    close(true)
                    reportError("语音识别失败，请重试（$error）")
                }
                override fun onReadyForSpeech(params: Bundle?) = Unit
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = Unit
                override fun onPartialResults(partialResults: Bundle?) = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })
            current.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            })
            return true
        } catch (e: Exception) {
            close(true)
            reportError("无法启动语音识别：${errorText(e)}")
            return false
        }
    }
    fun release() {
        val current = recognizer ?: return
        released = true
        result?.let { finish(it); return }
        try { current.stopListening() } catch (e: Exception) {
            close(true)
            reportError("无法完成语音识别：${errorText(e)}")
            return
        }
        timeout = scope.launch {
            delay(8_000)
            if (recognizer === current) {
                close(true)
                reportError("语音识别超时，请重试")
            }
        }
    }
    DisposableEffect(botId, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) close(true) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); close(true) }
    }
    val label = if (released) "识别中" else if (recognizer != null) "松开即发送" else "按住说话"
    Box(
        Modifier.size(width = 64.dp, height = 48.dp)
            .semantics { contentDescription = "$label，移出按钮取消" }
            .pointerInput(botId, enabled) {
                if (enabled) detectTapGestures(onPress = {
                    if (start()) {
                        var up = false
                        try { up = tryAwaitRelease() }
                        finally { if (up) release() else close(true) }
                    }
                })
            },
        contentAlignment = Alignment.Center,
    ) { Text(label, color = if (enabled) Accent else Muted) }
}
