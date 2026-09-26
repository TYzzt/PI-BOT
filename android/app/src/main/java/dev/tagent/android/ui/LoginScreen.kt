package dev.tagent.android.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.tagent.android.data.TagentRepository
import dev.tagent.android.domain.ActionException
import kotlinx.coroutines.launch
import java.io.IOException

@Composable
fun LoginScreen(repository: TagentRepository) {
    val model = viewModel { LoginViewModel(repository) }
    val savedUrl by repository.baseUrl.collectAsState(initial = "")
    var url by remember(savedUrl) { mutableStateOf(savedUrl.ifBlank { "http://10.0.2.2:8000" }) }
    var password by remember { mutableStateOf("") }
    var permissionError by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val currentUrl by rememberUpdatedState(url)
    val currentPassword by rememberUpdatedState(password)
    val localNetworkPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            permissionError = null
            model.login(currentUrl, currentPassword)
        } else {
            permissionError = "需要允许访问本地网络，才能连接这台电脑"
        }
    }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("登录云端", style = MaterialTheme.typography.headlineMedium)
        Text("用管理员密码换取访问令牌。令牌存在本机加密存储里，过期后需要重新登录。")
        OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("服务器地址") }, singleLine = true)
        OutlinedTextField(
            password,
            { password = it },
            Modifier.fillMaxWidth(),
            label = { Text("管理员密码") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        (permissionError ?: model.error)?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            onClick = {
                permissionError = null
                val needsLocalNetwork = Build.VERSION.SDK_INT >= 37 &&
                    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED
                if (needsLocalNetwork) {
                    localNetworkPermission.launch(Manifest.permission.ACCESS_LOCAL_NETWORK)
                } else {
                    model.login(url, password)
                }
            },
            enabled = !model.busy && password.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (model.busy) "正在登录" else "登录")
        }
    }
}

class LoginViewModel(private val repository: TagentRepository) : ViewModel() {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    fun login(url: String, password: String) {
        if (busy) return
        busy = true
        error = null
        viewModelScope.launch {
            try {
                repository.login(url, password)
            } catch (exception: Exception) {
                error = when (exception) {
                    is ActionException -> exception.message
                    is IllegalArgumentException -> exception.message
                    is IOException -> "连不上服务器"
                    else -> exception.message ?: "登录失败"
                }
            } finally {
                busy = false
            }
        }
    }
}
