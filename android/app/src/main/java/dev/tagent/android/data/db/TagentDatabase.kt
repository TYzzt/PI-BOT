package dev.tagent.android.data.db

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "devices")
data class DeviceEntity(
    @PrimaryKey val deviceId: String,
    val label: String,
    val presence: String,
    val lastSeenAt: String?,
    val revokedAt: String?,
)

@Entity(tableName = "projects")
data class ProjectEntity(
    @PrimaryKey val projectId: String,
    val deviceId: String,
    val displayName: String,
    val availability: String,
    val updatedAt: String,
)

data class ProjectListItem(
    val projectId: String,
    val displayName: String,
    val availability: String,
    val deviceId: String,
    val label: String?,
    val presence: String?,
    val revokedAt: String?,
)

@Entity(tableName = "tasks")
data class TaskEntity(
    @PrimaryKey val taskId: String,
    val projectId: String,
    val targetDeviceId: String,
    val requirement: String,
    val status: String,
    val cancelRequested: Boolean,
    val cancelRequestedAt: String?,
    val latestPlanId: String?,
    val devicePresence: String,
    val createdAt: String,
    val updatedAt: String,
)

@Entity(tableName = "plans")
data class PlanEntity(
    @PrimaryKey val planId: String,
    val taskId: String,
    val version: Int,
    val contentHash: String,
    val createdAt: String,
    val supersededAt: String?,
    val bodyJson: String?,
)

@Entity(
    tableName = "events",
    indices = [Index("taskId"), Index("serverCursor")],
)
data class EventEntity(
    @PrimaryKey val eventId: String,
    val serverCursor: Long,
    val type: String,
    val taskId: String?,
    val occurredAt: String,
    val payloadJson: String,
)

@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey val id: String,
    val kind: String,
    val targetId: String,
    val idempotencyKey: String?,
    val body: String,
    val phase: String,
    val error: String?,
    val resultId: String?,
)

@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey val id: String,
    val deviceId: String,
    val version: Int,
    val title: String,
    val kind: String,
    val modelConfigId: String,
    val projectId: String?,
    val taskId: String?,
    val shared: Boolean,
    val shareVersion: Int,
    val deleted: Boolean,
    // "mac" or "cloud"; cloud conversations store an empty deviceId.
    val target: String,
    val handoffCount: Int,
)

data class ConversationListItem(
    val id: String,
    val title: String,
    val kind: String,
    val target: String,
    val handoffCount: Int,
    val deviceId: String,
    val projectId: String?,
    val taskId: String?,
    val taskStatus: String?,
    val shared: Boolean,
    val deviceLabel: String?,
    val presence: String?,
    val projectName: String?,
)

@Entity(
    tableName = "messages",
    indices = [Index("conversationId"), Index("sequence")],
)
data class MessageEntity(
    @PrimaryKey val messageId: String,
    val conversationId: String,
    val deviceId: String,
    val version: Int,
    val runId: String,
    val role: String,
    val content: String,
    val status: String,
    val sequence: Int,
)

@Entity(
    tableName = "chat_runs",
    indices = [Index("conversationId")],
)
data class ChatRunEntity(
    @PrimaryKey val runId: String,
    val conversationId: String,
    val deviceId: String,
    val version: Int,
    val messageId: String,
    val text: String,
    val state: String,
    val shareVersion: Int,
    val acked: Boolean,
    val cancelRequested: Boolean,
    val localRunId: String?,
    val seenAt: Long,
)

/** Shared skill or MCP document cached for offline viewing; [json] is the server's public form. */
@Entity(tableName = "config_docs")
data class ConfigDocEntity(
    @PrimaryKey val id: String,
    val kind: String,
    val name: String,
    val version: Int,
    val json: String,
)

@Entity(tableName = "meta")
data class MetaEntity(
    @PrimaryKey val id: Int = 1,
    val cursor: Long = 0,
    val lastSyncAt: Long? = null,
    val refreshFailed: Boolean = false,
)

@Dao
interface TagentDao {
    @Query(
        """
        SELECT projects.projectId, projects.displayName, projects.availability, projects.deviceId,
               devices.label, devices.presence, devices.revokedAt
        FROM projects LEFT JOIN devices ON projects.deviceId = devices.deviceId
        ORDER BY projects.displayName
        """,
    )
    fun observeProjects(): Flow<List<ProjectListItem>>

    @Query("SELECT * FROM tasks ORDER BY updatedAt DESC")
    fun observeTasks(): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks WHERE taskId = :taskId")
    fun observeTask(taskId: String): Flow<TaskEntity?>

    @Query("SELECT * FROM plans WHERE taskId = :taskId ORDER BY version")
    fun observePlans(taskId: String): Flow<List<PlanEntity>>

    @Query("SELECT * FROM events WHERE taskId = :taskId ORDER BY serverCursor")
    fun observeEvents(taskId: String): Flow<List<EventEntity>>

    @Query("SELECT * FROM outbox WHERE id = :id")
    fun observeOutbox(id: String): Flow<OutboxEntity?>

    @Query("SELECT * FROM outbox WHERE id = :id")
    suspend fun outbox(id: String): OutboxEntity?

    @Query("SELECT * FROM meta WHERE id = 1")
    fun observeMeta(): Flow<MetaEntity?>

    @Query("SELECT * FROM meta WHERE id = 1")
    suspend fun meta(): MetaEntity?

    @Query("SELECT * FROM plans WHERE planId = :planId")
    suspend fun plan(planId: String): PlanEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertDevices(devices: List<DeviceEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertProjects(projects: List<ProjectEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTasks(tasks: List<TaskEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTask(task: TaskEntity)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertPlanIgnore(plan: PlanEntity)

    @Query(
        """
        UPDATE plans SET taskId = :taskId, version = :version, contentHash = :contentHash,
        createdAt = :createdAt, supersededAt = :supersededAt WHERE planId = :planId
        """,
    )
    suspend fun updatePlanMeta(planId: String, taskId: String, version: Int, contentHash: String, createdAt: String, supersededAt: String?)

    @Query("UPDATE plans SET bodyJson = :bodyJson WHERE planId = :planId")
    suspend fun updatePlanBody(planId: String, bodyJson: String)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertEvents(events: List<EventEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertOutbox(outbox: OutboxEntity)

    @Query("DELETE FROM outbox WHERE id = :id")
    suspend fun deleteOutbox(id: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMeta(meta: MetaEntity)

    @Query("DELETE FROM devices")
    suspend fun clearDevices()

    @Query("DELETE FROM projects")
    suspend fun clearProjects()

    @Query("DELETE FROM tasks WHERE taskId NOT IN (:ids)")
    suspend fun deleteTasksExcept(ids: List<String>)

    @Query("DELETE FROM plans WHERE taskId NOT IN (:ids)")
    suspend fun deletePlansExcept(ids: List<String>)

    @Query("DELETE FROM events WHERE taskId IS NOT NULL AND taskId NOT IN (:ids)")
    suspend fun deleteEventsExcept(ids: List<String>)

    @Query(
        """
        SELECT conversations.id, conversations.title, conversations.kind, conversations.target, conversations.handoffCount,
               conversations.deviceId, conversations.projectId, conversations.taskId AS taskId, tasks.status AS taskStatus,
               conversations.shared, devices.label AS deviceLabel,
               devices.presence AS presence, projects.displayName AS projectName
        FROM conversations
        LEFT JOIN devices ON conversations.deviceId = devices.deviceId
        LEFT JOIN projects ON conversations.projectId = projects.projectId
        LEFT JOIN tasks ON conversations.taskId = tasks.taskId
        WHERE conversations.deleted = 0
        ORDER BY CASE WHEN conversations.target = 'cloud' THEN 0 ELSE 1 END, conversations.title
        """,
    )
    fun observeConversations(): Flow<List<ConversationListItem>>

    @Query(
        """
        SELECT conversations.id, conversations.title, conversations.kind, conversations.target, conversations.handoffCount,
               conversations.deviceId, conversations.projectId, conversations.taskId AS taskId, tasks.status AS taskStatus,
               conversations.shared, devices.label AS deviceLabel,
               devices.presence AS presence, projects.displayName AS projectName
        FROM conversations
        LEFT JOIN devices ON conversations.deviceId = devices.deviceId
        LEFT JOIN projects ON conversations.projectId = projects.projectId
        LEFT JOIN tasks ON conversations.taskId = tasks.taskId
        WHERE conversations.id = :conversationId
        """,
    )
    fun observeConversation(conversationId: String): Flow<ConversationListItem?>

    @Query(
        """
        SELECT * FROM messages WHERE conversationId = :conversationId
        ORDER BY CASE WHEN sequence = 0 THEN 1 ELSE 0 END, sequence
        """,
    )
    fun observeMessages(conversationId: String): Flow<List<MessageEntity>>

    @Query(
        """
        SELECT * FROM chat_runs WHERE conversationId = :conversationId
        ORDER BY CASE WHEN state IN ('completed', 'failed', 'cancelled', 'interrupted') THEN 1 ELSE 0 END, seenAt DESC
        LIMIT 1
        """,
    )
    fun observeLatestChatRun(conversationId: String): Flow<ChatRunEntity?>

    @Query(
        """
        SELECT * FROM chat_runs WHERE conversationId = :conversationId
        AND state NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
        ORDER BY seenAt DESC LIMIT 1
        """,
    )
    suspend fun activeChatRun(conversationId: String): ChatRunEntity?

    @Query("SELECT shared FROM conversations WHERE id = :conversationId")
    suspend fun conversationShared(conversationId: String): Boolean?

    @Query(
        """
        SELECT runId FROM chat_runs WHERE conversationId = :conversationId
        AND state NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
        """,
    )
    suspend fun activeChatRunIds(conversationId: String): List<String>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertConversations(conversations: List<ConversationEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMessages(messages: List<MessageEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertChatRun(run: ChatRunEntity)

    @Query("DELETE FROM conversations WHERE id NOT IN (:ids)")
    suspend fun deleteConversationsExcept(ids: List<String>)

    @Query("DELETE FROM messages WHERE conversationId NOT IN (:ids)")
    suspend fun deleteMessagesExceptConversations(ids: List<String>)

    @Query("DELETE FROM chat_runs WHERE conversationId NOT IN (:ids)")
    suspend fun deleteChatRunsExceptConversations(ids: List<String>)

    @Query("DELETE FROM messages WHERE conversationId = :conversationId")
    suspend fun deleteMessages(conversationId: String)

    @Transaction
    suspend fun replaceConversations(conversations: List<ConversationEntity>) {
        if (conversations.isNotEmpty()) upsertConversations(conversations)
        val ids = conversations.map { it.id }.ifEmpty { listOf("") }
        deleteConversationsExcept(ids)
        deleteMessagesExceptConversations(ids)
        deleteChatRunsExceptConversations(ids)
    }

    @Transaction
    suspend fun replaceMessages(conversationId: String, messages: List<MessageEntity>) {
        deleteMessages(conversationId)
        if (messages.isNotEmpty()) upsertMessages(messages)
    }

    @Query("SELECT * FROM config_docs WHERE kind = :kind ORDER BY name")
    fun observeConfigs(kind: String): Flow<List<ConfigDocEntity>>

    @Query("SELECT * FROM config_docs WHERE id = :id")
    fun observeConfig(id: String): Flow<ConfigDocEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertConfigs(docs: List<ConfigDocEntity>)

    @Query("DELETE FROM config_docs WHERE kind = :kind AND id NOT IN (:ids)")
    suspend fun deleteConfigsExcept(kind: String, ids: List<String>)

    @Transaction
    suspend fun replaceConfigs(kind: String, docs: List<ConfigDocEntity>) {
        if (docs.isNotEmpty()) upsertConfigs(docs)
        deleteConfigsExcept(kind, docs.map { it.id }.ifEmpty { listOf("") })
    }

    @Transaction
    suspend fun replaceDirectory(devices: List<DeviceEntity>, projects: List<ProjectEntity>, tasks: List<TaskEntity>) {
        clearDevices()
        clearProjects()
        if (devices.isNotEmpty()) upsertDevices(devices)
        if (projects.isNotEmpty()) upsertProjects(projects)
        val ids = tasks.map { it.taskId }.ifEmpty { listOf("") }
        if (tasks.isNotEmpty()) upsertTasks(tasks)
        deleteTasksExcept(ids)
        deletePlansExcept(ids)
        deleteEventsExcept(ids)
    }
}

@Database(
    entities = [
        DeviceEntity::class,
        ProjectEntity::class,
        TaskEntity::class,
        PlanEntity::class,
        EventEntity::class,
        OutboxEntity::class,
        MetaEntity::class,
        ConversationEntity::class,
        MessageEntity::class,
        ChatRunEntity::class,
        ConfigDocEntity::class,
    ],
    version = 4,
    exportSchema = false,
)
abstract class TagentDatabase : androidx.room.RoomDatabase() {
    abstract fun dao(): TagentDao
}

val MIGRATION_2_3 = object : androidx.room.migration.Migration(2, 3) {
    override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE conversations ADD COLUMN target TEXT NOT NULL DEFAULT 'mac'")
        db.execSQL("ALTER TABLE conversations ADD COLUMN handoffCount INTEGER NOT NULL DEFAULT 0")
    }
}

val MIGRATION_3_4 = object : androidx.room.migration.Migration(3, 4) {
    override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS config_docs (id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(id))")
    }
}
