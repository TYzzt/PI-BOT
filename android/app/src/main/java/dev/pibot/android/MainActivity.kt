package dev.pibot.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import dev.pibot.android.ui.AppRoot
import dev.pibot.android.ui.PiBotTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val repository = (application as PiBotApp).repository
        setContent {
            PiBotTheme {
                AppRoot(repository)
            }
        }
    }
}
