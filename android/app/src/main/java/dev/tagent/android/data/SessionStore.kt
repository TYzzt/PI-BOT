@file:Suppress("DEPRECATION")

package dev.tagent.android.data

import android.content.Context
import android.content.SharedPreferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dev.tagent.android.domain.ServerUrl
import dev.tagent.android.domain.parseServerUrl
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.settingsStore by preferencesDataStore(name = "tagent-settings")

class SessionStore(context: Context) {
    private val app = context.applicationContext
    private val prefs: SharedPreferences
    private val loggedInState: MutableStateFlow<Boolean>

    init {
        val masterKey = MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        prefs = EncryptedSharedPreferences.create(
            app,
            "tagent.session",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        loggedInState = MutableStateFlow(readToken() != null)
    }

    val loggedIn: StateFlow<Boolean> = loggedInState
    val baseUrl: Flow<String> = app.settingsStore.data.map { it[URL] ?: "" }

    suspend fun setBaseUrl(url: String) {
        app.settingsStore.edit { it[URL] = url }
    }

    suspend fun currentUrl(allowCleartextLoopback: Boolean): ServerUrl? {
        val raw = app.settingsStore.data.first()[URL]
        if (raw.isNullOrBlank()) return null
        return parseServerUrl(raw, allowCleartextLoopback)
    }

    fun token(): String? = readToken()

    fun saveToken(token: String, expiresInSeconds: Long) {
        prefs.edit()
            .putString(TOKEN, token)
            .putLong(EXPIRES, System.currentTimeMillis() + expiresInSeconds * 1000)
            .apply()
        loggedInState.value = true
    }

    fun clearToken() {
        prefs.edit().remove(TOKEN).remove(EXPIRES).apply()
        loggedInState.value = false
    }

    private fun readToken(): String? {
        val token = prefs.getString(TOKEN, null) ?: return null
        val expires = prefs.getLong(EXPIRES, 0)
        if (expires <= System.currentTimeMillis() + 30_000) return null
        return token
    }

    private companion object {
        const val TOKEN = "access_token"
        const val EXPIRES = "expires_at"
        val URL = stringPreferencesKey("base_url")
    }
}
