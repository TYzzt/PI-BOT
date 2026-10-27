package dev.pibot.android.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.pibot.android.PiBotApp

class PiBotMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { (application as PiBotApp).push.sync() }
    override fun onMessageReceived(message: RemoteMessage) { (application as PiBotApp).push.receive(message.data) }
}
