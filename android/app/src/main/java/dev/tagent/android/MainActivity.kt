package dev.tagent.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import dev.tagent.android.ui.AppRoot
import dev.tagent.android.ui.TagentTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val repository = (application as TagentApp).repository
        setContent {
            TagentTheme {
                AppRoot(repository)
            }
        }
    }
}
