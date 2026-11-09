package uz.mango.monitor

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Standalone mode: polls Tuya every ~30 s (from the foreground service, WorkManager fallback or the UI)
 * and appends raw samples to a file. The UI engine (local.js) turns them into kWh/COP/statistics.
 */
object Sampler {
    private val lock = Any()
    private val counters = HashMap<String, Int>()
    private var lastRun = 0L
    private var wAt = 0L
    private var wVal: Double? = null

    private fun file(ctx: Context) = File(ctx.filesDir, "samples.jsonl")

    private fun weather(ctx: Context): Double? {
        val loc = Store.get(ctx, "dLoc").split(",")
        if (loc.size != 2) return null
        if (System.currentTimeMillis() - wAt < 600_000) return wVal
        wAt = System.currentTimeMillis()
        try {
            val c = URL("https://api.open-meteo.com/v1/forecast?latitude=${loc[0]}&longitude=${loc[1]}&current=temperature_2m").openConnection() as HttpURLConnection
            c.connectTimeout = 8000; c.readTimeout = 8000
            val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            c.disconnect()
            wVal = j.getJSONObject("current").getDouble("temperature_2m")
        } catch (e: Exception) { /* keep previous value */ }
        return wVal
    }

    /** One pass over all configured pumps. Rate-limited so several callers cannot double-sample. */
    fun sampleAll(ctx: Context): Boolean {
        synchronized(this) {
            if (System.currentTimeMillis() - lastRun < 20_000) return false
            lastRun = System.currentTimeMillis()
        }
        val list = try { JSONArray(Store.get(ctx, "dDevices")) } catch (e: Exception) { return false }
        if (list.length() == 0) return false
        val w = weather(ctx)
        val now = System.currentTimeMillis()
        // health: remember when background sampling was interrupted (the UI shows a warning)
        val prev = Store.get(ctx, "lastSampleAt").toLongOrNull() ?: 0L
        if (prev > 0 && now - prev > 150_000) { Store.set(ctx, "bgGapMs", (now - prev).toString()); Store.set(ctx, "bgGapAt", now.toString()) }
        Store.set(ctx, "lastSampleAt", now.toString())
        val out = StringBuilder()
        val summary = JSONArray()
        for (i in 0 until list.length()) {
            val d = list.getJSONObject(i)
            val tid = d.getString("tuya")
            var ok = false
            val st = JSONObject()
            var online: Any = JSONObject.NULL
            val (_, text) = Tuya.call(ctx, "GET", "/v1.0/devices/$tid/status", null)
            try {
                val j = JSONObject(text)
                if (j.optBoolean("success")) {
                    ok = true
                    val a = j.getJSONArray("result")
                    for (k in 0 until a.length()) { val o = a.getJSONObject(k); st.put(o.getString("code"), o.get("value")) }
                }
            } catch (e: Exception) { /* leave ok=false */ }
            val n = (counters[tid] ?: 0) + 1
            counters[tid] = n
            if (ok && n % 3 == 1) {
                try {
                    val (_, it2) = Tuya.call(ctx, "GET", "/v1.0/devices/$tid", null)
                    val r = JSONObject(it2)
                    if (r.optBoolean("success") && r.getJSONObject("result").has("online")) online = r.getJSONObject("result").getBoolean("online")
                } catch (e: Exception) { /* ignore */ }
            }
            val line = JSONObject().put("d", tid).put("t", now).put("ok", ok).put("online", online).put("st", st)
            if (w != null && !w.isNaN()) line.put("w", w)
            out.append(line.toString()).append('\n')
            val q = quick(d, st, ok, w)
            summary.put(q)
            try { // timer auto-off / weather auto-on keep working with the UI closed
                val evs = AutoNative.run(ctx, d, st, ok, if (q.has("tamb")) q.optDouble("tamb") else null, now)
                evs.forEach { out.append(JSONObject().put("d", tid).put("t", now).put("ev", "auto").put("info", it).toString()).append('\n') }
            } catch (e: Exception) { /* never break sampling */ }
        }
        synchronized(lock) {
            val f = file(ctx)
            f.appendText(out.toString())
            if (f.length() > 3_000_000L) { // keep the newest part only
                val txt = f.readText(); f.writeText(txt.substring(txt.length - 1_500_000).substringAfter('\n'))
            }
        }
        Store.set(ctx, "summary", JSONObject().put("devices", summary).toString())
        Poller.updateWidgets(ctx)
        return true
    }

    /** Estimated numbers for the notification/widget while the UI is closed. */
    private fun quick(d: JSONObject, st: JSONObject, ok: Boolean, weatherT: Double?): JSONObject {
        val sc = d.optJSONObject("scales") ?: JSONObject()
        val cfg = d.optJSONObject("cfg") ?: JSONObject()
        fun v(code: String): Double? {
            if (!st.has(code) || st.isNull(code)) return null
            val x = st.optDouble(code, Double.NaN)
            return if (x.isNaN()) null else x / Math.pow(10.0, sc.optInt(code, 0).toDouble())
        }
        fun num(k: String): Double? = cfg.optString(k, "").toDoubleOrNull()
        val hzRe = Regex("freq|(^|_)hz($|_)", RegexOption.IGNORE_CASE)
        var hzCode = cfg.optString("hzCode", "")
        if (hzCode.isEmpty()) { val ks = st.keys(); while (ks.hasNext()) { val k = ks.next(); if (hzRe.containsMatchIn(k)) { hzCode = k; break } } }
        val hz: Double? = if (hzCode.isNotEmpty()) v(hzCode)?.let { it * (num("hzMul") ?: 1.0) } else null
        val comp = if (st.has("compressor_state")) st.optBoolean("compressor_state", false) else (hz != null && hz > 0)
        var w = 0.0
        val pc = cfg.optString("powerCode", "")
        val cc = cfg.optString("currCode", "")
        if (pc.isNotEmpty() && st.has(pc)) w = st.optDouble(pc, 0.0) * (num("powerMul") ?: 1.0)
        else if (cc.isNotEmpty() && v(cc) != null && cfg.optString("powerSrc", "") != "hz") {
            val volt = (cfg.optString("voltCode", "").let { if (it.isNotEmpty()) v(it) else null }?.times(num("voltMul") ?: 1.0)) ?: (num("voltage") ?: 380.0)
            val k = if ((num("phases") ?: 3.0) == 1.0) 1.0 else 1.732
            val cos = cfg.optString("cosCode", "").let { if (it.isNotEmpty()) v(it)?.times(num("cosMul") ?: 1.0) else null } ?: (num("pf") ?: 0.9)
            w = v(cc)!! * (num("currMul") ?: 1.0) * volt * k * cos
        } else {
            if (comp) {
                val cw = num("compW") ?: 0.0
                w += if (hz != null && hz > 0) cw * Math.pow(Math.min(hz / (num("ratedHz") ?: num("maxHz") ?: 90.0), 2.0), num("hzExp") ?: 1.0)
                     else cw * (st.optDouble("compressor_strength", 100.0) / 100.0)
            }
            if (st.optBoolean("pump_state", false)) w += num("pumpW") ?: 0.0
            if (st.optBoolean("draught_fan_state", false)) w += num("fanW") ?: 0.0
            if (st.optBoolean("ele_heating_state", false)) w += num("heatW") ?: 0.0
            w *= num("coef") ?: 1.0
        }
        val o = JSONObject().put("id", d.optInt("id")).put("name", d.optString("name")).put("online", ok).put("kw", w / 1000.0).put("comp", comp).put("on", st.optBoolean("switch", false))
        hz?.let { o.put("hz", it) }
        v("temp_current")?.let { o.put("tcur", it) }
        v("temp_set")?.let { o.put("tset", it) }
        // outdoor temperature: pump sensor (configured DP, default temp_outdoor) first, otherwise the Open-Meteo reading
        val tambCode = cfg.optString("tambCode", "").ifEmpty { "temp_outdoor" }
        val tamb: Double? = v(tambCode) ?: v("temp_ambient") ?: (if (weatherT != null && !weatherT.isNaN()) weatherT else null)
        tamb?.let { o.put("tamb", it) }
        return o
    }

    /** Hands all pending samples to the UI engine and clears the file. */
    fun drain(ctx: Context): String {
        synchronized(lock) {
            val f = file(ctx)
            if (!f.exists()) return ""
            val txt = f.readText()
            f.delete()
            return txt
        }
    }
}
