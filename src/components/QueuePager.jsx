import { useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { formatCount } from "../lib/formatCount.js";
import { Pager } from "./Pager.jsx";

/** Keyset queues keep their retry and cursor semantics through the shared pager. */
export function QueuePager({ query }) {
  const { t, lang } = useLang();
  // While keyboard focus is inside the pager it stays, so a refetch whose
  // answer fits on one page moves focus to the count rather than the body.
  const [focusWithin, setFocusWithin] = useState(false);
  // A first-page fetch keeps the pager mounted (busy) so focus on its controls
  // and its polite count survive the refetch; the stale total is not shown.
  if (!focusWithin && !query.firstPageLoading && !query.error && !query.moreError && !query.cursor && (!query.total || query.total <= query.rows.length)) return null;
  return <Pager
    total={query.total ?? query.rows.length}
    shown={query.rows.length}
    onShowMore={query.cursor ? query.loadMore : undefined}
    loading={query.loading}
    busy={query.firstPageLoading}
    onFocusWithinChange={setFocusWithin}
    error={query.error}
    moreError={query.moreError}
    onRetry={query.retry}
    labels={{
      showing: ({ shown, total }) => t("steward.showingOf", { shown: formatCount(shown, lang), total: formatCount(total, lang) }),
      error: t("steward.queueLoadFailed"),
      retry: t("steward.tryAgain"),
      refresh: t("steward.tryAgain"),
      more: t("steward.loadMore"),
      loading: t("steward.loadingMore"),
      busy: t("steward.loadingMore"),
    }}
  />;
}
