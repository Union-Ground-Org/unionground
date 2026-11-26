package expo.modules.homewidgets

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private object WidgetCounts {
  private var generation: String? = null
  private fun file(context: Context) = File(context.noBackupFilesDir, "home-widget-counts.json")
  private fun alarm(context: Context): PendingIntent = PendingIntent.getBroadcast(context, 6503,
    Intent(context, WidgetExpiryReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

  @Synchronized fun reset(context: Context, next: String) {
    generation = next
    android.util.AtomicFile(file(context)).delete()
    context.getSystemService(AlarmManager::class.java).cancel(alarm(context))
    render(context)
  }

  @Synchronized fun publish(context: Context, expected: String, today: Int, unread: Int, updatedAt: Double, expiresAt: Double) {
    if (generation != expected) return
    val now = System.currentTimeMillis().toDouble()
    require(today >= 0 && unread >= 0 && updatedAt.isFinite() && expiresAt.isFinite()
      && updatedAt <= now && expiresAt > now && expiresAt > updatedAt && expiresAt - updatedAt <= 300_000)
    val payload = JSONObject().put("today", today).put("unread", unread)
      .put("updatedAt", updatedAt.toLong()).put("expiresAt", expiresAt.toLong()).toString()
    val atomic = android.util.AtomicFile(file(context))
    val stream = atomic.startWrite()
    try { stream.write(payload.toByteArray(Charsets.UTF_8)); atomic.finishWrite(stream) }
    catch (error: Exception) { atomic.failWrite(stream); throw error }
    context.getSystemService(AlarmManager::class.java).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, expiresAt.toLong(), alarm(context))
    render(context)
  }

  @Synchronized fun read(context: Context): JSONObject? {
    val target = file(context)
    return try {
      val value = JSONObject(target.readText())
      val updated = value.getLong("updatedAt")
      val expires = value.getLong("expiresAt")
      val now = System.currentTimeMillis()
      if (value.getInt("today") < 0 || value.getInt("unread") < 0 || updated > now
        || expires <= now || expires <= updated || expires - updated > 300_000) {
        target.delete(); null
      } else value
    } catch (_: Exception) { target.delete(); null }
  }

  @Synchronized fun render(context: Context) {
    renderKind(context, TodayWidgetProvider::class.java, true)
    renderKind(context, UnreadWidgetProvider::class.java, false)
  }

  private fun renderKind(context: Context, provider: Class<out AppWidgetProvider>, today: Boolean) {
    val manager = AppWidgetManager.getInstance(context)
    val counts = read(context)
    for (id in manager.getAppWidgetIds(ComponentName(context, provider))) {
      val views = RemoteViews(context.packageName, R.layout.ug_count_widget)
      views.setTextViewText(R.id.ug_widget_title, if (today) "Today" else "Unread messages")
      val count = counts?.getInt(if (today) "today" else "unread")
      views.setTextViewText(R.id.ug_widget_count, count?.toString() ?: "—")
      views.setTextViewText(R.id.ug_widget_state, if (count == null) "Counts unavailable"
        else if (count == 0) { if (today) "Nothing due today" else "All caught up" }
        else if (today) "Due today" else "Unread inbox items")
      views.setTextViewText(R.id.ug_widget_updated, if (counts == null) "Open the app to share or refresh"
        else "Updated " + SimpleDateFormat("h:mm a", Locale.US).format(Date(counts.getLong("updatedAt"))))
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(if (today) "unionground://os-quick-action/work" else "unionground://os-quick-action/messages"))
      intent.component = ComponentName(context.packageName, "${context.packageName}.MainActivity")
      intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      views.setOnClickPendingIntent(R.id.ug_widget_root, PendingIntent.getActivity(context, if (today) 65031 else 65032,
        intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      manager.updateAppWidget(id, views)
    }
  }
}

class HomeWidgetsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HomeWidgets")
    AsyncFunction("resetAsync") { generation: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("Widget counts unavailable")
      WidgetCounts.reset(context, generation)
    }
    AsyncFunction("publishAsync") { generation: String, today: Int, unread: Int, updatedAt: Double, expiresAt: Double ->
      val context = appContext.reactContext ?: throw IllegalStateException("Widget counts unavailable")
      WidgetCounts.publish(context, generation, today, unread, updatedAt, expiresAt)
    }
  }
}

class TodayWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { WidgetCounts.render(context) }
}
class UnreadWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { WidgetCounts.render(context) }
}
class WidgetExpiryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) { WidgetCounts.render(context) }
}
