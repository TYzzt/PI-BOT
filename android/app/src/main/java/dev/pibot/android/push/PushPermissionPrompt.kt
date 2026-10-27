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

@Composable
fun PushPermissionPrompt(push: PushController) {
    var show by remember { mutableStateOf(push.available && !push.permissionGranted && !push.permissionExplained && Build.VERSION.SDK_INT >= 33) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { push.sync() }
    fun dismiss() { push.permissionExplained = true; show = false }
    if (show) AlertDialog(
        onDismissRequest = ::dismiss,
        title = { Text("接收 Bot 通知") },
        text = { Text("允许通知后，离开应用也能收到 Bot 回复、任务结果和待审批提醒。通知包含 Bot 名称和简短摘要。") },
        confirmButton = { TextButton(onClick = { dismiss(); permission.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("允许通知") } },
        dismissButton = { TextButton(onClick = ::dismiss) { Text("暂不开启") } },
    )
}
