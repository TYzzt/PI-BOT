package dev.tagent.android

import dev.tagent.android.data.api.API_JSON
import dev.tagent.android.data.api.ChatRunPublic
import dev.tagent.android.data.api.ConversationPublic
import dev.tagent.android.data.api.MessagePage
import dev.tagent.android.data.api.TagentApi
import dev.tagent.android.domain.QuestionDecision
import dev.tagent.android.domain.assistantLabel
import dev.tagent.android.domain.canHandoff
import dev.tagent.android.domain.chatRunLabel
import dev.tagent.android.domain.conversationSourceLabel
import dev.tagent.android.domain.decideQuestion
import dev.tagent.android.domain.parseServerUrl
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudChatTest {
    private val cloudConversation = """
        {"id":"44444444-4444-4444-8444-444444444444","device_id":null,"version":1,"title":"云端问答","kind":"ask","target":"cloud",
         "model_config_id":"33333333-3333-4333-8333-333333333333","project_id":null,"task_id":null,"shared":true,"share_version":1,"deleted":false,
         "handoff":{"from_conversation_id":"22222222-2222-4222-8222-222222222222","message_count":3}}
    """.trimIndent()

    @Test
    fun cloudDocumentsDecodeWithNullDevice() {
        val conversation = API_JSON.decodeFromString<ConversationPublic>(cloudConversation)
        assertNull(conversation.deviceId)
        assertEquals("cloud", conversation.target)
        assertEquals(3, conversation.handoff?.messageCount)
        val run = API_JSON.decodeFromString<ChatRunPublic>(
            """{"id":"r","device_id":null,"version":2,"conversation_id":"c","message_id":"m","text":"q","state":"failed","share_version":1,"acked":true,"cancel_requested":false,"local_run_id":null,"error":"模型请求失败，请检查云端模型配置后重试"}""",
        )
        assertNull(run.deviceId)
        assertEquals("模型请求失败，请检查云端模型配置后重试", run.error)
        val page = API_JSON.decodeFromString<MessagePage>(
            """{"pending_messages":[],"messages":[{"id":"m","device_id":null,"version":3,"conversation_id":"c","run_id":"r","role":"assistant","content":"部分","status":"running","sequence":2}],"next_cursor":2,"has_more":false}""",
        )
        assertNull(page.messages.single().deviceId)
    }

    @Test
    fun macConversationsStillDefaultToMacTarget() {
        val mac = API_JSON.decodeFromString<ConversationPublic>(
            """{"id":"c","device_id":"d","version":1,"title":"t","kind":"read_code","model_config_id":"m","project_id":"p","task_id":null,"shared":true,"share_version":1,"deleted":false}""",
        )
        assertEquals("mac", mac.target)
        assertNull(mac.handoff)
    }

    @Test
    fun cloudLabelsIgnoreMacPresence() {
        assertEquals("云端问答", conversationSourceLabel("cloud", "ask", null, null))
        assertEquals("云端问答 · 由 Mac 会话转来（3 条）", conversationSourceLabel("cloud", "ask", "MacBook", "offline", 3))
        assertTrue(conversationSourceLabel("mac", "ask", "MacBook", "offline").startsWith("问答 · MacBook"))
        assertEquals("排队，等待云端领取", chatRunLabel("queued", false, "offline", "cloud"))
        assertEquals("排队，等 Mac 恢复", chatRunLabel("queued", false, "offline"))
        assertEquals("云端助手", assistantLabel("cloud"))
        assertEquals("Mac", assistantLabel("mac"))
    }

    @Test
    fun handoffOnlyFromSharedMacConversations() {
        assertTrue(canHandoff("mac", shared = true))
        assertFalse(canHandoff("mac", shared = false))
        assertFalse(canHandoff("cloud", shared = true))
    }

    @Test
    fun cloudQuestionNeedsNetworkButNotMac() {
        assertEquals(QuestionDecision.Send, decideQuestion(online = true, activeRunState = null, shared = true, text = "Mac 关机时也能问"))
    }

    @Test
    fun cloudEndpointsSendDocumentedBodies() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""[{"id":"m1","device_id":null,"version":1,"config":{"name":"DeepSeek","base_url":"https://x/v1","model_id":"deepseek-chat","context_window":64000,"max_tokens":4096,"is_default":true},"has_key":true,"deleted":false,"source_model_id":"s"}]"""))
        server.enqueue(MockResponse().setBody(cloudConversation))
        server.enqueue(MockResponse().setBody(cloudConversation))
        server.start()
        try {
            val api = TagentApi(OkHttpClient())
            val url = parseServerUrl(server.url("/").toString().trimEnd('/'), true)
            val models = api.cloudModels(url, "token")
            assertEquals("deepseek-chat", models.single().config.modelId)
            assertEquals("/cloud/models", server.takeRequest().path)
            api.createCloudConversation(url, "token", "44444444-4444-4444-8444-444444444444", "云端问答", "m1")
            val create = server.takeRequest()
            assertEquals("PUT", create.method)
            assertEquals("/cloud/conversations/44444444-4444-4444-8444-444444444444", create.path)
            val createBody = API_JSON.decodeFromString<JsonObject>(create.body.readUtf8())
            assertEquals("0", createBody["expected_version"]!!.jsonPrimitive.content)
            assertEquals("m1", createBody["model_config_id"]!!.jsonPrimitive.content)
            api.handoff(url, "token", "44444444-4444-4444-8444-444444444444", "22222222-2222-4222-8222-222222222222", "m1", "req")
            val handoff = server.takeRequest()
            assertEquals("/cloud/conversations/44444444-4444-4444-8444-444444444444/handoff-from/22222222-2222-4222-8222-222222222222", handoff.path)
            val body = API_JSON.decodeFromString<JsonObject>(handoff.body.readUtf8())
            assertEquals("req", body["request_id"]!!.jsonPrimitive.content)
            assertEquals("m1", body["model_config_id"]!!.jsonPrimitive.content)
            assertEquals("Bearer token", handoff.getHeader("Authorization"))
        } finally {
            server.shutdown()
        }
    }
}
