package dev.pibot.android.push

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun PushPermissionPrompt(push: PushController) {
    val config by push.configuration.collectAsStateWithLifecycle()
    val restartRequired by push.restartRequired.collectAsStateWithLifecycle()
    var restartDismissed by remember(restartRequired) { mutableStateOf(false) }
    var show by remember(config, restartRequired) {
        mutableStateOf(config?.enabled == true && !restartRequired && push.available &&
            !push.permissionGranted && !push.permissionExplained && Build.VERSION.SDK_INT >= 33)
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { push.sync() }
    fun dismiss() { push.permissionExplained = true; show = false }
    if (restartRequired && !restartDismissed) AlertDialog(
        onDismissRequest = { restartDismissed = true },
        title = { Text("启用当前服务器的通知") },
        text = { Text("通知配置已更新，需要重新启动应用后生效。你也可以稍后在设置中重启。") },
        confirmButton = { TextButton(onClick = push::restart) { Text("重新启动应用") } },
        dismissButton = { TextButton(onClick = { restartDismissed = true }) { Text("稍后") } },
    )
    if (show) AlertDialog(
        onDismissRequest = ::dismiss,
        title = { Text("接收 Bot 通知") },
        text = { Text("允许通知后，离开应用也能收到 Bot 回复、任务结果和待审批提醒。通知包含 Bot 名称和简短摘要。") },
        confirmButton = { TextButton(onClick = { dismiss(); permission.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("允许通知") } },
        dismissButton = { TextButton(onClick = ::dismiss) { Text("暂不开启") } },
    )
}
