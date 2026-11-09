package uz.mango.monitor

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var stoppedAt = 0L
    private var pendingLoc = -1

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false      // assets stay reachable via file:///android_asset
            allowContentAccess = false
            setSupportZoom(false)
        }
        web.webViewClient = object : WebViewClient() {
            // Never navigate away from our own bundled UI.
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean = true
        }
        web.addJavascriptInterface(Bridge(), "Android")
        web.loadUrl("file:///android_asset/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.onBackKey?onBackKey():false)") { r -> if (r != "true") moveTaskToBack(true) }
            }
        })
        Poller.ensureChannels(this)
    }

    override fun onStop() { super.onStop(); stoppedAt = System.currentTimeMillis() }
    override fun onStart() {
        super.onStart()
        Updater.listener = { st, msg -> runOnUiThread { web.evaluateJavascript("window.__updDone&&__updDone($st, ${JSONObject.quote(msg)})", null) } }
        if (stoppedAt > 0 && System.currentTimeMillis() - stoppedAt > 30_000 && Store.get(this, "lock") == "1") {
            web.evaluateJavascript("window.showLock&&showLock()", null)
        }
    }

    private fun cb(id: Int, status: Int, text: String) {
        val q = JSONObject.quote(text).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        runOnUiThread { web.evaluateJavascript("window.__cb($id,$status,$q)", null) }
    }


    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 12) {
            val id = pendingLoc; pendingLoc = -1
            if (id < 0) return
            if (grantResults.any { it == PackageManager.PERMISSION_GRANTED }) startLocate(id) else cb(id, 403, "{}")
        }
    }

    /** Region / district from the phone's location (approximate permission is enough). Result JSON: {lat, lon, region, district}. */
    private fun startLocate(id: Int) {
        Thread {
            try {
                val lm = getSystemService(LOCATION_SERVICE) as LocationManager
                var best: Location? = null
                for (p in lm.getProviders(true)) {
                    val l = try { lm.getLastKnownLocation(p) } catch (e: SecurityException) { null }
                    if (l != null && (best == null || l.time > best!!.time)) best = l
                }
                if (best == null || System.currentTimeMillis() - best!!.time > 30 * 60_000L) { freshLocation(lm)?.let { best = it } }
                val b = best
                if (b == null) { cb(id, 404, "{}"); return@Thread }
                cb(id, 200, reverseGeocode(b.latitude, b.longitude).toString())
            } catch (e: Exception) { cb(id, 500, "{}") }
        }.start()
    }

    private fun freshLocation(lm: LocationManager): Location? {
        val provider = when {
            lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            else -> return null
        }
        val latch = CountDownLatch(1)
        var out: Location? = null
        val listener = object : LocationListener {
            override fun onLocationChanged(l: Location) { out = l; latch.countDown() }
            @Deprecated("Deprecated in Java") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
            override fun onProviderEnabled(p: String) {}
            override fun onProviderDisabled(p: String) {}
        }
        runOnUiThread { try { lm.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper()) } catch (e: Exception) { latch.countDown() } }
        latch.await(12, TimeUnit.SECONDS)
        runOnUiThread { try { lm.removeUpdates(listener) } catch (e: Exception) { /* ignore */ } }
        return out
    }

    private fun reverseGeocode(lat: Double, lon: Double): JSONObject {
        val o = JSONObject().put("lat", Math.round(lat * 10000) / 10000.0).put("lon", Math.round(lon * 10000) / 10000.0)
        try {
            val c = URL("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=uz&lat=$lat&lon=$lon").openConnection() as HttpURLConnection
            c.connectTimeout = 8000; c.readTimeout = 8000; c.setRequestProperty("User-Agent", "MangoMonitor/3.4")
            val a = JSONObject(c.inputStream.bufferedReader().use { it.readText() }).optJSONObject("address")
            c.disconnect()
            if (a != null) {
                o.put("region", a.optString("state", a.optString("region", "")))
                val d = listOf("county", "city_district", "city", "town", "municipality", "village").map { a.optString(it, "") }.firstOrNull { it.isNotEmpty() } ?: ""
                o.put("district", d)
            }
        } catch (e: Exception) { /* coordinates only */ }
        return o
    }

    private fun askNotifPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 11)
        }
    }

    inner class Bridge {
        @JavascriptInterface fun get(k: String): String = Store.get(this@MainActivity, k)

        @JavascriptInterface fun set(k: String, v: String) {
            val ctx = this@MainActivity
            Store.set(ctx, k, v)
            if (k == "mode") {
                if (v == "direct") { AlertWorker.schedule(ctx); runOnUiThread { askNotifPermission() } }
                else if (Store.get(ctx, "token").isEmpty()) { AlertWorker.cancel(ctx); StatusService.stop(ctx) }
            }
            if (k == "token") {
                Store.set(ctx, "lastAlert", ""); Store.set(ctx, "summary", "")
                if (v.isEmpty()) { AlertWorker.cancel(ctx); StatusService.stop(ctx) }
                else { AlertWorker.schedule(ctx); runOnUiThread { askNotifPermission() } }
            }
        }

        /** All network calls go through here: the JS layer never sees tokens or talks to other hosts. */
        @JavascriptInterface fun api(id: Int, method: String, path: String, body: String) {
            if (!path.startsWith("/api/") || method !in setOf("GET", "POST", "PUT", "PATCH", "DELETE")) { cb(id, 400, "{}"); return }
            Thread {
                val (code, text) = Net.call(this@MainActivity, method, path, body)
                cb(id, code, text)
            }.start()
        }

        /** Standalone mode: signed Tuya Cloud call (keys never leave native code). */
        @JavascriptInterface fun tuya(id: Int, method: String, path: String, body: String) {
            if (!(path.startsWith("/v1.0/") || path.startsWith("/__")) || method !in setOf("GET", "POST")) { cb(id, 400, "{\"success\":false}"); return }
            Thread { val (code, text) = Tuya.call(this@MainActivity, method, path, body); cb(id, code, text) }.start()
        }

        @JavascriptInterface fun locate(id: Int) {
            runOnUiThread {
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) startLocate(id)
                else { pendingLoc = id; ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION), 12) }
            }
        }

        @JavascriptInterface fun drain(): String = Sampler.drain(this@MainActivity)

        @JavascriptInterface fun sampleNow() { Thread { try { Sampler.sampleAll(this@MainActivity) } catch (e: Exception) { /* ignore */ } }.start() }

        @JavascriptInterface fun notify(title: String, body: String) {
            val ctx = this@MainActivity
            if (Store.get(ctx, "alertNotif") == "0") return
            Poller.ensureChannels(ctx)
            val n = androidx.core.app.NotificationCompat.Builder(ctx, Poller.CH_ALERT)
                .setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(body)
                .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH).setSound(null).setVibrate(null).setSilent(true).setAutoCancel(true)
                .setContentIntent(Poller.openApp(ctx)).build()
            try { androidx.core.app.NotificationManagerCompat.from(ctx).notify((System.currentTimeMillis() % 100000).toInt() + 5000, n) } catch (e: SecurityException) { /* no permission */ }
        }

        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME.substringBefore('-')

        // ---- in-app updates from the Telegram channel ----
        @JavascriptInterface fun updCheck(id: Int) { Thread { cb(id, 200, Updater.check(this@MainActivity).toString()) }.start() }
        @JavascriptInterface fun updInstall(id: Int) {
            Thread {
                val r = Updater.downloadAndInstall(this@MainActivity) { pct -> runOnUiThread { web.evaluateJavascript("window.__updP&&__updP($pct)", null) } }
                cb(id, 200, r.toString())
            }.start()
        }
        @JavascriptInterface fun updOpen(url: String) {
            if (!url.startsWith("https://t.me/")) return
            runOnUiThread { try { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) { /* no browser */ } }
        }

        /** Saves a PNG (base64) to Pictures/MangoMonitor so the QR can be picked from the gallery inside Smart Life's scanner. Android 10+. */
        @JavascriptInterface fun saveImage(id: Int, name: String, b64: String) {
            Thread {
                var ok = false
                try {
                    if (android.os.Build.VERSION.SDK_INT >= 29) {
                        val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                        val v = android.content.ContentValues().apply {
                            put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name)
                            put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/png")
                            put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/MangoMonitor")
                        }
                        val uri = contentResolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v)
                        if (uri != null) { contentResolver.openOutputStream(uri)?.use { it.write(bytes) }; ok = true }
                    }
                } catch (e: Exception) { ok = false }
                cb(id, if (ok) 200 else 500, "")
            }.start()
        }

        @JavascriptInterface fun auth(id: Int, reason: String) {
            runOnUiThread {
                val allowed = BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
                if (BiometricManager.from(this@MainActivity).canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) {
                    cb(id, 200, "ok"); return@runOnUiThread // no screen lock set on this phone: nothing to enforce
                }
                val info = BiometricPrompt.PromptInfo.Builder().setTitle(reason).setAllowedAuthenticators(allowed).build()
                val prompt = BiometricPrompt(this@MainActivity, ContextCompat.getMainExecutor(this@MainActivity),
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { cb(id, 200, "ok") }
                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) { cb(id, 403, "fail") }
                    })
                prompt.authenticate(info)
            }
        }

        @JavascriptInterface fun setService(on: Boolean) {
            val ctx = this@MainActivity
            Store.set(ctx, "service", if (on) "1" else "0")
            runOnUiThread {
                if (on && (Store.get(ctx, "token").isNotEmpty() || Store.get(ctx, "mode") == "direct")) { askNotifPermission(); try { StatusService.start(ctx) } catch (e: Exception) { /* ignore */ } }
                else StatusService.stop(ctx)
            }
        }

        /** Background-health info for the warning card on the main screen. */
        @JavascriptInterface fun bgStatus(): String {
            val ctx = this@MainActivity
            val pm = ctx.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
            return JSONObject().put("battery", pm.isIgnoringBatteryOptimizations(ctx.packageName))
                .put("notif", androidx.core.app.NotificationManagerCompat.from(ctx).areNotificationsEnabled())
                .put("last", Store.get(ctx, "lastSampleAt").toLongOrNull() ?: 0L).put("gap", Store.get(ctx, "bgGapMs").toLongOrNull() ?: 0L).put("gapAt", Store.get(ctx, "bgGapAt").toLongOrNull() ?: 0L).toString()
        }
        /** One-tap system dialog: "allow this app to run in the background without restrictions". */
        @JavascriptInterface fun batteryAllow() {
            runOnUiThread {
                try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
                catch (e: Exception) { try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (e2: Exception) { /* none */ } }
            }
        }
        /** Auto-start screen of the common Android skins (Xiaomi, Huawei, Oppo, Vivo, Samsung); falls back to the app details page. */
        @JavascriptInterface fun autostartSettings() {
            runOnUiThread {
                val tries = listOf("com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity", "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                    "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity", "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
                    "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity", "com.samsung.android.lool" to "com.samsung.android.sm.battery.ui.BatteryActivity")
                for ((pkg, cls) in tries) { try { startActivity(Intent().setComponent(android.content.ComponentName(pkg, cls)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return@runOnUiThread } catch (e: Exception) { /* next */ } }
                try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) } catch (e: Exception) { /* none */ }
            }
        }

        @JavascriptInterface fun batterySettings() {
            runOnUiThread {
                try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
                catch (e: Exception) { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
            }
        }
    }
}
