package uz.mango.monitor

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.app.PendingIntent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * In-app updates from a Telegram channel: the newest APK is pinned in the channel, the bot reads the pinned message.
 * Android always shows its own "Update" confirmation; the new APK installs OVER the old one (same package + same signing key).
 */
object Updater {
    @Volatile var listener: ((Int, String) -> Unit)? = null // install result -> UI (status, message)

    /** Bot token and channel are compiled into the APK (update-channel.properties / CI secret) and cannot be changed in the app. */
    fun token(@Suppress("UNUSED_PARAMETER") ctx: Context): String = BuildConfig.TG_BOT_TOKEN
    fun chats(@Suppress("UNUSED_PARAMETER") ctx: Context): List<String> = BuildConfig.TG_CHAT_ID.split(',', ';', ' ', '\n').map { it.trim() }.filter { it.isNotEmpty() }
    fun configured(ctx: Context): Boolean = token(ctx).isNotEmpty() && chats(ctx).isNotEmpty()
    fun installed(): String = BuildConfig.VERSION_NAME.substringBefore('-')

    /** {available, version, current, size, optional, link, error} - also cached in Store("updInfo") for the background notice. */
    fun check(ctx: Context): JSONObject {
        val out = JSONObject().put("available", false).put("current", installed())
        if (!configured(ctx)) return out.put("error", "off")
        val (info, err) = UpdCore.latestAny(token(ctx), chats(ctx))
        if (err != null) return out.put("error", err)
        if (info == null || UpdCore.cmp(info.version, installed()) <= 0) { Store.set(ctx, "updInfo", ""); return out }
        val j = JSONObject().put("available", true).put("current", installed()).put("version", info.version).put("fileId", info.fileId)
            .put("size", info.size).put("optional", info.optional).put("link", info.link)
        Store.set(ctx, "updInfo", j.toString())
        return j
    }

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    @Suppress("DEPRECATION")
    private fun certs(pm: PackageManager, info: android.content.pm.PackageInfo): Set<String> {
        return if (Build.VERSION.SDK_INT >= 28) (info.signingInfo?.apkContentsSigners ?: emptyArray()).map { sha(it.toByteArray()) }.toSet()
        else (info.signatures ?: emptyArray()).map { sha(it.toByteArray()) }.toSet()
    }

    /** Checks the downloaded file really is a newer build of this app, signed with the same key. Returns an error text or null. */
    @Suppress("DEPRECATION")
    fun verify(ctx: Context, f: File): String? {
        val pm = ctx.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val apk = pm.getPackageArchiveInfo(f.path, flags) ?: return "bad_apk"
        if (apk.packageName != ctx.packageName) return "other_package"
        val cur = pm.getPackageInfo(ctx.packageName, flags)
        val curCode = if (Build.VERSION.SDK_INT >= 28) cur.longVersionCode else cur.versionCode.toLong()
        val newCode = if (Build.VERSION.SDK_INT >= 28) apk.longVersionCode else apk.versionCode.toLong()
        if (newCode <= curCode) return "not_newer"
        val a = certs(pm, apk); val b = certs(pm, cur)
        if (a.isEmpty() || a != b) return "signature"
        return null
    }

    /** Download -> verify -> hand to the system installer. Returns {stage: "installing"|"perm"|"error", msg}. */
    fun downloadAndInstall(ctx: Context, progress: (Int) -> Unit): JSONObject {
        fun res(stage: String, msg: String = "") = JSONObject().put("stage", stage).put("msg", msg)
        if (!configured(ctx)) return res("error", "off")
        if (Build.VERSION.SDK_INT >= 26 && !ctx.packageManager.canRequestPackageInstalls()) {
            try { ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) { /* ignore */ }
            return res("perm")
        }
        val (info, err) = UpdCore.latestAny(token(ctx), chats(ctx))
        if (err != null) return res("error", err)
        if (info == null || UpdCore.cmp(info.version, installed()) <= 0) return res("error", "no_update")
        val dir = File(ctx.cacheDir, "updates"); dir.mkdirs(); dir.listFiles()?.forEach { it.delete() }
        val f = File(dir, "mango-${info.version}.apk")
        val e = UpdCore.download(token(ctx), info.fileId, f, info.size, progress)
        if (e != null) return res("error", e)
        val v = verify(ctx, f); if (v != null) { f.delete(); return res("error", v) }
        return try { install(ctx, f); res("installing") } catch (ex: Exception) { res("error", ex.message ?: "install") }
    }

    private fun install(ctx: Context, f: File) {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            f.inputStream().use { inp -> s.openWrite("mango.apk", 0, f.length()).use { out -> inp.copyTo(out); s.fsync(out) } }
            val intent = Intent(ctx, InstallReceiver::class.java).setAction("uz.mango.monitor.INSTALL_RESULT")
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            s.commit(PendingIntent.getBroadcast(ctx, id, intent, flags).intentSender)
        }
    }

    /** Background worker: returns the version to announce once (null if nothing new or already announced). */
    fun noticeOnce(ctx: Context): String? {
        val j = check(ctx); if (!j.optBoolean("available")) return null
        val v = j.optString("version"); if (Store.get(ctx, "updNotified") == v) return null
        Store.set(ctx, "updNotified", v); return v
    }
}
