package expo.modules.nativecalendarexport

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.CalendarContract
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private class ComposerUnavailableException :
  CodedException("E_UNAVAILABLE", "No calendar application can open the system event composer.", null)

private class ComposerInvalidException :
  CodedException("E_INVALID", "The composer needs a title and a forward time range.", null)

// Hands one user-confirmed entry to the calendar application's own editor
// through ACTION_INSERT. The app holds no calendar permission, never reads
// the calendar provider, and never inserts a row itself.
class NativeCalendarExportModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NativeCalendarExport")

    Function("isAvailable") {
      val packageManager = appContext.reactContext?.packageManager ?: return@Function false
      composerIntent("Availability probe", 0L, 1L, null).resolveActivity(packageManager) != null
    }

    AsyncFunction("presentEventComposerAsync") { title: String, startMs: Double, endMs: Double, location: String? ->
      val trimmedTitle = title.trim()
      if (trimmedTitle.isEmpty() || endMs <= startMs) throw ComposerInvalidException()
      val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
      try {
        activity.startActivity(composerIntent(trimmedTitle, startMs.toLong(), endMs.toLong(), location))
      } catch (cause: ActivityNotFoundException) {
        throw ComposerUnavailableException()
      }
      "opened"
    }
  }

  private fun composerIntent(title: String, startMs: Long, endMs: Long, location: String?): Intent {
    val intent = Intent(Intent.ACTION_INSERT)
      .setData(CalendarContract.Events.CONTENT_URI)
      .putExtra(CalendarContract.Events.TITLE, title)
      .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMs)
      .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endMs)
    val trimmedLocation = location?.trim()
    if (!trimmedLocation.isNullOrEmpty()) {
      intent.putExtra(CalendarContract.Events.EVENT_LOCATION, trimmedLocation)
    }
    return intent
  }
}
