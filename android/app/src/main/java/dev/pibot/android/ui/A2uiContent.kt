package dev.pibot.android.ui

import android.annotation.SuppressLint
import java.net.URI
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import dev.pibot.android.data.API_JSON
import dev.pibot.android.data.Message
import dev.pibot.android.data.PiBotRepository
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayInputStream
import org.json.JSONObject

private const val UI_ORIGIN = "https://pibot-ui.invalid"
/** Renderer assets only. No account tokens, filesystem or general native API are exposed to the page. */
internal fun a2uiAssetPath(url: String): String? {
    val uri = runCatching { URI(url) }.getOrNull() ?: return null
    if (uri.scheme != "https" || uri.host != "pibot-ui.invalid" || uri.port != -1 || uri.userInfo != null) return null
    val path = uri.path ?: return null
    return when (path) {
        "/a2ui/index.html" -> "a2ui/index.html"
        "/a2ui/renderer.js" -> "a2ui/renderer.js"
        "/a2ui/style.css" -> "a2ui/style.css"
        else -> null
    }
}
private class UiBridge(private val post: (String) -> Unit) {
    @JavascriptInterface fun postMessage(value: String) { if (value.length <= 240_000) post(value) }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun A2uiContent(message: Message, repository: PiBotRepository, disabled: Boolean) {
    val scope = rememberCoroutineScope()
    var height by remember(message.id) { mutableStateOf(180) }
    var ready by remember(message.id) { mutableStateOf(false) }
    val latest by rememberUpdatedState(message)
    val locked by rememberUpdatedState(disabled)
    var web by remember(message.id) { mutableStateOf<WebView?>(null) }
    fun sendDocument(view: WebView) {
        val payload = buildJsonObject { put("document", latest.ui ?: JsonNull); put("disabled", JsonPrimitive(locked)) }
        view.evaluateJavascript("window.piBotUi?.receive(JSON.parse(${JSONObject.quote(payload.toString())}));", null)
    }
    DisposableEffect(message.id) {
        onDispose { web?.let { it.removeJavascriptInterface("PiBotUiHost"); it.stopLoading(); it.destroy() }; web = null }
    }
    AndroidView(
        modifier = Modifier.fillMaxWidth().height(height.dp),
        factory = { context ->
            WebView(context).apply {
                web = this
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.setSupportMultipleWindows(false)
                settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse {
                        val path = request?.url?.toString()?.let(::a2uiAssetPath)
                        if (path != null) {
                            val mime = when { path.endsWith(".js") -> "text/javascript"; path.endsWith(".css") -> "text/css"; else -> "text/html" }
                            return runCatching { WebResourceResponse(mime, "UTF-8", context.assets.open(path)) }.getOrElse { blocked() }
                        }
                        return blocked()
                    }
                    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                    override fun onPageFinished(view: WebView, url: String) { if (url == "$UI_ORIGIN/a2ui/index.html") sendDocument(view) }
                }
                addJavascriptInterface(UiBridge { raw ->
                    scope.launch {
                        val packet = runCatching { API_JSON.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return@launch
                        when (packet["type"]?.jsonPrimitive?.contentOrNull) {
                            "ready" -> { ready = true; web?.let(::sendDocument) }
                            "height" -> packet["height"]?.jsonPrimitive?.intOrNull?.let { height = it.coerceIn(100, 6000) }
                            "state", "action" -> {
                                val id = packet["id"]?.jsonPrimitive?.contentOrNull ?: return@launch
                                val payload = packet["payload"] as? JsonObject ?: return@launch
                                val result = runCatching {
                                    if (locked) throw IllegalStateException("请等待 Bot 完成当前任务后再操作")
                                    if (packet["type"]?.jsonPrimitive?.contentOrNull == "state") repository.saveUiState(latest.botId, latest.id, payload)
                                    else { repository.submitUiAction(latest.botId, latest.id, payload); JsonNull }
                                }
                                val response = buildJsonObject {
                                    put("id", JsonPrimitive(id))
                                    result.onSuccess { put("result", it) }.onFailure { put("error", JsonPrimitive(errorText(it))) }
                                }
                                web?.evaluateJavascript("window.piBotUi?.respond(JSON.parse(${JSONObject.quote(response.toString())}));", null)
                            }
                        }
                    }
                }, "PiBotUiHost")
                loadUrl("$UI_ORIGIN/a2ui/index.html")
            }
        },
        update = { view -> if (ready) sendDocument(view) },
    )
}
