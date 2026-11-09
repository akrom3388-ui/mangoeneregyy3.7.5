package uz.mango.monitor

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Direct Tuya Cloud client (standalone mode). Keys live in EncryptedSharedPreferences only. */
object Tuya {
    private var tok = ""
    private var exp = 0L
    private var tokKey = ""

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun hmac(msg: String, key: String): String {
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return m.doFinal(msg.toByteArray(Charsets.UTF_8)).joinToString("") { "%02X".format(it) }
    }

    private fun raw(ctx: Context, method: String, path: String, body: String, token: String): Pair<Int, String> {
        val id = Store.get(ctx, "tuyaId").trim()
        val secret = Store.get(ctx, "tuyaSecret").trim()
        val region = Store.get(ctx, "tuyaRegion").ifEmpty { "eu" }
        val t = System.currentTimeMillis().toString()
        val stringToSign = "$method\n${sha256(body)}\n\n$path"
        val sign = hmac(id + token + t + stringToSign, secret)
        return try {
            val c = URL("https://openapi.tuya$region.com$path").openConnection() as HttpURLConnection
            c.requestMethod = method
            c.connectTimeout = 15000
            c.readTimeout = 20000
            c.setRequestProperty("client_id", id)
            c.setRequestProperty("sign", sign)
            c.setRequestProperty("t", t)
            c.setRequestProperty("sign_method", "HMAC-SHA256")
            if (token.isNotEmpty()) c.setRequestProperty("access_token", token)
            if (body.isNotEmpty()) {
                c.setRequestProperty("Content-Type", "application/json")
                c.doOutput = true
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = c.responseCode
            val stream = if (code in 200..399) c.inputStream else c.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            c.disconnect()
            Pair(code, text)
        } catch (e: Exception) {
            Pair(0, "")
        }
    }

    @Synchronized
    private fun token(ctx: Context, force: Boolean): String? {
        val key = Store.get(ctx, "tuyaId") + "|" + Store.get(ctx, "tuyaRegion")
        if (!force && tok.isNotEmpty() && System.currentTimeMillis() < exp && key == tokKey) return tok
        val (_, text) = raw(ctx, "GET", "/v1.0/token?grant_type=1", "", "")
        return try {
            val j = JSONObject(text)
            if (!j.optBoolean("success")) return null
            val r = j.getJSONObject("result")
            tok = r.getString("access_token")
            exp = System.currentTimeMillis() + (r.optLong("expire_time", 7200) - 120) * 1000
            tokKey = key
            tok
        } catch (e: Exception) { null }
    }

    /** Returns Pair(http status, Tuya JSON). Token errors come back as a Tuya-style failure JSON. */
    fun call(ctx: Context, method: String, path: String, body: String?): Pair<Int, String> {
        // Smart Life login (User Code + QR): helper paths and every normal call go through the sharing client
        if (path.startsWith("/__")) return Sharing.special(ctx, method, path, body)
        if (Store.get(ctx, "tuyaMode") == "sharing") return Sharing.call(ctx, method, path, body)
        if (Store.get(ctx, "tuyaId").isEmpty() || Store.get(ctx, "tuyaSecret").isEmpty())
            return Pair(400, "{\"success\":false,\"msg\":\"Tuya kalitlari kiritilmagan\"}")
        val b = body ?: ""
        var t = token(ctx, false) ?: return Pair(401, "{\"success\":false,\"msg\":\"Tuya token olinmadi: kalit yoki mintaqani tekshiring\"}")
        var res = raw(ctx, method, path, b, t)
        if (res.second.contains("\"code\":1010") || res.second.contains("\"code\":1011")) {
            t = token(ctx, true) ?: return res
            res = raw(ctx, method, path, b, t)
        }
        if (res.first == 0) return Pair(0, "{\"success\":false,\"msg\":\"network\"}")
        return res
    }
}
