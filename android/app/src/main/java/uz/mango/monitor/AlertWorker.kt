package uz.mango.monitor

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.Constraints
import androidx.work.NetworkType
import java.util.concurrent.TimeUnit

/** Fallback when the foreground service is off or killed: checks alerts about every 15 minutes (Android minimum). */
class AlertWorker(ctx: Context, p: WorkerParameters) : Worker(ctx, p) {
    override fun doWork(): Result {
        val ctx = applicationContext
        if (Store.get(ctx, "mode") == "direct") { try { Sampler.sampleAll(ctx) } catch (e: Exception) { /* ignore */ } }
        else Poller.pollOnce(ctx)
        try { Updater.noticeOnce(ctx)?.let { Poller.notifyUpdate(ctx, it) } } catch (e: Exception) { /* ignore */ }
        return Result.success()
    }
    companion object {
        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<AlertWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("mm_alerts", ExistingPeriodicWorkPolicy.KEEP, req)
        }
        fun cancel(ctx: Context) { WorkManager.getInstance(ctx).cancelUniqueWork("mm_alerts") }
    }
}
