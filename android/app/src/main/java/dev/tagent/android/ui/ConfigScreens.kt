package dev.tagent.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.tagent.android.data.TagentRepository
import dev.tagent.android.data.api.API_JSON
import dev.tagent.android.data.api.DeviceConfigState
import dev.tagent.android.data.api.McpConfig
import dev.tagent.android.data.api.McpEnv
import dev.tagent.android.data.api.McpServerPublic
import dev.tagent.android.data.api.SkillConfig
import dev.tagent.android.data.api.SkillFile
import dev.tagent.android.data.api.SkillPublic
import dev.tagent.android.data.api.SkillRequires
import dev.tagent.android.data.db.ConfigDocEntity
import dev.tagent.android.domain.ActionException
import dev.tagent.android.domain.KIND_MCP
import dev.tagent.android.domain.KIND_SKILL
import dev.tagent.android.domain.deviceStatusLine
import dev.tagent.android.domain.runtimeLabel
import dev.tagent.android.domain.splitList
import kotlinx.coroutines.launch

private data class ConfigSummary(val id: String, val name: String, val version: Int, val runtime: String, val enabled: Boolean, val devices: List<DeviceConfigState>)

private fun ConfigDocEntity.summary(): ConfigSummary? = runCatching {
    if (kind == KIND_SKILL) API_JSON.decodeFromString<SkillPublic>(json).let { ConfigSummary(it.id, it.config.name, it.version, it.config.runtime, it.config.enabled, it.devices) }
    else API_JSON.decodeFromString<McpServerPublic>(json).let { ConfigSummary(it.id, it.config.name, it.version, it.config.runtime, it.config.enabled, it.devices) }
}.getOrNull()

@Composable
fun ConfigListScreen(repository: TagentRepository, onOpen: (kind: String, id: String) -> Unit) {
    var kind by remember { mutableStateOf(KIND_SKILL) }
    val docs by repository.observeConfigs(kind).collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var notice by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Skills 与 MCP", style = MaterialTheme.typography.headlineMedium)
            TextButton(onClick = { scope.launch { notice = runCatching { repository.refreshConfigs() }.exceptionOrNull()?.let { "刷新失败：${it.message}" } } }) { Text("刷新") }
        }
        Text("配置保存在云端，手机和 Mac 都能修改。Mac 只检查依赖，不会自动安装。", style = MaterialTheme.typography.bodyMedium)
        Row(Modifier.padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Toggle("Skills", kind == KIND_SKILL) { kind = KIND_SKILL }
            Toggle("MCP", kind == KIND_MCP) { kind = KIND_MCP }
        }
        OutlinedButton(onClick = { onOpen(kind, "new") }, modifier = Modifier.fillMaxWidth()) { Text(if (kind == KIND_SKILL) "新建 Skill" else "新建 MCP") }
        notice?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        val items = docs.mapNotNull { it.summary() }
        if (items.isEmpty()) {
            Text("还没有配置。", Modifier.padding(top = 24.dp))
        } else {
            LazyColumn {
                items(items, key = { it.id }) { item ->
                    Column(Modifier.fillMaxWidth().clickable { onOpen(kind, item.id) }.padding(vertical = 14.dp)) {
                        Text(item.name + if (item.enabled) "" else "（已停用）", style = MaterialTheme.typography.titleMedium)
                        Text("v${item.version} · ${runtimeLabel(item.runtime)}", style = MaterialTheme.typography.bodySmall)
                        DeviceLines(item.devices, item.version)
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun DeviceLines(devices: List<DeviceConfigState>, version: Int) {
    if (devices.isEmpty()) Text("还没有 Mac 检查过此配置", style = MaterialTheme.typography.bodySmall)
    devices.forEach { d ->
        val bad = d.state == "unavailable" || d.state == "failed"
        Text(deviceStatusLine(d, version), style = MaterialTheme.typography.bodySmall, color = if (bad) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun Toggle(label: String, selected: Boolean, onClick: () -> Unit) {
    if (selected) Button(onClick = onClick) { Text(label) } else OutlinedButton(onClick = onClick) { Text(label) }
}

@Composable
fun ConfigEditScreen(repository: TagentRepository, kind: String, id: String, onBack: () -> Unit) {
    val isNew = id == "new"
    val doc by repository.observeConfig(if (isNew) "" else id).collectAsState(initial = null)
    val skill = remember(doc?.json) { doc?.takeIf { it.kind == KIND_SKILL }?.let { runCatching { API_JSON.decodeFromString<SkillPublic>(it.json) }.getOrNull() } }
    val mcp = remember(doc?.json) { doc?.takeIf { it.kind == KIND_MCP }?.let { runCatching { API_JSON.decodeFromString<McpServerPublic>(it.json) }.getOrNull() } }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    val version = skill?.version ?: mcp?.version ?: 0
    val skillForm = remember { SkillForm() }
    val mcpForm = remember { McpForm() }
    LaunchedEffect(version) { skill?.let { skillForm.load(it.config) }; mcp?.let { mcpForm.load(it.config) } }
    fun run(action: suspend () -> Unit) {
        busy = true
        message = null
        scope.launch { try { action() } catch (e: ActionException) { message = e.message } finally { busy = false } }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("返回") }
            Text(if (isNew) (if (kind == KIND_SKILL) "新建 Skill" else "新建 MCP") else "编辑 v$version", style = MaterialTheme.typography.titleLarge)
        }
        if (!isNew) DeviceLines(skill?.devices ?: mcp?.devices.orEmpty(), version)
        skill?.config?.installHint?.let { Text("安装提示（Mac 不会自动执行）：\n$it", style = MaterialTheme.typography.bodySmall) }
        if (kind == KIND_SKILL) SkillFields(skillForm) else McpFields(mcpForm)
        message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = {
            run {
                if (kind == KIND_SKILL) repository.saveSkill(if (isNew) null else id, version, skillForm.build())
                else repository.saveMcp(if (isNew) null else id, version, mcpForm.build())
                if (isNew) onBack() else message = "已保存，Mac 会同步新版本并重新检查依赖"
            }
        }) { Text(if (busy) "处理中" else "保存") }
        if (!isNew) OutlinedButton(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { confirmDelete = true }) { Text("删除") }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("删除配置") },
            text = { Text("所有设备都会移除它。") },
            confirmButton = { TextButton(onClick = { confirmDelete = false; run { repository.deleteConfig(kind, id, version); onBack() } }) { Text("删除") } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("取消") } },
        )
    }
}

private class SkillForm {
    var name by mutableStateOf("")
    var description by mutableStateOf("")
    var content by mutableStateOf("")
    var runtime by mutableStateOf("mac")
    var enabled by mutableStateOf(true)
    var commands by mutableStateOf("")
    var platforms by mutableStateOf(setOf<String>())
    var scripts by mutableStateOf("")
    var mcp by mutableStateOf("")
    var installHint by mutableStateOf("")
    val files = mutableStateListOf<SkillFile>()
    fun load(c: SkillConfig) {
        name = c.name; description = c.description; content = c.content; runtime = c.runtime; enabled = c.enabled
        commands = c.requires.commands.joinToString(", "); platforms = c.requires.platforms.toSet(); scripts = c.requires.scripts.joinToString(", ")
        mcp = c.requires.mcp.joinToString(", "); installHint = c.installHint.orEmpty(); files.clear(); files.addAll(c.files)
    }
    fun build() = SkillConfig(
        name.trim(), description, content, files.toList(), runtime, enabled,
        SkillRequires(splitList(commands), platforms.toList(), splitList(scripts), splitList(mcp)), installHint.ifBlank { null },
    )
}

private class McpForm {
    var name by mutableStateOf("")
    var transport by mutableStateOf("stdio")
    var command by mutableStateOf("")
    var args by mutableStateOf("")
    var url by mutableStateOf("")
    var timeout by mutableStateOf("30000")
    var runtime by mutableStateOf("mac")
    var enabled by mutableStateOf(true)
    var disabledTools by mutableStateOf("")
    val env = mutableStateListOf<McpEnv>()
    fun load(c: McpConfig) {
        name = c.name; transport = c.transport; command = c.command.orEmpty(); args = c.args.joinToString("\n"); url = c.url.orEmpty()
        timeout = c.timeoutMs.toString(); runtime = c.runtime; enabled = c.enabled; disabledTools = c.disabledTools.joinToString(", "); env.clear(); env.addAll(c.env)
    }
    fun build(): McpConfig {
        val stdio = transport == "stdio"
        return McpConfig(
            name.trim(), transport, if (stdio) command.trim() else null, if (stdio) args.lines().filter { it.isNotBlank() } else emptyList(),
            if (stdio) null else url.trim(), timeout.toIntOrNull() ?: 0, env.toList(), runtime, enabled, splitList(disabledTools),
        )
    }
}

@Composable
private fun RuntimeAndEnabled(runtime: String, enabled: Boolean, onRuntime: (String) -> Unit, onEnabled: (Boolean) -> Unit) {
    Text("运行环境")
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        listOf("mac" to "Mac", "cloud" to "云端", "both" to "两者").forEach { (value, label) -> Toggle(label, runtime == value) { onRuntime(value) } }
    }
    Row(verticalAlignment = Alignment.CenterVertically) { Switch(checked = enabled, onCheckedChange = onEnabled); Text("  启用") }
}

@Composable
private fun SkillFields(f: SkillForm) {
    OutlinedTextField(f.name, { f.name = it }, label = { Text("名称") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
    OutlinedTextField(f.description, { f.description = it }, label = { Text("说明") }, modifier = Modifier.fillMaxWidth())
    RuntimeAndEnabled(f.runtime, f.enabled, { f.runtime = it }, { f.enabled = it })
    OutlinedTextField(f.content, { f.content = it }, label = { Text("SKILL.md") }, modifier = Modifier.fillMaxWidth(), minLines = 6)
    Text("包内文件（Mac 上只作为文本保存，不可执行）", style = MaterialTheme.typography.titleSmall)
    f.files.forEachIndexed { i, file ->
        OutlinedTextField(file.path, { f.files[i] = file.copy(path = it) }, label = { Text("路径") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(file.content, { f.files[i] = file.copy(content = it) }, label = { Text("内容") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
        TextButton(onClick = { f.files.removeAt(i) }) { Text("移除文件") }
    }
    TextButton(onClick = { f.files.add(SkillFile("", "")) }) { Text("添加文件") }
    Text("依赖声明（Mac 只检查，不安装）", style = MaterialTheme.typography.titleSmall)
    OutlinedTextField(f.commands, { f.commands = it }, label = { Text("系统命令，逗号分隔") }, modifier = Modifier.fillMaxWidth())
    Text("平台（都不选表示不限）")
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        listOf("darwin", "linux", "win32").forEach { p -> Toggle(p, p in f.platforms) { f.platforms = if (p in f.platforms) f.platforms - p else f.platforms + p } }
    }
    OutlinedTextField(f.scripts, { f.scripts = it }, label = { Text("脚本（须在包内文件中）") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(f.mcp, { f.mcp = it }, label = { Text("依赖的 MCP") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(f.installHint, { f.installHint = it }, label = { Text("安装提示（仅展示，不会执行）") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
}

@Composable
private fun McpFields(f: McpForm) {
    OutlinedTextField(f.name, { f.name = it }, label = { Text("名称") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
    RuntimeAndEnabled(f.runtime, f.enabled, { f.runtime = it }, { f.enabled = it })
    Text("连接方式")
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Toggle("stdio", f.transport == "stdio") { f.transport = "stdio" }
        Toggle("HTTP", f.transport == "http") { f.transport = "http" }
    }
    if (f.transport == "stdio") {
        OutlinedTextField(f.command, { f.command = it }, label = { Text("命令（Mac 只检查是否存在，不会启动）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(f.args, { f.args = it }, label = { Text("参数，每行一个") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
    } else {
        OutlinedTextField(f.url, { f.url = it }, label = { Text("URL") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
    }
    OutlinedTextField(f.timeout, { f.timeout = it.filter(Char::isDigit) }, label = { Text("超时（毫秒）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
    Text("环境变量（密钥只能填 secret 名称，值在 Mac 上设置）", style = MaterialTheme.typography.titleSmall)
    f.env.forEachIndexed { i, e ->
        val secret = e.secretRef != null
        OutlinedTextField(e.name, { f.env[i] = e.copy(name = it) }, label = { Text("变量名") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = secret, onCheckedChange = { f.env[i] = if (it) e.copy(value = null, secretRef = "") else e.copy(value = "", secretRef = null) })
            Text("  secret 引用")
        }
        OutlinedTextField(e.secretRef ?: e.value.orEmpty(), { f.env[i] = if (secret) e.copy(secretRef = it) else e.copy(value = it) }, label = { Text(if (secret) "secret 名称" else "值") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        TextButton(onClick = { f.env.removeAt(i) }) { Text("移除变量") }
    }
    TextButton(onClick = { f.env.add(McpEnv("", null, "")) }) { Text("添加环境变量") }
    OutlinedTextField(f.disabledTools, { f.disabledTools = it }, label = { Text("停用的工具，逗号分隔") }, modifier = Modifier.fillMaxWidth())
}
