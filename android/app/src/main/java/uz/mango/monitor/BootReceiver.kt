package uz.mango.monitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        try {
            if (Store.get(ctx, "token").isNotEmpty() || Store.get(ctx, "mode") == "direct") {
                AlertWorker.schedule(ctx)
                if (Store.get(ctx, "service") == "1") StatusService.start(ctx)
            }
        } catch (e: Exception) { /* foreground start may be blocked by the OS; WorkManager still runs */ }
    }
}
