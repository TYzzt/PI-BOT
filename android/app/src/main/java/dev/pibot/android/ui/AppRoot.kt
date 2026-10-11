package dev.pibot.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.pibot.android.data.PiBotRepository

@Composable
fun AppRoot(repository: PiBotRepository) {
    val session by repository.session.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    val signedIn = session != null
    DisposableEffect(owner, signedIn) {
        val observer = LifecycleEventObserver { _, event ->
            if (!signedIn) return@LifecycleEventObserver
            if (event == Lifecycle.Event.ON_START) repository.startEvents()
            if (event == Lifecycle.Event.ON_STOP) repository.stopEvents()
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    if (!signedIn) LoginScreen(repository) else Signed(repository)
}

@Composable
private fun Signed(repository: PiBotRepository) {
    val nav = rememberNavController()
    NavHost(nav, startDestination = "bots") {
        composable("bots") {
            BotGridScreen(
                repository,
                onOpen = { nav.navigate("bot/$it") },
                onCreate = { nav.navigate("editor/new") },
                onSettings = { nav.navigate("settings") },
            )
        }
        composable("editor/{id}") { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            BotEditorScreen(
                repository,
                botId = id.takeIf { it != "new" },
                onDone = { saved ->
                    nav.popBackStack()
                    if (id == "new" && saved != null) nav.navigate("bot/$saved")
                },
                onArchived = { nav.popBackStack("bots", inclusive = false) },
            )
        }
        composable("bot/{id}") { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            TimelineScreen(
                repository,
                botId = id,
                onBack = { nav.popBackStack() },
                onEdit = { nav.navigate("editor/$id") },
                onFiles = { nav.navigate("files/$id") },
            )
        }
        composable("files/{id}") { entry ->
            FilesScreen(repository, entry.arguments?.getString("id").orEmpty(), onBack = { nav.popBackStack() })
        }
        composable("settings") { SettingsScreen(repository, onBack = { nav.popBackStack() }) }
    }
}
