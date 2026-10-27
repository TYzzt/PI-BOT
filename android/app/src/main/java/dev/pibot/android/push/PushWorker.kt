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
        val session = app.repository.session.value ?: return@withLock Result.success()
        if (!PushRegistrationPolicy.current(session, inputData.getString("binding"), app.push.available, System.currentTimeMillis()))
            return@withLock Result.success()
        try {
            if (inputData.getBoolean("unregister", false) || !app.push.permissionGranted) {
                withContext(Dispatchers.IO) { app.api.unregisterPush(session, app.push.installationId) }
                return@withLock Result.success()
            }
            val token = FirebaseMessaging.getInstance().token.await()
            if (app.repository.session.value?.pushBindingId != session.pushBindingId) return@withLock Result.success()
            val result = withContext(Dispatchers.IO) { app.api.registerPush(session, app.push.installationId, token) }
            app.push.registrationResult(session, result["enabled"]?.toString() == "true")
            Result.success()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            val retry = e !is ApiException || PushRegistrationPolicy.retry(e.status)
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
