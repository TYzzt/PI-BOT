package dev.pibot.android

import dev.pibot.android.data.API_JSON
import dev.pibot.android.data.Session
import dev.pibot.android.data.User
import dev.pibot.android.push.CachedPushConfig
import dev.pibot.android.push.FirebaseClientConfig
import dev.pibot.android.push.PushConfigResponse
import dev.pibot.android.push.PushRuntime
import org.junit.Assert.*
import org.junit.Test

class PushConfigurationTest {
    private val now = 1_800_000_000_000L
    private val config = FirebaseClientConfig("test-project", "1:123456:android:abcdef", "123456", "A" + "x".repeat(38), "dev.pibot.android")
    private val session = Session("https://one.example/pibot", "bearer", now + 60000, User("user", "test"), "binding")

    @Test fun validatesOnlyCompleteAndroidConfigurations() {
        PushConfigResponse(true, config).validate()
        PushConfigResponse(false).validate()
        for (invalid in listOf(config.copy(senderId = "other"), config.copy(applicationId = "1:999:android:abcdef"),
            config.copy(apiKey = "invalid"), config.copy(packageName = "another.app"), config.copy(projectId = ""))) {
            assertTrue(runCatching { invalid.validate() }.isFailure)
        }
        assertTrue(runCatching { PushConfigResponse(true).validate() }.isFailure)
        assertTrue(runCatching { PushConfigResponse(false, config).validate() }.isFailure)
    }

    @Test fun cachedConfigurationNeverFollowsAnotherServerAccountOrLogin() {
        val cached = CachedPushConfig(session.serverUrl, session.user.id, session.pushBindingId, PushConfigResponse(true, config))
        assertTrue(cached.matches(session, now))
        assertFalse(cached.matches(null, now))
        assertFalse(cached.matches(session.copy(serverUrl = "https://two.example/pibot"), now))
        assertFalse(cached.matches(session.copy(user = User("another", "other")), now))
        assertFalse(cached.matches(session.copy(pushBindingId = "new-login"), now))
        assertFalse(cached.matches(session, session.expiresAt))
    }

    @Test fun processRecoveryInitializesFromCachedOptionsWithoutNetwork() {
        val cached = CachedPushConfig(session.serverUrl, session.user.id, session.pushBindingId, PushConfigResponse(true, config))
        val json = API_JSON.encodeToString(CachedPushConfig.serializer(), cached)
        assertFalse(json.contains("bearer"))
        val restored = API_JSON.decodeFromString(CachedPushConfig.serializer(), json)
        var initialized: FirebaseClientConfig? = null
        val runtime = PushRuntime({ initialized = it }, {})
        assertTrue(restored.matches(session, now))
        assertTrue(runtime.configure(restored.config.firebase, true))
        assertEquals(config, initialized)
    }

    @Test fun sameProjectIsReusedAcrossLoginsAndLogoutDisablesAutomaticTokenRegistration() {
        var initializations = 0
        val automatic = mutableListOf<Boolean>()
        val runtime = PushRuntime({ initializations++ }, { automatic.add(it) })
        assertTrue(runtime.configure(config, true))
        assertTrue(runtime.configure(null, false))
        assertTrue(runtime.configure(config, false))
        assertTrue(runtime.configure(config, true))
        assertEquals(1, initializations)
        assertEquals(listOf(true, false, false, true), automatic)
    }

    @Test fun differentProjectWaitsForRestartAndNeverHotReplacesTheDefaultApp() {
        val initialized = mutableListOf<FirebaseClientConfig>()
        val automatic = mutableListOf<Boolean>()
        val runtime = PushRuntime({ initialized.add(it) }, { automatic.add(it) })
        val other = config.copy(projectId = "other-project", senderId = "654321", applicationId = "1:654321:android:abc123")
        assertTrue(runtime.configure(config, true))
        assertFalse(runtime.configure(other, true))
        assertEquals(listOf(config), initialized)
        assertEquals(listOf(true, false), automatic)
        val restarted = PushRuntime({ initialized.add(it) }, {})
        assertTrue(restarted.configure(other, true))
        assertEquals(listOf(config, other), initialized)
    }

    @Test fun keyRotationAlsoRequiresNewOptionsAndReturningToTheActiveProjectDoesNot() {
        val runtime = PushRuntime({}, {})
        assertTrue(runtime.configure(config, true))
        assertFalse(runtime.configure(config.copy(apiKey = "A" + "y".repeat(38)), true))
        assertTrue(runtime.configure(config, true))
    }
}
