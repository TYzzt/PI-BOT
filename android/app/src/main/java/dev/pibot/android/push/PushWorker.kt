package dev.pibot.android.push

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.google.firebase.messaging.FirebaseMessaging
import dev.pibot.android.PiBotApp
import dev.pibot.android.data.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class PushWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = bindingMutex.withLock {
        val app = applicationContext as PiBotApp
        // WorkManager can restore work while Application is still restoring the session and cached options.
        app.ready.await()
        val session = app.repository.session.value ?: return@withLock Result.success()
        if (!PushRegistrationPolicy.current(session, inputData.getString("binding"), app.push.available, System.currentTimeMillis()))
            return@withLock Result.success()
        try {
            val config = try {
                withContext(Dispatchers.IO) { app.api.pushConfig(session) }
            } catch (e: ApiException) {
                // Older servers have no push endpoint; chat and the generic APK remain compatible.
                if (e.status == 404) PushConfigResponse(false) else throw e
            }
            if (app.repository.session.value?.pushBindingId != session.pushBindingId) return@withLock Result.success()
            val ready = app.push.applyConfiguration(session, config)
            if (!ready || !config.enabled) {
                withContext(Dispatchers.IO) { runCatching { app.api.unregisterPush(session, app.push.installationId) } }
                return@withLock Result.success()
            }
            if (inputData.getBoolean("unregister", false) || !app.push.permissionGranted) {
                withContext(Dispatchers.IO) { app.api.unregisterPush(session, app.push.installationId) }
                return@withLock Result.success()
            }
            val token = FirebaseMessaging.getInstance().token.await()
            if (app.repository.session.value?.pushBindingId != session.pushBindingId) return@withLock Result.success()
            val result = withContext(Dispatchers.IO) { app.api.registerPush(session, app.push.installationId, token, config.firebase!!.projectId) }
            app.push.registrationResult(session, result["enabled"]?.toString() == "true")
            Result.success()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            val retry = e !is ApiException || e.status == 409 || PushRegistrationPolicy.retry(e.status)
            app.push.registrationFailed(session, retry)
            if (retry) Result.retry() else Result.failure()
        } finally {
            // An uncancellable HTTP call may finish after logout. Remove only its old binding.
            if (app.repository.session.value?.pushBindingId != session.pushBindingId) withContext(NonCancellable + Dispatchers.IO) {
                runCatching { app.api.unregisterPush(session, app.push.installationId) }
            }
        }
    }

    companion object { val bindingMutex = Mutex() }
}
