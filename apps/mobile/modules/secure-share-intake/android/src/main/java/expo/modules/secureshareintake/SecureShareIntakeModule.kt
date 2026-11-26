package expo.modules.secureshareintake

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SecureShareIntakeModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("SecureShareIntake")

    AsyncFunction("getPendingAsync") {
      SecureShareStorage.getPending(context)?.toMap()
    }

    AsyncFunction("captureCleanupTokensAsync") {
      SecureShareStorage.captureCleanupTokens(context)
    }

    AsyncFunction("discardAsync") { token: String ->
      SecureShareStorage.discard(context, token)
    }
  }
}
