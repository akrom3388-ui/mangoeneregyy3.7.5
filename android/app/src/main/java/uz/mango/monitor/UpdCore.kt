package uz.mango.monitor

import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Telegram update channel: pure logic (no Android classes), unit-testable on a plain JVM. */
object UpdCore {
    @JvmField var API = "https://api.telegram.org" // overridable only for tests

    class Info(val version: String, val fileId: String, val fileName: String, val size: Long, val optional: Boolean, val link: String)

    /** "v3.7.0", "MangoMonitor-3.7.0.apk" -> "3.7.0" */
    fun parseVersion(s: String?): String? = s?.let { Regex("(\\d+)\\.(\\d+)\\.(\\d+)").find(it)?.value }

    fun cmp(a: String, b: String): Int {
        val x = a.split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val d = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
            if (d != 0) return d
        }
        return 0
    }

    private fun get(url: String, timeout: Int = 20000): Pair<Int, String> {
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = timeout; c.readTimeout = timeout
            val code = c.responseCode
            val text = (if (code in 200..399) c.inputStream else c.errorStream)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            c.disconnect()
            Pair(code, text)
        } catch (e: Exception) { Pair(0, "") }
    }

    /**
     * Reads the pinned message of the update channel. Returns Pair(info or null, error or null).
     * info == null && error == null  -> nothing is pinned (no update).
     */
    fun latest(token: String, chatId: String): Pair<Info?, String?> {
        val (code, text) = get("$API/bot$token/getChat?chat_id=${java.net.URLEncoder.encode(chatId, "UTF-8")}")
        if (code == 0) return Pair(null, "network")
        val j = try { JSONObject(text) } catch (e: Exception) { return Pair(null, "bad response ($code)") }
        if (!j.optBoolean("ok")) return Pair(null, j.optString("description", "http $code"))
        val chat = j.optJSONObject("result") ?: return Pair(null, null)
        val pin = chat.optJSONObject("pinned_message") ?: return Pair(null, null)
        val doc = pin.optJSONObject("document") ?: return Pair(null, null)
        val name = doc.optString("file_name")
        if (!name.lowercase().endsWith(".apk")) return Pair(null, null)
        val caption = pin.optString("caption")
        val ver = parseVersion(caption) ?: parseVersion(name) ?: return Pair(null, null)
        val opt = Regex("ixtiyoriy|optional|необяз", RegexOption.IGNORE_CASE).containsMatchIn(caption)
        val user = chat.optString("username")
        return Pair(Info(ver, doc.optString("file_id"), name, doc.optLong("file_size"), opt, if (user.isNotEmpty()) "https://t.me/$user" else ""), null)
    }

    /** Tries every chat (id or @username) until one answers: first Info wins; "no pin" beats an error. */
    fun latestAny(token: String, chats: List<String>): Pair<Info?, String?> {
        var err: String? = null; var okNoPin = false
        for (c in chats) {
            val (i, e) = latest(token, c)
            if (i != null) return Pair(i, null)
            if (e == null) okNoPin = true else err = e
        }
        return if (okNoPin) Pair(null, null) else Pair(null, err ?: "no chat")
    }

    private fun obj(text: String): JSONObject? = try { JSONObject(text) } catch (e: Exception) { null }

    /** Human-readable report: token ok? bot in the channel? admin? pinned APK? plus the chats the bot has seen (to find the real id). */
    fun diagnose(token: String, chats: List<String>): String {
        if (token.isBlank()) return "✗ Bot tokeni kiritilmagan"
        val sb = StringBuilder()
        val (c0, t0) = get("$API/bot${token.trim()}/getMe")
        if (c0 == 0) return "✗ Internet yo'q yoki Telegram'ga ulanib bo'lmadi"
        val me = obj(t0)
        if (me == null || !me.optBoolean("ok")) return "✗ Token xato: " + (me?.optString("description") ?: "http $c0") + "\n(BotFather → /mybots → API Token. Token /revoke qilingan bo'lsa, yangisini kiriting)"
        val bot = me.optJSONObject("result") ?: return "✗ Token xato"
        val tk = token.trim()
        sb.append("✓ Bot: @").append(bot.optString("username")).append('\n')
        for (raw in chats) {
            val ch = raw.trim(); if (ch.isEmpty()) continue
            val enc = java.net.URLEncoder.encode(ch, "UTF-8")
            val (_, t) = get("$API/bot$tk/getChat?chat_id=$enc"); val j = obj(t)
            if (j == null || !j.optBoolean("ok")) { sb.append("✗ ").append(ch).append(" → ").append(j?.optString("description") ?: "javob yo'q").append('\n'); continue }
            val r = j.optJSONObject("result") ?: continue
            val user = r.optString("username")
            sb.append("✓ ").append(ch).append(" → ").append(r.optString("title")).append(" (").append(r.optString("type")).append("), id=").append(r.optLong("id")).append(if (user.isNotEmpty()) ", @$user" else ", yopiq").append('\n')
            val (_, tm) = get("$API/bot$tk/getChatMember?chat_id=$enc&user_id=${bot.optLong("id")}"); val jm = obj(tm)
            val st = jm?.optJSONObject("result")?.optString("status") ?: (jm?.optString("description") ?: "?")
            sb.append("   bot holati: ").append(st).append(if (st == "administrator" || st == "creator") "" else "  ← botni kanalga ADMIN qiling").append('\n')
            val pin = r.optJSONObject("pinned_message"); val doc = pin?.optJSONObject("document")
            if (doc != null) sb.append("   pin: ").append(doc.optString("file_name")).append("  ").append(pin.optString("caption")).append('\n')
            else sb.append("   pin: yo'q (APK ni kanalga yuborib, xabarni pin qiling)\n")
        }
        val (cu, tu) = get("$API/bot$tk/getUpdates?limit=100&allowed_updates=" + java.net.URLEncoder.encode("[\"channel_post\",\"message\",\"my_chat_member\"]", "UTF-8")); val ju = obj(tu)
        if (cu != 0 && ju != null && ju.optBoolean("ok")) {
            val seen = LinkedHashMap<Long, String>(); val arr = ju.optJSONArray("result")
            if (arr != null) for (i in 0 until arr.length()) {
                val u = arr.optJSONObject(i) ?: continue
                val chat = (u.optJSONObject("channel_post") ?: u.optJSONObject("message") ?: u.optJSONObject("my_chat_member"))?.optJSONObject("chat") ?: continue
                seen[chat.optLong("id")] = chat.optString("title", chat.optString("username", "")) + (chat.optString("username").let { if (it.isNotEmpty()) " @$it" else "" })
            }
            if (seen.isEmpty()) sb.append("Bot hali hech qaysi chatni ko'rmagan. Kanalga biror xabar yozing va qayta «Tekshirish» ni bosing: to'g'ri ID shu yerda chiqadi.\n")
            else { sb.append("Bot ko'rgan chatlar (ID shu yerdan olinadi):\n"); seen.forEach { (id, n) -> sb.append("  ").append(n).append(" → ").append(id).append('\n') } }
        }
        return sb.toString().trim()
    }

    /** Downloads the APK of [fileId] to [dest] (via a .part file). Returns null on success, or an error text. */
    fun download(token: String, fileId: String, dest: File, expected: Long, progress: (Int) -> Unit): String? {
        val (code, text) = get("$API/bot$token/getFile?file_id=${java.net.URLEncoder.encode(fileId, "UTF-8")}")
        if (code == 0) return "network"
        val j = try { JSONObject(text) } catch (e: Exception) { return "bad response" }
        if (!j.optBoolean("ok")) return j.optString("description", "http $code")
        val path = j.optJSONObject("result")?.optString("file_path").orEmpty()
        if (path.isEmpty()) return "no file path"
        dest.parentFile?.mkdirs()
        val part = File(dest.path + ".part")
        try {
            val c = URL("$API/file/bot$token/$path").openConnection() as HttpURLConnection
            c.connectTimeout = 20000; c.readTimeout = 30000
            if (c.responseCode !in 200..299) { c.disconnect(); return "download http ${c.responseCode}" }
            val total = if (c.contentLengthLong > 0) c.contentLengthLong else expected
            var done = 0L; var last = -1
            c.inputStream.use { inp -> part.outputStream().use { out ->
                val buf = ByteArray(32 * 1024)
                while (true) {
                    val n = inp.read(buf); if (n < 0) break
                    out.write(buf, 0, n); done += n
                    if (total > 0) { val p = (done * 100 / total).toInt().coerceIn(0, 100); if (p != last) { last = p; progress(p) } }
                }
            } }
            c.disconnect()
            if (total > 0 && done < total) { part.delete(); return "incomplete download" }
            if (dest.exists()) dest.delete()
            if (!part.renameTo(dest)) return "cannot save file"
            progress(100)
            return null
        } catch (e: Exception) { part.delete(); return "network" }
    }
}
