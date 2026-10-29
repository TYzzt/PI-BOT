package dev.pibot.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pibot.android.BuildConfig
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.face.PiBotFace
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(repository: PiBotRepository) {
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(repository.lastServerUrl() ?: BuildConfig.DEFAULT_SERVER_URL) }
    var editServer by remember { mutableStateOf(false) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var mood by remember { mutableStateOf("happy") }

    fun submit() {
        if (busy || username.isBlank() || password.isEmpty()) return
        busy = true
        error = null
        mood = "thinking"
        scope.launch {
            try {
                repository.login(server, username, password)
            } catch (e: Exception) {
                error = errorText(e)
                mood = "error"
            } finally {
                busy = false
            }
        }
    }

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Spacer(Modifier.height(32.dp))
        PiBotFace(ORANGE, mood, 150.dp)
        Text("Pi Bot", fontSize = 28.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text("你的 Bot 们在电脑上干活，手机随时找它们。", color = Muted, textAlign = TextAlign.Center)
        Spacer(Modifier.height(28.dp))
        OutlinedTextField(
            username, { username = it; if (mood == "error") mood = "idle" },
            label = { Text("用户名") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            password, { password = it; if (mood == "error") mood = "idle" },
            label = { Text("密码") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.fillMaxWidth(),
        )
        if (editServer) {
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                server, { server = it },
                label = { Text("服务器地址") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            TextButton(onClick = { editServer = true }) { Text("服务器：${server.removePrefix("https://")}", color = Muted, fontSize = 13.sp) }
        }
        error?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = Danger, textAlign = TextAlign.Center)
        }
        Spacer(Modifier.height(16.dp))
        Button(onClick = ::submit, enabled = !busy && username.isNotBlank() && password.isNotEmpty(), modifier = Modifier.fillMaxWidth().height(50.dp)) {
            if (busy) CircularProgressIndicator(Modifier.height(20.dp), strokeWidth = 2.dp) else Text("登录", fontSize = 16.sp)
        }
        Spacer(Modifier.height(12.dp))
        Text("账号由管理员在后台创建。", color = Muted, fontSize = 12.sp)
        Spacer(Modifier.height(32.dp))
    }
}
