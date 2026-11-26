package expo.modules.storeagesignal

import com.google.android.play.agesignals.AgeSignalsAccessRequest
import com.google.android.play.agesignals.AgeSignalsException
import com.google.android.play.agesignals.AgeSignalsManager
import com.google.android.play.agesignals.AgeSignalsManagerFactory
import com.google.android.play.agesignals.AgeSignalsRequest
import com.google.android.play.agesignals.model.AgeRangeSource
import com.google.android.play.agesignals.model.AgeSignalsErrorCode
import com.google.android.play.agesignals.model.AgeSignalsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Play Age Signals: whether the user (or parent) shares an age range with this
// app, then that range. Every outcome resolves as plain values; nothing here
// decides what the app does with it (src/lib/storeAgeSignal.ts does).
// REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016.
class StoreAgeSignalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StoreAgeSignal")

    AsyncFunction("requestAgeSignalAsync") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(outcome("unavailable", error = "no-activity"))
        return@AsyncFunction
      }
      val manager = AgeSignalsManagerFactory.create(activity.applicationContext)
      // The activity lets Play show its sharing prompt where one applies.
      val access = AgeSignalsAccessRequest.builder().setActivity(activity).build()
      manager.requestAgeSignalsAccess(access)
        .addOnSuccessListener { result ->
          when (result.ageSignalsStatus()) {
            AgeSignalsStatus.SHARED -> readSignals(manager, promise)
            AgeSignalsStatus.NOT_SHARED -> promise.resolve(outcome("declined"))
            AgeSignalsStatus.VERIFICATION_REQUIRED -> promise.resolve(outcome("verification-required"))
            else -> promise.resolve(outcome("unavailable", error = "unspecified-status"))
          }
        }
        .addOnFailureListener { error -> promise.resolve(failure(error)) }
    }
  }

  private fun readSignals(manager: AgeSignalsManager, promise: Promise) {
    manager.checkAgeSignals(AgeSignalsRequest.builder().build())
      .addOnSuccessListener { result ->
        promise.resolve(outcome("shared", result.ageLower(), result.ageUpper(), sourceName(result.ageRangeSource())))
      }
      .addOnFailureListener { error -> promise.resolve(failure(error)) }
  }

  private fun sourceName(source: Int?): String? = when (source) {
    AgeRangeSource.TIER_A -> "tier-a"
    AgeRangeSource.TIER_B -> "tier-b"
    AgeRangeSource.TIER_C -> "tier-c"
    AgeRangeSource.TIER_D -> "tier-d"
    else -> null
  }

  private fun failure(error: Exception): Map<String, Any?> {
    val code = (error as? AgeSignalsException)?.errorCode
    val name = when (code) {
      AgeSignalsErrorCode.API_NOT_AVAILABLE -> "api-not-available"
      AgeSignalsErrorCode.PLAY_STORE_NOT_FOUND -> "play-store-not-found"
      AgeSignalsErrorCode.NETWORK_ERROR -> "network"
      AgeSignalsErrorCode.PLAY_SERVICES_NOT_FOUND -> "play-services-not-found"
      AgeSignalsErrorCode.CANNOT_BIND_TO_SERVICE -> "cannot-bind-to-service"
      AgeSignalsErrorCode.PLAY_STORE_VERSION_OUTDATED -> "play-store-outdated"
      AgeSignalsErrorCode.PLAY_SERVICES_VERSION_OUTDATED -> "play-services-outdated"
      AgeSignalsErrorCode.CLIENT_TRANSIENT_ERROR -> "transient"
      AgeSignalsErrorCode.APP_NOT_OWNED -> "app-not-owned"
      AgeSignalsErrorCode.SDK_VERSION_OUTDATED -> "sdk-outdated"
      AgeSignalsErrorCode.INTERNAL_ERROR -> "internal"
      else -> "unknown-error"
    }
    return outcome("unavailable", error = name)
  }

  private fun outcome(
    status: String,
    lower: Int? = null,
    upper: Int? = null,
    source: String? = null,
    error: String? = null,
  ): Map<String, Any?> = mapOf(
    "platform" to "android",
    "status" to status,
    "lower" to lower,
    "upper" to upper,
    "source" to source,
    "error" to error,
  )
}
