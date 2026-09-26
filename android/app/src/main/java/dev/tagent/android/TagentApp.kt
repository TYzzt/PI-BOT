package dev.tagent.android

import android.app.Application
import android.content.Context
import androidx.work.Configuration
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.room.Room
import dev.tagent.android.data.SessionStore
import dev.tagent.android.data.TagentRepository
import dev.tagent.android.data.api.TagentApi
import dev.tagent.android.data.db.MIGRATION_2_3
import dev.tagent.android.data.db.TagentDatabase
import dev.tagent.android.work.SyncWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class TagentApp : Application(), Configuration.Provider {
    lateinit var repository: TagentRepository
        private set

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(object : WorkerFactory() {
            override fun createWorker(appContext: Context, workerClassName: String, workerParameters: WorkerParameters) =
                if (workerClassName == SyncWorker::class.java.name) SyncWorker(appContext, workerParameters, repository) else null
        }).build()

    override fun onCreate() {
        super.onCreate()
        val database = Room.databaseBuilder(this, TagentDatabase::class.java, "tagent.db")
            .addMigrations(MIGRATION_2_3)
            .fallbackToDestructiveMigration(dropAllTables = true)
            .build()
        val http = OkHttpClient.Builder().build()
        repository = TagentRepository(
            database = database,
            session = SessionStore(this),
            api = TagentApi(http),
            http = http,
            online = { hasNetwork(this) },
            allowCleartext = BuildConfig.DEBUG,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
        )
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("tagent-sync", ExistingPeriodicWorkPolicy.KEEP, request)
    }
}

private fun hasNetwork(context: Context): Boolean {
    val manager = context.getSystemService(android.net.ConnectivityManager::class.java) ?: return false
    val network = manager.activeNetwork ?: return false
    val capabilities = manager.getNetworkCapabilities(network) ?: return false
    return capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
}
