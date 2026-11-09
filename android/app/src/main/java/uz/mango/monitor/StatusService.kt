package uz.mango.monitor

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/** Foreground service: persistent status-bar notification + near-real-time alert delivery. */
class StatusService : Service() {
    @Volatile private var running = false
    private var worker: Thread? = null

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Poller.ensureChannels(this)
        val n = build(null)
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(Poller.NOTIF_STATUS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else startForeground(Poller.NOTIF_STATUS, n)
        } catch (e: Exception) { stopSelf(); return START_NOT_STICKY }
        if (!running) {
            running = true
            worker = Thread {
                while (running) {
                    val ctx = applicationContext
                    val direct = Store.get(ctx, "mode") == "direct"
                    val j: JSONObject? = if (direct) {
                        try { Sampler.sampleAll(ctx) } catch (e: Exception) { /* ignore */ }
                        try { JSONObject(Store.get(ctx, "summary")) } catch (e: Exception) { null }
                    } else {
                        val r = Poller.pollOnce(ctx)
                        if (Store.get(ctx, "token").isEmpty()) { stopSelf(); break }
                        r
                    }
                    try {
                        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                        nm.notify(Poller.NOTIF_STATUS, build(j))
                    } catch (e: Exception) { /* ignore */ }
                    try { Thread.sleep(if (direct) 30_000L else 45_000L) } catch (e: InterruptedException) { break }
                }
            }.also { it.isDaemon = true; it.start() }
        }
        return START_STICKY
    }

    private fun build(j: JSONObject?): android.app.Notification {
        val (title, text) = Poller.statusText(this, j)
        return NotificationCompat.Builder(this, Poller.CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(Poller.openApp(this))
            .build()
    }

    override fun onDestroy() { running = false; worker?.interrupt(); super.onDestroy() }

    companion object {
        fun start(ctx: Context) { ContextCompat.startForegroundService(ctx, Intent(ctx, StatusService::class.java)) }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, StatusService::class.java)) }
    }
}
