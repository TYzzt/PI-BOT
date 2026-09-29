package dev.tagent.android.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.tagent.android.data.TagentRepository

@Composable
fun AppRoot(repository: TagentRepository) {
    val loggedIn by repository.loggedIn.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, loggedIn) {
        val observer = LifecycleEventObserver { _, event ->
            if (!loggedIn) return@LifecycleEventObserver
            if (event == Lifecycle.Event.ON_START) repository.startForegroundSync()
            if (event == Lifecycle.Event.ON_STOP) repository.stopForegroundSync()
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    if (!loggedIn) {
        LoginScreen(repository)
    } else {
        MainScaffold(repository)
    }
}

@Composable
private fun MainScaffold(repository: TagentRepository) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val tabs = route == "projects" || route == "chats" || route == "configs"
    Scaffold(
        bottomBar = {
            if (tabs) {
                NavigationBar {
                    NavigationBarItem(
                        selected = route == "projects",
                        onClick = { nav.navigate("projects") { popUpTo(nav.graph.findStartDestination().id) { saveState = true }; launchSingleTop = true; restoreState = true } },
                        label = { Text("项目") },
                        icon = { Icon(Icons.Filled.Menu, contentDescription = null) },
                    )
                    NavigationBarItem(
                        selected = route == "chats",
                        onClick = { nav.navigate("chats") { popUpTo(nav.graph.findStartDestination().id) { saveState = true }; launchSingleTop = true; restoreState = true } },
                        label = { Text("聊天") },
                        icon = { Icon(Icons.Filled.Email, contentDescription = null) },
                    )
                    NavigationBarItem(
                        selected = route == "configs",
                        onClick = { nav.navigate("configs") { popUpTo(nav.graph.findStartDestination().id) { saveState = true }; launchSingleTop = true; restoreState = true } },
                        label = { Text("配置") },
                        icon = { Icon(Icons.Filled.Settings, contentDescription = null) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(nav, startDestination = "projects", modifier = Modifier.padding(padding)) {
            composable("projects") { ProjectListScreen(repository, onOpen = { nav.navigate("project/$it") }, onLogout = { repository.logout() }) }
            composable("project/{projectId}") { entry ->
                ProjectChatsScreen(repository, entry.arguments?.getString("projectId").orEmpty(), onOpen = { nav.navigate("chat/$it") }, onBack = { nav.popBackStack() })
            }
            composable("chats") { ChatListScreen(repository, onOpen = { nav.navigate("chat/$it") }) }
            composable("configs") { ConfigListScreen(repository, onOpen = { kind, id -> nav.navigate("config/$kind/$id") }) }
            composable("config/{kind}/{id}") { entry ->
                ConfigEditScreen(repository, entry.arguments?.getString("kind").orEmpty(), entry.arguments?.getString("id").orEmpty(), onBack = { nav.popBackStack() })
            }
            composable("chat/{conversationId}") { entry ->
                ChatScreen(repository, entry.arguments?.getString("conversationId").orEmpty(), onBack = { nav.popBackStack() })
            }
        }
    }
}
