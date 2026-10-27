package dev.pibot.android.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import dev.pibot.android.BuildConfig
import dev.pibot.android.MainActivity
import dev.pibot.android.R
import dev.pibot.android.data.PiBotApi
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.data.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.util.UUID

class PushController(
    private val context: Context, private val repository: PiBotRepository,
    private val api: PiBotApi, private val scope: CoroutineScope,
) {
    private val prefs = context.getSharedPreferences("pibot.push", Context.MODE_PRIVATE)
    val installationId: String = prefs.getString("installation", null) ?: UUID.randomUUID().toString().also {
        prefs.edit().putString("installation", it).commit()
    }
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val _status = MutableStateFlow("未配置推送")
    val status = _status.asStateFlow()
    private val _target = MutableStateFlow<PushEvent?>(null)
    val target = _target.asStateFlow()
    val configured: Boolean get() = BuildConfig.FCM_ENABLED
    val available: Boolean get() = configured && GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    val permissionGranted: Boolean get() = (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        && NotificationManagerCompat.from(context).areNotificationsEnabled()
    var permissionExplained: Boolean
        get() = prefs.getBoolean("permission_explained", false)
        set(value) { prefs.edit().putBoolean("permission_explained", value).apply() }

    init {
        manager.createNotificationChannels(listOf(
            NotificationChannel(MESSAGES, "Bot 消息", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(APPROVALS, "待处理审批", NotificationManager.IMPORTANCE_HIGH),
        ))
    }

    @Synchronized
    fun sessionChanged(previous: Session?, current: Session?) {
        if (current == null || previous?.pushBindingId != current.pushBindingId) {
            clearAll()
            _target.value = null
            prefs.edit().remove("ledger").apply()
        }
        if (previous != null && previous.pushBindingId != current?.pushBindingId) {
            WorkManager.getInstance(context).cancelAllWorkByTag("push:${previous.pushBindingId}")
            // Capture the old bearer in memory only; never put credentials into WorkManager Data.
            scope.launch { PushWorker.bindingMutex.withLock { runCatching { api.unregisterPush(previous, installationId) } } }
        }
        sync()
    }

    fun sync() {
        val session = repository.session.value
        _status.value = when {
            !configured -> "此安装包未配置推送"
            !available -> "设备缺少可用的 Google Play 服务"
            session == null -> "登录后启用"
            !permissionGranted -> "系统通知权限已关闭"
            prefs.getString("registered_binding", null) == session.pushBindingId ->
                if (prefs.getBoolean("server_enabled", false)) "已注册 FCM 推送" else "服务器未启用推送"
            else -> "正在注册推送"
        }
        if (session != null && available) {
            if (session.expiresAt <= System.currentTimeMillis()) return
            val work = OneTimeWorkRequestBuilder<PushWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInputData(workDataOf("binding" to session.pushBindingId, "unregister" to !permissionGranted))
                .addTag("push:${session.pushBindingId}").build()
            WorkManager.getInstance(context).enqueueUniqueWork("push-register", ExistingWorkPolicy.REPLACE, work)
        }
    }

    fun registrationResult(session: Session, enabled: Boolean) {
        if (repository.session.value?.pushBindingId != session.pushBindingId) return
        prefs.edit().putString("registered_binding", session.pushBindingId).putBoolean("server_enabled", enabled).apply()
        _status.value = if (enabled) "已注册 FCM 推送" else "服务器未启用推送"
    }

    fun registrationFailed(session: Session, retry: Boolean) {
        if (repository.session.value?.pushBindingId != session.pushBindingId) return
        _status.value = if (retry) "推送注册失败，联网后自动重试" else "推送注册失败，请检查登录状态或服务器配置"
    }

    @Synchronized
    fun receive(data: Map<String, String>) {
        val event = PushEvent.parse(data) ?: return
        val now = System.currentTimeMillis()
        if (!event.matches(repository.session.value, now)) return
        val entries = runCatching {
            val json = JSONObject(prefs.getString("ledger", "{}")!!)
            json.keys().asSequence().associateWith { json.getLong(it) }
        }.getOrDefault(emptyMap())
        val ledger = PushLedger(entries)
        if (!ledger.accept(event, now)) return
        prefs.edit().putString("ledger", JSONObject(ledger.entries as Map<*, *>).toString()).commit()
        if (repository.foreground) scope.launch { runCatching { repository.refreshFromPush(event.botId, event.bindingId) } }
        if (!event.shouldNotify(repository.session.value, repository.foreground, repository.visibleBotId, now) || !permissionGranted) return
        val intent = Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .setAction("dev.pibot.android.PUSH.${event.eventId}")
            .putExtra(EXTRA, JSONObject(data).toString())
        val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, if (event.kind == "message") MESSAGES else APPROVALS)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(event.title).setContentText(event.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(event.body)).setContentIntent(pending)
            .setGroup("push:${event.botId}").setAutoCancel(true).setOnlyAlertOnce(false)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setTimeoutAfter(event.expiresAt - now).build()
        // Recheck immediately before display: a logout may have happened while parsing.
        if (event.matches(repository.session.value)) runCatching { manager.notify(event.notificationTag, 0, notification) }
    }

    @Synchronized
    fun handleIntent(intent: Intent?) {
        val raw = intent?.getStringExtra(EXTRA) ?: return
        intent.removeExtra(EXTRA)
        val event = runCatching {
            val json = JSONObject(raw)
            PushEvent.parse(json.keys().asSequence().associateWith { json.getString(it) })
        }.getOrNull() ?: return
        if (event.matches(repository.session.value)) {
            _target.value = event
            scope.launch { runCatching { repository.refreshFromPush(event.botId, event.bindingId) } }
        }
    }

    fun consumeTarget(event: PushEvent) { if (_target.value == event) _target.value = null }
    fun clearBot(botId: String) {
        manager.activeNotifications.filter { it.tag?.startsWith("push:") == true && it.notification.group == "push:$botId" }
            .forEach { manager.cancel(it.tag, it.id) }
    }
    private fun clearAll() {
        manager.activeNotifications.filter { it.tag?.startsWith("push:") == true }.forEach { manager.cancel(it.tag, it.id) }
    }

    companion object {
        const val EXTRA = "pibot_push"
        const val MESSAGES = "bot_messages"
        const val APPROVALS = "bot_approvals"
    }
}
