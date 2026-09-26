package dev.tagent.android

import androidx.sqlite.db.SupportSQLiteDatabase
import dev.tagent.android.data.api.API_JSON
import dev.tagent.android.data.api.ConfigReason
import dev.tagent.android.data.api.DeviceConfigState
import dev.tagent.android.data.api.McpConfig
import dev.tagent.android.data.api.McpEnv
import dev.tagent.android.data.api.SkillConfig
import dev.tagent.android.data.api.SkillFile
import dev.tagent.android.data.api.SkillPublic
import dev.tagent.android.data.api.SkillRequires
import dev.tagent.android.data.api.TagentApi
import dev.tagent.android.data.db.ConfigDocEntity
import dev.tagent.android.data.db.MIGRATION_3_4
import dev.tagent.android.domain.deviceStatusLine
import dev.tagent.android.domain.parseServerUrl
import dev.tagent.android.domain.splitList
import dev.tagent.android.domain.validateMcp
import dev.tagent.android.domain.validateSkill
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Proxy

class ConfigRulesTest {
    private val skill = SkillConfig(
        name = "video", content = "# Video", files = listOf(SkillFile("scripts/clip.sh", "ffmpeg")),
        requires = SkillRequires(commands = listOf("ffmpeg"), scripts = listOf("scripts/clip.sh")), installHint = "brew install ffmpeg",
    )
    private val skillJson = """
        {"id":"55555555-5555-4555-8555-555555555555","version":3,"content_hash":"${"a".repeat(64)}","deleted":false,
         "devices":[{"device_id":"66666666-6666-4666-8666-666666666666","label":"MacBook","state":"unavailable","checked_version":3,
           "reasons":[{"code":"command_missing","detail":"ffmpeg"}],"applied_version":2,"applied_hash":"${"b".repeat(64)}","checked_at":"2026-09-26T00:00:00Z"}],
         "config":{"name":"video","description":"","content":"# Video","files":[],"runtime":"mac","enabled":true,
           "requires":{"commands":["ffmpeg"],"platforms":["darwin"],"scripts":[],"mcp":[]},"install_hint":"brew install ffmpeg"}}
    """.trimIndent()

    @Test
    fun skillValidationMirrorsServerRules() {
        assertNull(validateSkill(skill))
        assertNotNull(validateSkill(skill.copy(name = "bad name")))
        assertNotNull(validateSkill(skill.copy(content = " ")))
        assertNotNull(validateSkill(skill.copy(files = listOf(SkillFile("../x", "")))))
        assertNotNull(validateSkill(skill.copy(files = listOf(SkillFile("/etc/x", "")))))
        assertNotNull(validateSkill(skill.copy(files = listOf(SkillFile("SKILL.md", "")))))
        assertNotNull(validateSkill(skill.copy(requires = SkillRequires(commands = listOf("rm -rf")))))
        assertNotNull(validateSkill(skill.copy(requires = SkillRequires(scripts = listOf("missing.sh")))))
        assertNotNull(validateSkill(skill.copy(files = (1..6).map { SkillFile("f$it", "x".repeat(200_000)) })))
        assertEquals(listOf("ffmpeg", "pdftotext", "jq"), splitList("ffmpeg，pdftotext, jq "))
    }

    @Test
    fun mcpValidationRejectsPlaintextSecrets() {
        val mcp = McpConfig(name = "github", command = "github-mcp", env = listOf(McpEnv("GITHUB_TOKEN", secretRef = "github-token"), McpEnv("LEVEL", value = "info")))
        assertNull(validateMcp(mcp))
        assertTrue(validateMcp(mcp.copy(env = listOf(McpEnv("GITHUB_TOKEN", value = "ghp_x"))))!!.contains("secret"))
        assertNotNull(validateMcp(mcp.copy(env = listOf(McpEnv("A", value = "x", secretRef = "y")))))
        assertNotNull(validateMcp(mcp.copy(command = null)))
        assertNotNull(validateMcp(mcp.copy(transport = "http", command = null, url = "https://u:p@example.com/mcp")))
        assertNull(validateMcp(mcp.copy(transport = "http", command = null, url = "https://example.com/mcp")))
        assertNotNull(validateMcp(mcp.copy(timeoutMs = 10)))
    }

    @Test
    fun deviceStatusShowsLatestAppliedAndReasons() {
        val d = DeviceConfigState("d", "MacBook", "unavailable", 3, listOf(ConfigReason("command_missing", "ffmpeg")), 2)
        assertEquals("MacBook：v3 最新 / v2 生效 · 不可用 · 缺少命令 ffmpeg", deviceStatusLine(d, 3))
        assertEquals("Mac：v1 最新 / 未生效 · 待检查", deviceStatusLine(DeviceConfigState("d", "", "pending"), 1))
    }

    @Test
    fun apiDecodesServerDocumentsAndSendsExpectedVersion() {
        val decoded = API_JSON.decodeFromString<SkillPublic>(skillJson)
        assertEquals(2, decoded.devices.single().appliedVersion)
        assertEquals("brew install ffmpeg", decoded.config.installHint)
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(skillJson))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"detail":{"message":"版本冲突","current":null}}"""))
        server.start()
        try {
            val api = TagentApi(OkHttpClient())
            val url = parseServerUrl(server.url("/").toString().trimEnd('/'), true)
            api.putSkill(url, "token", decoded.id, 2, "req-1", skill)
            val request = server.takeRequest()
            assertEquals("PUT", request.method)
            assertEquals("/configs/skills/${decoded.id}", request.path)
            val body = API_JSON.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals("2", body["expected_version"]!!.jsonPrimitive.content)
            val config = body["config"]!!.jsonObject
            assertEquals("brew install ffmpeg", config["install_hint"]!!.jsonPrimitive.content)
            assertEquals("scripts/clip.sh", config["requires"]!!.jsonObject["scripts"]!!.jsonArray.single().jsonPrimitive.content)
            val error = runCatching { api.putMcp(url, "token", decoded.id, 1, "req-2", McpConfig(name = "x", command = "y", env = listOf(McpEnv("T", secretRef = "s")))) }.exceptionOrNull()
            assertEquals(409, (error as dev.tagent.android.data.api.ApiException).status)
            val env = API_JSON.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject["config"]!!.jsonObject["env"]!!.jsonArray.single().jsonObject
            assertEquals(JsonNull, env["value"]); assertEquals("s", env["secret_ref"]!!.jsonPrimitive.content)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun migrationCreatesTableMatchingEntity() {
        val sql = mutableListOf<String>()
        val db = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SupportSQLiteDatabase::class.java)) { _, method, args ->
            if (method.name == "execSQL") sql += args[0] as String
            null
        } as SupportSQLiteDatabase
        MIGRATION_3_4.migrate(db)
        assertEquals(3, MIGRATION_3_4.startVersion); assertEquals(4, MIGRATION_3_4.endVersion)
        val create = sql.single()
        assertTrue(create.startsWith("CREATE TABLE IF NOT EXISTS config_docs"))
        val columns = ConfigDocEntity::class.java.declaredFields.filter { !java.lang.reflect.Modifier.isStatic(it.modifiers) }.map { it.name }
        assertEquals(listOf("id", "kind", "name", "version", "json"), columns)
        columns.forEach { assertTrue(it, create.contains("$it ${if (it == "version") "INTEGER" else "TEXT"} NOT NULL")) }
        assertTrue(create.contains("PRIMARY KEY(id)"))
    }
}
