package uz.mango.monitor

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

object Poller {
    const val CH_ALERT = "mm_alerts_quiet" // v3.5: new channel id, because a channel's sound cannot be changed after it was created
    private const val CH_ALERT_OLD = "mm_alerts"
    const val CH_STATUS = "mm_status"
    const val NOTIF_STATUS = 1001

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        try { nm.deleteNotificationChannel(CH_ALERT_OLD) } catch (e: Exception) { /* ignore */ }
        // alerts: no sound, no vibration (still shown in the notification shade / as a banner)
        nm.createNotificationChannel(NotificationChannel(CH_ALERT, ctx.getString(R.string.ch_alerts), NotificationManager.IMPORTANCE_HIGH).apply {
            setSound(null, null); enableVibration(false); vibrationPattern = null
        })
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, ctx.getString(R.string.ch_status), NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
    }

    /** "New version" notice (silent, like the other alerts). */
    fun notifyUpdate(ctx: Context, version: String) {
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return
        ensureChannels(ctx)
        val lang = Store.get(ctx, "lang").ifEmpty { "uz" }
        val title = when (lang) { "ru" -> "Вышла новая версия v$version"; "en" -> "New version v$version"; else -> "Yangi versiya v$version chiqdi" }
        val body = when (lang) { "ru" -> "Откройте приложение и обновите его, чтобы продолжить."; "en" -> "Open the app and update to keep using it."; else -> "Davom etish uchun ilovani oching va yangilang." }
        val n = NotificationCompat.Builder(ctx, CH_ALERT).setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setSound(null).setVibrate(null).setSilent(true).setAutoCancel(true).setContentIntent(openApp(ctx)).build()
        try { NotificationManagerCompat.from(ctx).notify(3000, n) } catch (e: SecurityException) { /* no permission */ }
    }

    fun openApp(ctx: Context): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** One poll: fetch summary, post new alerts, cache for the widget. Returns summary or null. */
    @Synchronized
    fun pollOnce(ctx: Context): JSONObject? {
        if (Store.get(ctx, "token").isEmpty()) return null
        ensureChannels(ctx)
        val last = Store.get(ctx, "lastAlert").ifEmpty { "-1" }
        val lang = Store.get(ctx, "lang").ifEmpty { "uz" }
        val (code, body) = Net.call(ctx, "GET", "/api/summary?since=$last&lang=$lang", null)
        if (code == 401) { Store.set(ctx, "token", ""); return null }
        if (code != 200) return null
        val j = try { JSONObject(body) } catch (e: Exception) { return null }
        val alerts = j.optJSONArray("alerts")
        if (alerts != null && Store.get(ctx, "alertNotif") != "0" && NotificationManagerCompat.from(ctx).areNotificationsEnabled()) {
            for (i in 0 until alerts.length()) {
                val a = alerts.getJSONObject(i)
                val n = NotificationCompat.Builder(ctx, CH_ALERT)
                    .setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle(a.optString("title"))
                    .setContentText(a.optString("body"))
                    .setStyle(NotificationCompat.BigTextStyle().bigText(a.optString("body")))
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setSound(null).setVibrate(null).setSilent(true)
                    .setAutoCancel(true)
                    .setContentIntent(openApp(ctx))
                    .build()
                try { NotificationManagerCompat.from(ctx).notify(2000 + a.optInt("id"), n) } catch (e: SecurityException) { /* no permission */ }
            }
        }
        Store.set(ctx, "lastAlert", j.optInt("maxAlert", 0).toString())
        Store.set(ctx, "summary", body)
        updateWidgets(ctx)
        return j
    }

    fun statusText(ctx: Context, j: JSONObject?): Pair<String, String> {
        val devs = j?.optJSONArray("devices")
        if (devs == null || devs.length() == 0) return Pair(ctx.getString(R.string.app_name), "—")
        val sb = StringBuilder()
        var kw = 0.0
        for (i in 0 until devs.length()) {
            val d = devs.getJSONObject(i)
            kw += d.optDouble("kw", 0.0)
            if (i < 2) {
                if (sb.isNotEmpty()) sb.append("  |  ")
                sb.append(d.optString("name")).append(": ")
                if (!d.optBoolean("online")) sb.append(ctx.getString(R.string.offline))
                else sb.append(fmt(d.opt("tcur"))).append("° → ").append(fmt(d.opt("tset"))).append("°")
            }
        }
        // outdoor temperature (first device that reports one) – shown in the notification and the widget
        for (i in 0 until devs.length()) {
            val ta = devs.getJSONObject(i).opt("tamb")
            if (ta is Number) { sb.append("  |  ").append(ctx.getString(R.string.outdoor)).append(": ").append(fmt(ta)).append("°"); break }
        }
        val first = devs.getJSONObject(0)
        val title = String.format("%.2f kW · %s", kw, if (first.optBoolean("comp")) ctx.getString(R.string.comp_on) else ctx.getString(R.string.comp_off))
        return Pair(title, sb.toString())
    }

    private fun fmt(v: Any?): String = if (v is Number) String.format("%.1f", v.toDouble()) else "—"

    fun updateWidgets(ctx: Context) {
        val mgr = AppWidgetManager.getInstance(ctx)
        val ids = mgr.getAppWidgetIds(ComponentName(ctx, WidgetProvider::class.java))
        if (ids.isNotEmpty()) WidgetProvider.render(ctx, mgr, ids)
    }
}
