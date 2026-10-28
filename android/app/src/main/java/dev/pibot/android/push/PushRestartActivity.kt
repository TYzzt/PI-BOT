package dev.pibot.android.push

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Process
import dev.pibot.android.MainActivity

/** A separate process relaunches the main process with the cached default Firebase options. */
class PushRestartActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val previousPid = intent.getIntExtra("previous_pid", -1)
        if (previousPid > 0 && previousPid != Process.myPid()) Process.killProcess(previousPid)
        startActivity(Intent.makeRestartActivityTask(ComponentName(this, MainActivity::class.java)))
        finish()
    }

    companion object {
        fun isRestartProcess(context: Context): Boolean {
            val name = if (Build.VERSION.SDK_INT >= 28) Application.getProcessName()
            else context.getSystemService(ActivityManager::class.java).runningAppProcesses
                ?.firstOrNull { it.pid == Process.myPid() }?.processName
            return name == "${context.packageName}:push_restart"
        }

        fun restart(context: Context) {
            context.startActivity(Intent(context, PushRestartActivity::class.java)
                .putExtra("previous_pid", Process.myPid()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
