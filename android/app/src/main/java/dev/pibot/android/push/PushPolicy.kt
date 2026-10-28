package dev.pibot.android.push

import dev.pibot.android.data.Session
import java.time.Instant
import java.util.UUID

/** Framework-free validation shared by delivery and notification clicks. */
data class PushEvent(
    val eventId: String, val kind: String, val userId: String, val bindingId: String,
    val botId: String, val sourceId: String, val title: String, val body: String, val expiresAt: Long,
) {
    fun matches(session: Session?, now: Long = System.currentTimeMillis()): Boolean =
        session != null && session.expiresAt > now && session.user.id == userId && session.pushBindingId == bindingId && expiresAt > now

    fun shouldNotify(session: Session?, foreground: Boolean, visibleBotId: String?, now: Long = System.currentTimeMillis()): Boolean =
        matches(session, now) && !(foreground && visibleBotId == botId)

    val notificationTag: String get() = if (kind == "message") "push:message:$botId" else "push:approval:$botId:$sourceId"

    companion object {
        fun parse(data: Map<String, String>): PushEvent? = runCatching {
            val kind = data.getValue("kind").also { require(it == "message" || it == "approval") }
            fun id(key: String) = data.getValue(key).also { require(UUID.fromString(it).toString() == it) }
            val source = id(if (kind == "message") "message_id" else "approval_id")
            val eventId = data.getValue("event_id").also { require(it == "$kind:$source") }
            PushEvent(eventId, kind, id("user_id"), id("binding_id"), id("bot_id"), source,
                data.getValue("title").take(160), data.getValue("body").take(240), Instant.parse(data.getValue("expires_at")).toEpochMilli())
        }.getOrNull()
    }
}

/** A bounded, expiring ledger; persistence is supplied by PushController. */
class PushLedger(entries: Map<String, Long> = emptyMap()) {
    val entries = entries.toMutableMap()
    fun accept(event: PushEvent, now: Long): Boolean {
        entries.entries.removeAll { it.value <= now }
        if (event.eventId in entries || event.expiresAt <= now) return false
        entries[event.eventId] = event.expiresAt
        while (entries.size > 512) entries.remove(entries.keys.first())
        return true
    }
}

object PushRegistrationPolicy {
    fun current(session: Session?, binding: String?, available: Boolean, now: Long): Boolean =
        available && session != null && session.expiresAt > now && session.pushBindingId == binding
    fun retry(httpStatus: Int): Boolean = httpStatus == 0 || httpStatus == 408 || httpStatus == 429 || httpStatus >= 500
}
