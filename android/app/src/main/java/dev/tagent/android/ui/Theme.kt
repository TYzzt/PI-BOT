package dev.tagent.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Pine = Color(0xFF1F4E4A)
private val Sand = Color(0xFFF4F1EA)
private val Ink = Color(0xFF1C1B19)

@Composable
fun TagentTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) {
        darkColorScheme(primary = Color(0xFF8FCCC4), background = Color(0xFF121413), surface = Color(0xFF1C1F1E))
    } else {
        lightColorScheme(primary = Pine, onPrimary = Color.White, background = Sand, surface = Color.White, onBackground = Ink, onSurface = Ink)
    }
    MaterialTheme(colorScheme = colors, content = content)
}
