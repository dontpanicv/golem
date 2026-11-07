package dev.golem.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import dev.golem.MainActivity
import dev.golem.R
import dev.golem.api.Inbox

/**
 * Shows the person's new unread notifications as notifications of the phone while the app runs. Golem sends no push
 * to Android yet, so the app learns of them from the event streams (`Session.followWorking`) and the inbox.
 */
class Notifier(private val context: Context) {
    /** The notifications already shown, or there before the app looked first. */
    private val seen = mutableSetOf<String>()
    private val manager = NotificationManagerCompat.from(context)

    init {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH)
        )
    }

    /**
     * Shows each unread notification not seen before, except those of the thread on screen; `silently` only notes
     * them, as at the first look after the app starts. A notification that was read goes from the phone.
     */
    fun show(inbox: Inbox, workspaceId: String, silently: Boolean, onScreen: String?) {
        val allowed = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        for (notification in inbox.notifications) {
            if (notification.readAt != null) {
                manager.cancel(notification.id, 0)
                continue
            }
            if (!seen.add(notification.id) || silently || !allowed || notification.threadId == onScreen) continue
            val intent = Intent(context, MainActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.WORKSPACE, workspaceId)
                .putExtra(MainActivity.CHANNEL, notification.channelId)
                .putExtra(MainActivity.THREAD, notification.threadId)
            val open = PendingIntent.getActivity(
                context, notification.id.hashCode(), intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val built = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(notification.title)
                .setContentText(notification.text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(notification.text))
                .setWhen(notification.createdAt.toLong())
                .setShowWhen(true)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .build()
            @Suppress("MissingPermission")
            manager.notify(notification.id, 0, built)
        }
    }

    /** Takes every notification from the phone, as at sign-out. */
    fun clear() {
        seen.clear()
        manager.cancelAll()
    }

    private companion object {
        const val CHANNEL = "messages"
    }
}
