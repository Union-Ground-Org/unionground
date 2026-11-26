import Foundation
import SwiftUI
import WidgetKit

private struct Counts: Decodable {
  let today: Int
  let unread: Int
  let updatedAt: Double
  let expiresAt: Double

  static func read(now: Date) -> Counts? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "UGHomeWidgetsAppGroup") as? String, !group.isEmpty,
      let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
    let url = root.appendingPathComponent("counts.json")
    guard let data = try? Data(contentsOf: url), let value = try? JSONDecoder().decode(Counts.self, from: data) else { return nil }
    let time = now.timeIntervalSince1970 * 1000
    guard value.today >= 0, value.unread >= 0, value.today <= Int(Int32.max), value.unread <= Int(Int32.max),
      value.updatedAt.isFinite, value.expiresAt.isFinite, value.updatedAt <= time, value.expiresAt > time,
      value.expiresAt > value.updatedAt, value.expiresAt - value.updatedAt <= 300_000 else {
      try? FileManager.default.removeItem(at: url)
      return nil
    }
    return value
  }
}

private struct CountEntry: TimelineEntry {
  let date: Date
  let counts: Counts?
}

private struct CountProvider: TimelineProvider {
  func placeholder(in context: Context) -> CountEntry { CountEntry(date: Date(), counts: nil) }
  func getSnapshot(in context: Context, completion: @escaping (CountEntry) -> Void) {
    let now = Date()
    completion(CountEntry(date: now, counts: context.isPreview ? nil : Counts.read(now: now)))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<CountEntry>) -> Void) {
    let now = Date()
    guard let counts = Counts.read(now: now) else {
      completion(Timeline(entries: [CountEntry(date: now, counts: nil)], policy: .never))
      return
    }
    let expiry = Date(timeIntervalSince1970: counts.expiresAt / 1000)
    // Expiry has its own redacted entry; it does not wait for a network refresh.
    completion(Timeline(entries: [CountEntry(date: now, counts: counts), CountEntry(date: expiry, counts: nil)], policy: .after(expiry)))
  }
}

private struct CountView: View {
  let entry: CountEntry
  let today: Bool
  private var title: String { today ? "Today" : "Unread messages" }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.headline)
      if let counts = entry.counts {
        let count = today ? counts.today : counts.unread
        Text(String(count)).font(.system(size: 36, weight: .bold)).privacySensitive()
        Text(count == 0 ? (today ? "Nothing due today" : "All caught up") : (today ? "Due today" : "Unread inbox items")).font(.caption)
        Text("Updated \(Date(timeIntervalSince1970: counts.updatedAt / 1000).formatted(.dateTime.hour().minute().locale(Locale(identifier: "en_US"))))").font(.caption2)
      } else {
        Text("Counts unavailable").font(.subheadline)
        Text("Open the app to share or refresh counts.").font(.caption)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .foregroundStyle(Color.primary)
    .widgetURL(URL(string: today ? "unionground://os-quick-action/work" : "unionground://os-quick-action/messages"))
    .modifier(WidgetCanvas())
  }
}

private struct WidgetCanvas: ViewModifier {
  @ViewBuilder func body(content: Content) -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      content.containerBackground(.background, for: .widget)
    } else {
      content.padding().background(Color(.systemBackground))
    }
  }
}

private struct TodayWidget: Widget {
  let kind = "UnionGroundToday"
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: CountProvider()) { CountView(entry: $0, today: true) }
      .configurationDisplayName("Today")
      .description("A private count of authorized work due today. Enable sharing in Account.")
      .supportedFamilies([.systemSmall])
  }
}

private struct UnreadWidget: Widget {
  let kind = "UnionGroundUnread"
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: CountProvider()) { CountView(entry: $0, today: false) }
      .configurationDisplayName("Unread messages")
      .description("A private unread inbox count. Enable sharing in Account.")
      .supportedFamilies([.systemSmall])
  }
}

@main
struct UnionGroundWidgets: WidgetBundle {
  var body: some Widget { TodayWidget(); UnreadWidget() }
}
