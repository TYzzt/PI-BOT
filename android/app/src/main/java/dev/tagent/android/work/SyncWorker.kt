package dev.tagent.android.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import dev.tagent.android.data.TagentRepository
import dev.tagent.android.data.api.ApiException
import java.io.IOException

class SyncWorker(
    context: Context,
    params: WorkerParameters,
    private val repository: TagentRepository,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        repository.catchUp()
        Result.success()
    } catch (error: ApiException) {
        if (error.status == 401) Result.failure() else Result.retry()
    } catch (_: IOException) {
        Result.retry()
    }
}
