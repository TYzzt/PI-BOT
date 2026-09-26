package dev.tagent.android.domain

import dev.tagent.android.data.api.ConfigReason
import dev.tagent.android.data.api.DeviceConfigState
import dev.tagent.android.data.api.McpConfig
import dev.tagent.android.data.api.SkillConfig

const val KIND_SKILL = "skill"
const val KIND_MCP = "mcp_server"
const val CONFIG_CONFLICT = "配置已被其他端修改，已刷新为最新版本，请重新编辑"

private val NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
private val COMMAND = Regex("^[A-Za-z0-9._+-]{1,64}$")
private val ENV_NAME = Regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$")
private val SECRET_LIKE = Regex("KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL", RegexOption.IGNORE_CASE)
private const val MAX_PACKAGE = 1024 * 1024

fun splitList(text: String): List<String> = text.split(',', '，', ' ', '\n').map { it.trim() }.filter { it.isNotEmpty() }

fun validPackagePath(path: String): Boolean =
    path.isNotEmpty() && path.length <= 200 && !path.startsWith("/") && !path.contains('\\') && path != "SKILL.md" &&
        path.split('/').all { it.isNotEmpty() && it != "." && it != ".." }

/** Mirrors the server rules so obvious mistakes are caught before a round trip; returns null when valid. */
fun validateSkill(config: SkillConfig): String? {
    if (!NAME.matches(config.name)) return "名称只能包含字母、数字、点、下划线和连字符"
    if (config.content.isBlank()) return "SKILL.md 不能为空"
    if (config.files.size > 20) return "包内文件最多 20 个"
    config.files.firstOrNull { !validPackagePath(it.path) }?.let { return "文件路径无效：${it.path}" }
    if (config.files.map { it.path }.toSet().size != config.files.size) return "文件路径重复"
    if (config.content.toByteArray().size + config.files.sumOf { it.content.toByteArray().size } > MAX_PACKAGE) return "技能包超过 1MB"
    config.requires.commands.firstOrNull { !COMMAND.matches(it) }?.let { return "命令名只能是单个可执行文件名：$it" }
    config.requires.scripts.firstOrNull { s -> config.files.none { it.path == s } }?.let { return "声明的脚本不在包内文件中：$it" }
    config.requires.mcp.firstOrNull { !NAME.matches(it) }?.let { return "MCP 名称无效：$it" }
    return null
}

fun validateMcp(config: McpConfig): String? {
    if (!NAME.matches(config.name)) return "名称只能包含字母、数字、点、下划线和连字符"
    if (config.transport == "stdio" && config.command.isNullOrBlank()) return "stdio 需要填写命令"
    if (config.transport == "http") {
        val url = config.url.orEmpty()
        if (!(url.startsWith("https://") || url.startsWith("http://"))) return "HTTP 需要填写 http(s) URL"
        if (url.substringAfter("://").substringBefore('/').contains('@')) return "URL 不能包含账号密码"
    }
    if (config.timeoutMs !in 1000..600000) return "超时需在 1000 到 600000 毫秒之间"
    config.env.forEach { env ->
        if (!ENV_NAME.matches(env.name)) return "环境变量名无效：${env.name}"
        if ((env.value == null) == (env.secretRef == null)) return "${env.name} 需在明文值与 secret 引用中二选一"
        if (env.secretRef != null && !NAME.matches(env.secretRef)) return "secret 名称无效：${env.secretRef}"
        if (env.value != null && SECRET_LIKE.containsMatchIn(env.name)) return "${env.name} 疑似密钥，请改用 secret 引用（值只保存在 Mac Keychain）"
    }
    if (config.env.map { it.name }.toSet().size != config.env.size) return "环境变量重复"
    return null
}

fun configStateLabel(state: String): String = when (state) {
    "available" -> "可用"
    "unavailable" -> "不可用"
    "not_applicable" -> "不在此设备运行"
    "failed" -> "应用失败"
    else -> "待检查"
}

fun runtimeLabel(runtime: String): String = when (runtime) {
    "cloud" -> "仅云端（云端暂未加载）"
    "both" -> "Mac 与云端"
    else -> "仅 Mac"
}

fun reasonLabel(reason: ConfigReason): String = when (reason.code) {
    "command_missing" -> "缺少命令 ${reason.detail}"
    "platform_unsupported" -> "平台不支持：${reason.detail}"
    "script_missing" -> "缺少脚本 ${reason.detail}"
    "mcp_missing" -> "依赖的 MCP「${reason.detail}」不存在"
    "mcp_unavailable" -> "依赖的 MCP 不可用：${reason.detail}"
    "secret_missing" -> "Mac 缺少 secret「${reason.detail}」"
    "write_failed" -> "写入本地技能目录失败"
    else -> "配置无效：${reason.detail}"
}

/** One line per device, e.g. "MacBook：v3 最新 / v2 生效 · 不可用 · 缺少命令 ffmpeg". */
fun deviceStatusLine(device: DeviceConfigState, latest: Int): String {
    val applied = if (device.appliedVersion > 0) "v${device.appliedVersion} 生效" else "未生效"
    val reasons = device.reasons.joinToString("；") { reasonLabel(it) }
    return "${device.label.ifBlank { "Mac" }}：v$latest 最新 / $applied · ${configStateLabel(device.state)}" + if (reasons.isEmpty()) "" else " · $reasons"
}
