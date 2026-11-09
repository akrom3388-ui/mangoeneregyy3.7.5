package uz.mango.monitor

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews
import org.json.JSONObject

class WidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        render(ctx, mgr, ids)
        Thread { try { Poller.pollOnce(ctx.applicationContext) } catch (e: Exception) { /* ignore */ } }.start()
    }

    companion object {
        fun render(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
            val j = try { JSONObject(Store.get(ctx, "summary")) } catch (e: Exception) { null }
            val (title, text) = Poller.statusText(ctx, j)
            for (id in ids) {
                val v = RemoteViews(ctx.packageName, R.layout.widget)
                v.setTextViewText(R.id.w_title, title)
                v.setTextViewText(R.id.w_text, text)
                v.setOnClickPendingIntent(R.id.w_root, Poller.openApp(ctx))
                mgr.updateAppWidget(id, v)
            }
        }
    }
}
