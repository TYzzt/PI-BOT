@file:Suppress("DEPRECATION")

package dev.pibot.android.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Signed-in session: server URL, bearer token and user, kept in encrypted preferences. */
data class Session(val serverUrl: String, val token: String, val expiresAt: Long, val user: User)

interface SessionStorage {
    fun load(): Session?
    fun save(session: Session)
    fun clear()
    fun lastServerUrl(): String?
}

class SessionStore(context: Context) : SessionStorage {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context.applicationContext,
        "pibot.session",
        MasterKey.Builder(context.applicationContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    override fun load(): Session? {
        val token = prefs.getString(TOKEN, null) ?: return null
        val expires = prefs.getLong(EXPIRES, 0)
        if (expires <= System.currentTimeMillis() + 60_000) return null
        val user = runCatching { API_JSON.decodeFromString(User.serializer(), prefs.getString(USER, null)!!) }.getOrNull() ?: return null
        return Session(prefs.getString(URL, null) ?: return null, token, expires, user)
    }

    override fun save(session: Session) {
        prefs.edit()
            .putString(URL, session.serverUrl)
            .putString(TOKEN, session.token)
            .putLong(EXPIRES, session.expiresAt)
            .putString(USER, API_JSON.encodeToString(User.serializer(), session.user))
            .apply()
    }

    override fun clear() {
        prefs.edit().remove(TOKEN).remove(EXPIRES).remove(USER).apply()
    }

    override fun lastServerUrl(): String? = prefs.getString(URL, null)

    private companion object {
        const val URL = "server_url"
        const val TOKEN = "access_token"
        const val EXPIRES = "expires_at"
        const val USER = "user"
    }
}
