import ExpoModulesCore
import UIKit
#if canImport(DeclaredAgeRange)
import DeclaredAgeRange
#endif

// Apple Declared Age Range (iOS 26+): the age range the App Store holds for the
// signed-in Apple Account, asked at the single 18 gate. Every outcome resolves
// as plain values; nothing here decides what the app does with it
// (src/lib/storeAgeSignal.ts does). REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016.
public class StoreAgeSignalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StoreAgeSignal")

    AsyncFunction("requestAgeSignalAsync") { (promise: Promise) in
      Task { @MainActor in
        promise.resolve(await self.requestAgeSignal())
      }
    }
  }

  @MainActor
  private func requestAgeSignal() async -> [String: Any?] {
    #if canImport(DeclaredAgeRange)
    if #available(iOS 26.0, *) {
      return await requestDeclaredAgeRange()
    }
    #endif
    return Self.outcome("unavailable", error: "unsupported-os")
  }

  #if canImport(DeclaredAgeRange)
  @available(iOS 26.0, *)
  @MainActor
  private func requestDeclaredAgeRange() async -> [String: Any?] {
    do {
      if #available(iOS 26.2, *) {
        // Outside a region that requires age assurance there is no signal to act on.
        guard try await AgeRangeService.shared.isEligibleForAgeFeatures else {
          return Self.outcome("not-eligible")
        }
      }
      guard let controller = appContext?.utilities?.currentViewController() else {
        return Self.outcome("unavailable", error: "no-view-controller")
      }
      switch try await AgeRangeService.shared.requestAgeRange(ageGates: 18, in: controller) {
      case .declinedSharing:
        return Self.outcome("declined")
      case let .sharing(range):
        return Self.outcome(
          "shared",
          lower: range.lowerBound,
          upper: range.upperBound,
          source: range.ageRangeDeclaration.map { String(describing: $0) }
        )
      @unknown default:
        return Self.outcome("unavailable", error: "unknown-response")
      }
    } catch let error as AgeRangeService.Error {
      return Self.outcome("unavailable", error: Self.code(error))
    } catch {
      return Self.outcome("unavailable", error: "unknown-error")
    }
  }

  // Only the two cases the iOS 26 SDK declares are named. declinedOnboarding,
  // invalidAccount and network were added in iOS 27 (Apple's availability
  // metadata), and naming them fails to compile against the supported iOS 26
  // SDK; on either SDK they reach the unknown default as an unavailable signal.
  @available(iOS 26.0, *)
  private static func code(_ error: AgeRangeService.Error) -> String {
    switch error {
    case .notAvailable: return "not-available"
    case .invalidRequest: return "invalid-request"
    @unknown default: return "unknown-error"
    }
  }
  #endif

  private static func outcome(_ status: String, lower: Int? = nil, upper: Int? = nil, source: String? = nil, error: String? = nil) -> [String: Any?] {
    return ["platform": "ios", "status": status, "lower": lower, "upper": upper, "source": source, "error": error]
  }
}
