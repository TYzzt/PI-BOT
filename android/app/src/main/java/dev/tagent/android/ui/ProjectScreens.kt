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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.tagent.android.data.TagentRepository
import kotlinx.coroutines.launch
import dev.tagent.android.data.db.ProjectListItem
import dev.tagent.android.domain.availabilityLabel
import dev.tagent.android.domain.presenceLabel

@Composable
fun ProjectListScreen(repository: TagentRepository, onOpen: (String) -> Unit, onLogout: () -> Unit) {
    val projects by repository.observeProjects().collectAsState(initial = emptyList())
    val meta by repository.observeMeta().collectAsState(initial = null)
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("项目", style = MaterialTheme.typography.headlineMedium)
            TextButton(onClick = onLogout) { Text("退出") }
        }
        Text("只显示名称和 Mac 是否在线。点进项目后，在对话里提问或发起计划。", style = MaterialTheme.typography.bodyMedium)
        meta?.let { Text("最近同步 ${formatEpoch(it.lastSyncAt)}", style = MaterialTheme.typography.labelMedium) }
        TextButton(onClick = { scope.launch { runCatching { repository.catchUp() } } }) { Text("刷新") }
        if (projects.isEmpty()) {
            Text("还没有共享项目。在 Mac 上打开云端显示后刷新。", Modifier.padding(top = 24.dp))
        } else {
            LazyColumn {
                items(projects, key = { it.projectId }) { project ->
                    ProjectRow(project, onClick = { onOpen(project.projectId) })
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun ProjectRow(project: ProjectListItem, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 14.dp)) {
        Text(project.displayName, style = MaterialTheme.typography.titleMedium)
        val device = project.label ?: "未知 Mac"
        val revoked = if (project.revokedAt != null) " · 设备已撤销" else ""
        Text("$device · ${presenceLabel(project.presence)} · ${availabilityLabel(project.availability)}$revoked")
    }
}
