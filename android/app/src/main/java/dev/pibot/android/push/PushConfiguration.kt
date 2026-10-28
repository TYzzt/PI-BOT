package dev.pibot.android.push

import dev.pibot.android.data.Session
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class FirebaseClientConfig(
    @SerialName("project_id") val projectId: String,
    @SerialName("application_id") val applicationId: String,
    @SerialName("sender_id") val senderId: String,
    @SerialName("api_key") val apiKey: String,
    @SerialName("package_name") val packageName: String,
) {
    fun validate() {
        require(projectId.isNotBlank() && projectId.length <= 128)
        require(senderId.matches(Regex("^[0-9]+$")))
        require(applicationId.matches(Regex("^1:[0-9]+:android:[0-9a-f]+$")))
        require(applicationId.split(':')[1] == senderId)
        require(apiKey.matches(Regex("^A[\\w-]{38}$")))
        require(packageName == "dev.pibot.android")
    }
}

@Serializable
data class PushConfigResponse(val enabled: Boolean, val firebase: FirebaseClientConfig? = null) {
    fun validate() {
        require(enabled == (firebase != null))
        firebase?.validate()
    }
}

/** Public configuration is cached with its login identity, never reused for a different server/account. */
@Serializable
data class CachedPushConfig(val serverUrl: String, val userId: String, val bindingId: String, val config: PushConfigResponse) {
    fun matches(session: Session?, now: Long = System.currentTimeMillis()): Boolean =
        session != null && session.expiresAt > now && session.serverUrl == serverUrl &&
            session.user.id == userId && session.pushBindingId == bindingId
}

/** Firebase's default app is initialized once per process. A project/options change requires a fresh process. */
class PushRuntime(
    private val initialize: (FirebaseClientConfig) -> Unit,
    private val autoInit: (Boolean) -> Unit,
) {
    var activeConfig: FirebaseClientConfig? = null
        private set

    fun configure(config: FirebaseClientConfig?, notificationsAllowed: Boolean): Boolean {
        if (config == null) {
            if (activeConfig != null) autoInit(false)
            return true
        }
        config.validate()
        if (activeConfig != null && activeConfig != config) {
            autoInit(false)
            return false
        }
        if (activeConfig == null) {
            initialize(config)
            activeConfig = config
        }
        autoInit(notificationsAllowed)
        return true
    }
}
