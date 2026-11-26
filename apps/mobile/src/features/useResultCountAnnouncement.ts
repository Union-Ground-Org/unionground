import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

// A list's result count is spoken only after the member's own filter or search
// change, never when a background refresh moves the count (a task-discussion or
// conversation poll), A11Y-UG-FOCUS-AND-ACCESSIBLE-NAME-GAPS-FROM-REVIEWS-20261117.
// `searchKey` names what the member chose (filter and query); `message` is the
// count's text. iOS hears one announcement once the member has paused for
// 450 ms, with the count at that moment. Android reads the count through its
// live region, so the returned value is the region's politeness: polite only
// while the member's change is settling, none afterwards, which keeps a later
// refresh silent there too.
//
// Every key change is a member request, numbered, so typing and then clearing
// back to the settled query within 450 ms (A -> B -> A) still announces
// (gate G7-9049). The number is kept from render to render the way React
// keeps derived state ("storing information from previous renders").
export function useResultCountAnnouncement(searchKey: string, message: string): 'polite' | 'none' {
  const [observed, setObserved] = useState({ key: searchKey, request: 0 });
  const [settledRequest, setSettledRequest] = useState(0);
  let request = observed.request;
  if (observed.key !== searchKey) {
    request += 1;
    setObserved({ key: searchKey, request });
  }
  const pending = request !== settledRequest;
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setTimeout(() => {
      if (Platform.OS === 'ios') void AccessibilityInfo.announceForAccessibility(message);
      setSettledRequest(request);
    }, 450);
    return () => clearTimeout(timer);
  }, [message, pending, request]);
  return pending ? 'polite' : 'none';
}
