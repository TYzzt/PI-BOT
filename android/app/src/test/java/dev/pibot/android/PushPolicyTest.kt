package dev.pibot.android

import dev.pibot.android.data.Session
import dev.pibot.android.data.User
import dev.pibot.android.push.PushEvent
import dev.pibot.android.push.PushLedger
import dev.pibot.android.push.PushRegistrationPolicy
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.util.UUID

class PushPolicyTest {
    private val now = 1_800_000_000_000L
    private val user = UUID.randomUUID().toString()
    private val binding = UUID.randomUUID().toString()
    private val bot = UUID.randomUUID().toString()
    private val message = UUID.randomUUID().toString()
    private val session = Session("https://example.com/pibot", "secret", now + 60000, User(user, "test"), binding)
    private fun payload() = mapOf("event_id" to "message:$message", "kind" to "message", "user_id" to user,
        "binding_id" to binding, "bot_id" to bot, "message_id" to message, "title" to "助手", "body" to "结果",
        "expires_at" to Instant.ofEpochMilli(now + 30000).toString())

    @Test fun validatesPayloadAndRejectsMalformedRouting() {
        assertNotNull(PushEvent.parse(payload()))
        for ((key, value) in mapOf("kind" to "unknown", "bot_id" to "../../settings", "expires_at" to "bad", "event_id" to "different"))
            assertNull(PushEvent.parse(payload() + (key to value)))
        assertNull(PushEvent.parse(payload() - "message_id"))
    }
    @Test fun suppressesOnlyTheVisibleConversationInForeground() {
        val event = PushEvent.parse(payload())!!
        assertFalse(event.shouldNotify(session, true, bot, now))
        assertTrue(event.shouldNotify(session, true, "another", now))
        assertTrue(event.shouldNotify(session, false, bot, now))
        assertTrue(event.shouldNotify(session, true, null, now))
    }
    @Test fun logoutAccountChangeReloginAndExpiredSessionsRejectDeliveryAndClicks() {
        val event = PushEvent.parse(payload())!!
        assertTrue(event.matches(session, now))
        assertFalse(event.matches(null, now))
        assertFalse(event.matches(session.copy(user = User(UUID.randomUUID().toString(), "other")), now))
        assertFalse(event.matches(session.copy(pushBindingId = UUID.randomUUID().toString()), now))
        assertFalse(event.matches(session.copy(expiresAt = now), now))
        assertFalse(event.matches(session, now + 30000))
    }
    @Test fun deduplicatesAcrossRestartsAndBoundsHistory() {
        val event = PushEvent.parse(payload())!!
        val ledger = PushLedger()
        assertTrue(ledger.accept(event, now))
        assertFalse(PushLedger(ledger.entries).accept(event, now))
        assertFalse(ledger.accept(event, now + 30000))
        repeat(600) { ledger.accept(event.copy(eventId = "event-$it"), now) }
        assertEquals(512, ledger.entries.size)
    }
    @Test fun messageNotificationsReplacePerBotAndApprovalsRemainSeparate() {
        val event = PushEvent.parse(payload())!!
        assertEquals(event.notificationTag, event.copy(sourceId = UUID.randomUUID().toString()).notificationTag)
        assertNotEquals(event.notificationTag, event.copy(botId = UUID.randomUUID().toString()).notificationTag)
        val approval = event.copy(kind = "approval")
        assertNotEquals(approval.notificationTag, approval.copy(sourceId = UUID.randomUUID().toString()).notificationTag)
    }
    @Test fun registrationIgnoresOldJobsAndMissingConfigurationAndRetriesOnlyTransientFailures() {
        assertTrue(PushRegistrationPolicy.current(session, binding, true, now))
        assertFalse(PushRegistrationPolicy.current(session, binding, false, now))
        assertFalse(PushRegistrationPolicy.current(null, binding, true, now))
        assertFalse(PushRegistrationPolicy.current(session, UUID.randomUUID().toString(), true, now))
        assertFalse(PushRegistrationPolicy.current(session, binding, true, session.expiresAt))
        for (status in listOf(0, 408, 429, 500, 503)) assertTrue(PushRegistrationPolicy.retry(status))
        for (status in listOf(400, 401, 403, 404, 409, 422)) assertFalse(PushRegistrationPolicy.retry(status))
    }
}
