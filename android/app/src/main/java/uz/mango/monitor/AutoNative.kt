package uz.mango.monitor

import android.content.Context
import org.json.JSONObject
import java.util.Calendar

/**
 * Automation that must keep working while the UI is closed (it runs inside the background sampler, every ~30 s):
 *  1) pump auto-off timer: N hours after the pump was switched ON (6/12/18/24 or custom), or every day at a set time;
 *  2) weather auto-on: outdoor temperature <= threshold (default -3) and the pump is OFF -> switch it ON.
 * Settings come from the UI through the "dDevices" list (field "auto"); the per-pump state is kept in Store("an_<tuyaId>").
 */
object AutoNative {
    private const val FREEZE_GAP_MS = 10 * 60_000L

    private fun cmd(ctx: Context, tid: String, code: String, value: Boolean): Boolean {
        val body = JSONObject().put("commands", org.json.JSONArray().put(JSONObject().put("code", code).put("value", value))).toString()
        val (_, text) = Tuya.call(ctx, "POST", "/v1.0/devices/$tid/commands", body)
        return try { JSONObject(text).optBoolean("success") } catch (e: Exception) { false }
    }

    /** First moment at or after [after] when the clock shows HH:MM (phone local time). */
    fun nextAt(after: Long, hhmm: String): Long {
        val m = Regex("^(\\d{1,2}):(\\d{2})$").find(hhmm.trim()) ?: return Long.MAX_VALUE
        val c = Calendar.getInstance(); c.timeInMillis = after
        c.set(Calendar.HOUR_OF_DAY, m.groupValues[1].toInt().coerceIn(0, 23)); c.set(Calendar.MINUTE, m.groupValues[2].toInt().coerceIn(0, 59)); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
        if (c.timeInMillis <= after) c.add(Calendar.DAY_OF_YEAR, 1)
        return c.timeInMillis
    }

    /** Returns short event texts (shown in the app's automation log). */
    fun run(ctx: Context, d: JSONObject, st: JSONObject, ok: Boolean, outdoor: Double?, now: Long): List<String> {
        val ev = ArrayList<String>()
        if (!ok || !st.has("switch") || st.isNull("switch")) return ev
        val tid = d.optString("tuya"); if (tid.isEmpty()) return ev
        val auto = d.optJSONObject("auto")
        val key = "an_$tid"
        val state = try { JSONObject(Store.get(ctx, key)) } catch (e: Exception) { JSONObject() }
        val on = st.optBoolean("switch", false)
        val was = state.optBoolean("sw", false); var onSince = state.optLong("onSince", 0)
        if (on) { if (!was || onSince == 0L) onSince = now } else onSince = 0L   // remembered across restarts

        // 1) timer: switch the pump OFF
        val ot = auto?.optJSONObject("offTimer")
        var turnedOff = false
        if (on && ot != null && ot.optBoolean("enabled")) {
            val due = when (ot.optString("mode")) {
                "at" -> now >= nextAt(onSince, ot.optString("at", "06:00"))
                else -> now >= onSince + (ot.optDouble("hours", 6.0).coerceAtLeast(0.1) * 3_600_000).toLong()
            }
            if (due && now - state.optLong("lastTry", 0) > 60_000) {
                state.put("lastTry", now)
                if (cmd(ctx, tid, "switch", false)) { turnedOff = true; onSince = 0; ev.add("switch=false (timer)") }
            }
        }

        // 2) weather: cold and the pump is OFF -> switch it ON
        val wz = auto?.optJSONObject("weather")
        if (!on && !turnedOff && wz != null && wz.optBoolean("enabled") && outdoor != null && !outdoor.isNaN()) {
            val below = wz.optDouble("below", -3.0).let { if (it.isNaN()) -3.0 else it }
            if (outdoor <= below && now - state.optLong("lastFreeze", 0) > FREEZE_GAP_MS) {
                state.put("lastFreeze", now)
                if (cmd(ctx, tid, "switch", true)) { onSince = now; ev.add("freeze_on switch=true (outdoor $outdoor)"); state.put("sw", true) }
            }
        }

        val froze = ev.any { it.startsWith("freeze_on") }
        state.put("sw", if (turnedOff) false else if (froze) true else on).put("onSince", onSince)
        Store.set(ctx, key, state.toString())
        return ev
    }
}
