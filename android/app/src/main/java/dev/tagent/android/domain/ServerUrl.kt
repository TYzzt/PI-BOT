package dev.tagent.android.domain

import java.net.URI

data class ServerUrl(val base: String) {
    val eventsSocket: String
        get() {
            val socket = when {
                base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
                base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
                else -> error("服务器地址无效")
            }
            return "$socket/ws/events"
        }
}

fun parseServerUrl(raw: String, allowCleartextLoopback: Boolean): ServerUrl {
    val trimmed = raw.trim().trimEnd('/')
    if (trimmed.isEmpty()) throw IllegalArgumentException("请填写服务器地址")
    val uri = try {
        URI(trimmed)
    } catch (_: Exception) {
        throw IllegalArgumentException("服务器地址无效")
    }
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase()
    if (scheme != "https" && scheme != "http") throw IllegalArgumentException("服务器地址需要以 http 或 https 开头")
    if (host.isNullOrBlank() || uri.userInfo != null) throw IllegalArgumentException("服务器地址无效")
    if (!uri.rawQuery.isNullOrEmpty() || uri.rawFragment != null) throw IllegalArgumentException("服务器地址不能带查询参数")
    val path = uri.path
    if (!path.isNullOrEmpty() && path != "/") throw IllegalArgumentException("服务器地址不要包含路径")
    if (scheme == "http" && !(allowCleartextLoopback && isPrivateCleartextHost(host))) {
        throw IllegalArgumentException("调试构建的明文地址只能是本机、模拟器或局域网")
    }
    return ServerUrl(trimmed)
}

private fun isPrivateCleartextHost(host: String): Boolean {
    if (host == "localhost" || host == "10.0.2.2") return true
    val parts = host.split('.')
    if (parts.size != 4) return false
    val numbers = parts.map { it.toIntOrNull() ?: return false }
    if (numbers.any { it !in 0..255 }) return false
    val first = numbers[0]
    val second = numbers[1]
    return first == 127 || first == 10 || (first == 192 && second == 168) || (first == 172 && second in 16..31)
}
