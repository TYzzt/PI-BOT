package dev.tagent.android

import dev.tagent.android.data.api.API_JSON
import dev.tagent.android.data.api.TagentApi
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import dev.tagent.android.domain.parseServerUrl

class TagentApiTest {
    private val task = """
        {"task_id":"11111111-1111-1111-1111-111111111111","project_id":"22222222-2222-2222-2222-222222222222","target_device_id":"33333333-3333-3333-3333-333333333333","requirement":"修复登录","status":"queued","cancel_requested":false,"cancel_requested_at":null,"latest_plan_id":null,"device_presence":"online","created_at":"2026-09-26T00:00:00Z","updated_at":"2026-09-26T00:00:00Z","plans":[],"runs":[]}
    """.trim()

    @Test
    fun createTaskPostsTheSameIdempotencyKeyOnRetry() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(task))
        server.enqueue(MockResponse().setBody(task))
        server.start()
        try {
            val api = TagentApi(OkHttpClient())
            val url = parseServerUrl(server.url("/").toString().trimEnd('/'), true)
            api.createTask(url, "token", "22222222-2222-2222-2222-222222222222", "修复登录", "same-key")
            api.createTask(url, "token", "22222222-2222-2222-2222-222222222222", "修复登录", "same-key")
            val first = body(server)
            val second = body(server)
            assertEquals(first, second)
            assertEquals("same-key", first["idempotency_key"]!!.jsonPrimitive.content)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun approveBodyCarriesVersionAndHash() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"approval_id":"a","run_id":"b","version":2,"content_hash":"${"ab".repeat(32)}"}"""))
        server.start()
        try {
            val api = TagentApi(OkHttpClient())
            val url = parseServerUrl(server.url("/").toString().trimEnd('/'), true)
            val hash = "ab".repeat(32)
            api.approve(url, "token", "plan-1", 2, hash, "approve-key")
            val recorded = server.takeRequest()
            assertEquals("Bearer token", recorded.getHeader("Authorization"))
            assertTrue(recorded.path!!.endsWith("/plans/plan-1/approve"))
            val json = API_JSON.parseToJsonElement(recorded.body.readUtf8()) as JsonObject
            assertEquals("2", json["version"]!!.jsonPrimitive.content)
            assertEquals(hash, json["content_hash"]!!.jsonPrimitive.content)
            assertEquals("approve-key", json["idempotency_key"]!!.jsonPrimitive.content)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun conflictStaysAClientError() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"detail":"幂等键已用于其他请求"}"""))
        server.start()
        try {
            val api = TagentApi(OkHttpClient())
            val url = parseServerUrl(server.url("/").toString().trimEnd('/'), true)
            val error = runCatching {
                api.createTask(url, "token", "22222222-2222-2222-2222-222222222222", "另一段需求", "same-key")
            }.exceptionOrNull()
            val apiError = error as dev.tagent.android.data.api.ApiException
            assertEquals(409, apiError.status)
            assertEquals("幂等键已用于其他请求", apiError.message)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun sendMessagePostsTheSameRequestIdOnRetry() {
        val run = chatRun("queued")
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(run))
        server.enqueue(MockResponse().setBody(run))
        server.start()
        try {
            val api = TagentApi(OkHttpClient())
            val url = parseServerUrl(server.url("/").toString().trimEnd('/'), true)
            val conversationId = "44444444-4444-4444-4444-444444444444"
            api.sendMessage(url, "token", conversationId, "继续解释这个问题", "same-request")
            api.sendMessage(url, "token", conversationId, "继续解释这个问题", "same-request")
            val first = body(server)
            val second = body(server)
            assertEquals(first, second)
            assertEquals("same-request", first["request_id"]!!.jsonPrimitive.content)
            assertEquals("继续解释这个问题", first["text"]!!.jsonPrimitive.content)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun cancelChatRunUsesTheChatRunPath() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(chatRun("cancelled")))
        server.start()
        try {
            val api = TagentApi(OkHttpClient())
            val url = parseServerUrl(server.url("/").toString().trimEnd('/'), true)
            val runId = "55555555-5555-5555-5555-555555555555"
            val result = api.cancelChatRun(url, "token", runId)
            val recorded = server.takeRequest()
            assertEquals("Bearer token", recorded.getHeader("Authorization"))
            assertTrue(recorded.path!!.endsWith("/chat-runs/$runId/cancel"))
            assertEquals("cancelled", result.state)
        } finally {
            server.shutdown()
        }
    }

    private fun chatRun(state: String) = """
        {"id":"55555555-5555-5555-5555-555555555555","device_id":"33333333-3333-3333-3333-333333333333","version":1,"conversation_id":"44444444-4444-4444-4444-444444444444","message_id":"66666666-6666-6666-6666-666666666666","text":"继续解释这个问题","state":"$state","share_version":1,"acked":false,"cancel_requested":false,"local_run_id":null}
    """.trim()

    private fun body(server: MockWebServer): JsonObject {
        val recorded = server.takeRequest()
        return API_JSON.parseToJsonElement(recorded.body.readUtf8()) as JsonObject
    }
}
