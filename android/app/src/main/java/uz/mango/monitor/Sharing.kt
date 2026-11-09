package uz.mango.monitor

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Pure crypto / signing of the Tuya "device sharing" API (no Android classes, so it can be unit-tested on a plain JVM). */
object ShCrypto {
    private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private const val NONCE_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
    private val rnd = SecureRandom()

    fun b64(d: ByteArray): String {
        val sb = StringBuilder()
        var i = 0
        while (i < d.size) {
            val b0 = d[i].toInt() and 0xff
            val b1 = if (i + 1 < d.size) d[i + 1].toInt() and 0xff else 0
            val b2 = if (i + 2 < d.size) d[i + 2].toInt() and 0xff else 0
            sb.append(B64[b0 shr 2]).append(B64[((b0 and 3) shl 4) or (b1 shr 4)])
            sb.append(if (i + 1 < d.size) B64[((b1 and 15) shl 2) or (b2 shr 6)] else '=')
            sb.append(if (i + 2 < d.size) B64[b2 and 63] else '=')
            i += 3
        }
        return sb.toString()
    }

    fun unb64(s: String): ByteArray {
        val clean = s.trim().trimEnd('=')
        val out = java.io.ByteArrayOutputStream()
        var buf = 0
        var bits = 0
        for (ch in clean) {
            val v = B64.indexOf(ch)
            if (v < 0) continue
            buf = (buf shl 6) or v
            bits += 6
            if (bits >= 8) { bits -= 8; out.write((buf shr bits) and 0xff) }
        }
        return out.toByteArray()
    }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
    fun md5hex(s: String): String = hex(MessageDigest.getInstance("MD5").digest(s.toByteArray(Charsets.UTF_8)))
    fun hmacHex(key: ByteArray, msg: ByteArray): String {
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(key, "HmacSHA256"))
        return hex(m.doFinal(msg))
    }

    /** AES key (16 ascii chars) used to encrypt/decrypt one request. */
    fun secret(rid: String, hashKey: String): String = hmacHex(rid.toByteArray(Charsets.UTF_8), hashKey.toByteArray(Charsets.UTF_8)).substring(0, 16)

    fun nonce(): String { val sb = StringBuilder(); repeat(12) { sb.append(NONCE_CHARS[rnd.nextInt(NONCE_CHARS.length)]) }; return sb.toString() }

    /** base64(nonce) + base64(ciphertext||tag), exactly like the official SDK. */
    fun encrypt(raw: String, secret: String, nonce: String = nonce()): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "AES"), GCMParameterSpec(128, nonce.toByteArray(Charsets.UTF_8)))
        return b64(nonce.toByteArray(Charsets.UTF_8)) + b64(c.doFinal(raw.toByteArray(Charsets.UTF_8)))
    }

    fun decrypt(data: String, secret: String): String {
        val all = unb64(data)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "AES"), GCMParameterSpec(128, all.copyOfRange(0, 12)))
        return String(c.doFinal(all, 12, all.size - 12), Charsets.UTF_8)
    }

    /** X-sign header. Empty header values (X-sid) are skipped, like in the SDK. */
    fun sign(hashKey: String, queryEnc: String, bodyEnc: String, appKey: String, rid: String, time: String, token: String): String {
        val sb = StringBuilder()
        listOf("X-appKey" to appKey, "X-requestId" to rid, "X-sid" to "", "X-time" to time, "X-token" to token).forEach { (k, v) -> if (v.isNotEmpty()) sb.append(k).append('=').append(v).append("||") }
        var s = sb.toString(); if (s.length >= 2) s = s.substring(0, s.length - 2)
        s += queryEnc + bodyEnc
        return hmacHex(hashKey.toByteArray(Charsets.UTF_8), s.toByteArray(Charsets.UTF_8))
    }
}

/**
 * Serverless Smart Life login ("device sharing", the same mechanism Home Assistant uses):
 * the person types the User Code from the Smart Life app and scans a QR code; no Access ID / Secret / developer account.
 * After login the normal Tuya calls of the app (/v1.0/devices/...) are translated to the sharing API here.
 */
object Sharing {
    const val CLIENT_ID = "HA_3y9q4ak7g4ephrvke"
    const val SCHEMA = "haauthorize"
    @JvmField var LOGIN = "https://apigw.iotbing.com" // overridable only for tests
    private val detailCache = HashMap<String, Pair<Long, JSONObject>>()

    private fun ok(result: Any): Pair<Int, String> = Pair(200, JSONObject().put("success", true).put("result", result).toString())
    private fun fail(code: Int, msg: String): Pair<Int, String> = Pair(code, JSONObject().put("success", false).put("msg", msg).toString())
    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    /** Plain HTTP (login endpoints, no signing). */
    private fun plain(method: String, url: String, body: String?, headers: Map<String, String> = emptyMap()): Pair<Int, String> {
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.requestMethod = method
            c.connectTimeout = 15000
            c.readTimeout = 25000
            headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
            if (method != "GET") {
                c.doOutput = true
                if (body != null) c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write((body ?: "").toByteArray(Charsets.UTF_8)) }
            }
            val code = c.responseCode
            val stream = if (code in 200..399) c.inputStream else c.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            c.disconnect()
            Pair(code, text)
        } catch (e: Exception) { Pair(0, "") }
    }

    private fun tok(ctx: Context): JSONObject? = try { JSONObject(Store.get(ctx, "shTok")) } catch (e: Exception) { null }
    private fun endpoint(ctx: Context): String = Store.get(ctx, "shEnd").trim().trimEnd('/').ifEmpty { LOGIN }

    /** One signed + encrypted request. Returns the decrypted response JSON, or null on network error. */
    private fun req(ctx: Context, method: String, path: String, params: JSONObject?, body: JSONObject?, refresh: Boolean = true): JSONObject? {
        if (refresh) refreshIfNeeded(ctx)
        val t = tok(ctx) ?: return null
        val rid = java.util.UUID.randomUUID().toString()
        val access = t.optString("access_token")
        val hashKey = ShCrypto.md5hex(rid + t.optString("refresh_token"))
        val secret = ShCrypto.secret(rid, hashKey)
        var q = ""; var b = ""
        if (params != null && params.length() > 0) q = ShCrypto.encrypt(params.toString(), secret)
        if (body != null && body.length() > 0) b = ShCrypto.encrypt(body.toString(), secret)
        val time = System.currentTimeMillis().toString()
        val sign = ShCrypto.sign(hashKey, q, b, CLIENT_ID, rid, time, access)
        val h = HashMap<String, String>()
        h["X-appKey"] = CLIENT_ID; h["X-requestId"] = rid; h["X-sid"] = ""; h["X-time"] = time; h["X-sign"] = sign
        if (access.isNotEmpty()) h["X-token"] = access
        val url = endpoint(ctx) + path + (if (q.isNotEmpty()) "?encdata=" + enc(q) else "")
        val reqBody = if (b.isNotEmpty()) JSONObject().put("encdata", b).toString() else if (method == "GET") null else ""
        val (code, text) = plain(method, url, reqBody, h)
        if (code == 0) return null
        if (code !in 200..299) return JSONObject().put("success", false).put("msg", "http $code")
        return try {
            val j = JSONObject(text)
            val r = j.opt("result")
            if (j.optBoolean("success") && r is String && r.isNotEmpty()) {
                val plainText = ShCrypto.decrypt(r, secret)
                j.put("result", try { JSONTokener(plainText).nextValue() } catch (e: Exception) { plainText })
            }
            j
        } catch (e: Exception) { JSONObject().put("success", false).put("msg", "bad response") }
    }

    @Synchronized
    private fun refreshIfNeeded(ctx: Context) {
        val t = tok(ctx) ?: return
        val expAt = t.optLong("t", 0) + t.optLong("expire_time", 0) * 1000
        if (expAt - 60_000 > System.currentTimeMillis()) return
        val r = req(ctx, "GET", "/v1.0/m/token/" + t.optString("refresh_token"), null, null, false) ?: return
        if (r.optBoolean("success")) {
            val x = r.optJSONObject("result") ?: return
            val n = JSONObject().put("t", r.optLong("t", System.currentTimeMillis())).put("expire_time", x.optLong("expireTime")).put("uid", x.optString("uid"))
                .put("access_token", x.optString("accessToken")).put("refresh_token", x.optString("refreshToken"))
            Store.set(ctx, "shTok", n.toString())
        }
    }

    private fun detail(ctx: Context, id: String): JSONObject? {
        val c = detailCache[id]
        if (c != null && System.currentTimeMillis() - c.first < 1200) return c.second
        val r = req(ctx, "GET", "/v1.0/m/life/ha/devices/detail", JSONObject().put("devIds", id), null) ?: return null
        val arr = r.optJSONArray("result") ?: return null
        for (i in 0 until arr.length()) {
            val d = arr.optJSONObject(i) ?: continue
            if (d.optString("id") == id || arr.length() == 1) { detailCache[id] = Pair(System.currentTimeMillis(), d); return d }
        }
        return null
    }

    /** Same contract as Tuya.call: the app asks for the classic Tuya paths, we translate them. */
    fun call(ctx: Context, method: String, path: String, body: String?): Pair<Int, String> {
        if (tok(ctx) == null) return fail(401, "Smart Life ulanmagan")
        val expired = fail(401, "Smart Life sessiyasi tugagan, qayta ulang")
        val net = Pair(0, "{\"success\":false,\"msg\":\"network\"}")
        try {
            if (path.startsWith("/v1.0/token")) { // connectivity / credentials check
                val r = req(ctx, "GET", "/v1.0/m/life/users/homes", null, null) ?: return net
                return if (r.optBoolean("success")) ok(JSONObject()) else expired
            }
            var m = Regex("^/v1\\.0/devices/([^/?]+)/status$").find(path)
            if (m != null && method == "GET") {
                val d = detail(ctx, m.groupValues[1]) ?: return net
                return ok(d.optJSONArray("status") ?: JSONArray())
            }
            m = Regex("^/v1\\.0/devices/([^/?]+)/specifications$").find(path)
            if (m != null) { val r = req(ctx, "GET", "/v1.1/m/life/${m.groupValues[1]}/specifications", null, null) ?: return net; return Pair(200, r.toString()) }
            m = Regex("^/v1\\.0/devices/([^/?]+)/commands$").find(path)
            if (m != null && method == "POST") {
                val b = try { JSONObject(body ?: "{}") } catch (e: Exception) { JSONObject() }
                val r = req(ctx, "POST", "/v1.1/m/thing/${m.groupValues[1]}/commands", null, b) ?: return net
                detailCache.remove(m.groupValues[1])
                return Pair(200, r.toString())
            }
            m = Regex("^/v1\\.0/devices/([^/?]+)$").find(path)
            if (m != null && method == "GET") {
                val d = detail(ctx, m.groupValues[1]) ?: return net
                return ok(JSONObject().put("online", d.optBoolean("online", true)))
            }
            return fail(404, "not_supported")
        } catch (e: Exception) { return fail(500, e.message ?: "error") }
    }

    /** Login / helper paths that the UI calls through Android.tuya(): /__qr, /__qrpoll, /__devices, /__logout */
    fun special(ctx: Context, method: String, path: String, body: String?): Pair<Int, String> {
        val net = Pair(0, "{\"success\":false,\"msg\":\"network\"}")
        try {
            if (path == "/__qr") {
                val code = JSONObject(body ?: "{}").optString("usercode").trim()
                if (code.isEmpty()) return fail(400, "User Code kiritilmagan")
                Store.set(ctx, "shUser", code)
                val (c, text) = plain("POST", "$LOGIN/v1.0/m/life/home-assistant/qrcode/tokens?clientid=$CLIENT_ID&usercode=${enc(code)}&schema=$SCHEMA", null)
                return if (c == 0) net else Pair(200, text)
            }
            if (path.startsWith("/__qrpoll")) {
                val token = path.substringAfter("token=", "")
                val (c, text) = plain("GET", "$LOGIN/v1.0/m/life/home-assistant/qrcode/tokens/${enc(token)}?clientid=$CLIENT_ID&usercode=${enc(Store.get(ctx, "shUser"))}", null)
                if (c == 0) return net
                val j = JSONObject(text)
                if (!j.optBoolean("success")) return Pair(200, JSONObject().put("success", false).put("code", j.opt("code")).put("msg", j.optString("msg")).toString())
                val r = j.getJSONObject("result")
                Store.set(ctx, "shTok", JSONObject().put("t", j.optLong("t", System.currentTimeMillis())).put("expire_time", r.optLong("expire_time")).put("uid", r.optString("uid"))
                    .put("access_token", r.optString("access_token")).put("refresh_token", r.optString("refresh_token")).toString())
                Store.set(ctx, "shTerm", r.optString("terminal_id"))
                Store.set(ctx, "shEnd", r.optString("endpoint"))
                Store.set(ctx, "tuyaMode", "sharing")
                Store.set(ctx, "tuyaId", "smartlife") // marker: the app treats "credentials present" as tuyaId != ""
                detailCache.clear()
                return ok(JSONObject())
            }
            if (path == "/__devices") {
                if (tok(ctx) == null) return fail(401, "Smart Life ulanmagan")
                val homes = req(ctx, "GET", "/v1.0/m/life/users/homes", null, null) ?: return net
                val hs = homes.optJSONArray("result") ?: return fail(401, "Smart Life sessiyasi tugagan, qayta ulang")
                val out = JSONArray()
                for (i in 0 until hs.length()) {
                    val home = hs.optJSONObject(i) ?: continue
                    val hid = home.opt("ownerId")?.toString() ?: continue
                    val r = req(ctx, "GET", "/v1.0/m/life/ha/home/devices", JSONObject().put("homeId", hid), null) ?: continue
                    val arr = r.optJSONArray("result") ?: continue
                    for (k in 0 until arr.length()) {
                        val d = arr.optJSONObject(k) ?: continue
                        out.put(JSONObject().put("id", d.optString("id")).put("name", d.optString("name")).put("online", d.optBoolean("online"))
                            .put("category", d.optString("category")).put("product", d.optString("product_name")).put("home", home.optString("name")))
                    }
                }
                return ok(out)
            }
            if (path == "/__logout") {
                listOf("shTok", "shTerm", "shEnd", "shUser", "tuyaMode", "tuyaId").forEach { Store.set(ctx, it, "") }
                detailCache.clear()
                return ok(JSONObject())
            }
            return fail(404, "not_supported")
        } catch (e: Exception) { return fail(500, e.message ?: "error") }
    }
}
