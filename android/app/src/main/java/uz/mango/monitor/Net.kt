package uz.mango.monitor

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.net.HttpURLConnection
import java.net.URL

/** Encrypted key-value store (token, language, flags). Tuya secrets are NEVER stored on the phone. */
object Store {
    @Volatile private var p: SharedPreferences? = null
    fun prefs(ctx: Context): SharedPreferences {
        p?.let { return it }
        synchronized(this) {
            p?.let { return it }
            val app = ctx.applicationContext
            val key = MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            val sp = EncryptedSharedPreferences.create(
                app, "mango_secure", key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            p = sp
            return sp
        }
    }
    fun get(ctx: Context, k: String): String = prefs(ctx).getString(k, "") ?: ""
    fun set(ctx: Context, k: String, v: String) { prefs(ctx).edit().putString(k, v).apply() }
}

object Net {
    fun base(ctx: Context): String {
        val s = Store.get(ctx, "server").trim().trimEnd('/')
        return if (s.isNotEmpty()) s else BuildConfig.SERVER_URL.trimEnd('/')
    }

    /** Returns Pair(httpStatus, body). status 0 = network error. */
    fun call(ctx: Context, method: String, path: String, body: String?): Pair<Int, String> {
        return try {
            val c = URL(base(ctx) + path).openConnection() as HttpURLConnection
            c.requestMethod = method
            c.connectTimeout = 15000
            c.readTimeout = 25000
            c.setRequestProperty("Content-Type", "application/json")
            val tok = Store.get(ctx, "token")
            if (tok.isNotEmpty()) c.setRequestProperty("Authorization", "Bearer $tok")
            if (!body.isNullOrEmpty() && method != "GET") {
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
}
