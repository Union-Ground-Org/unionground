#!/usr/bin/env bash
# Run by .github/actions/watcher-red/action.yml; the description there is the
# contract. State lives in the open `watcher-red: <workflow>` issue, so a
# change is "red with no open issue" or "green with one open". A watcher keeps
# one issue for good: a later red reopens its newest closed issue. Issues are
# found by label, not by search, so a just-filed issue is never missed.
set -euo pipefail

transition=none
finish() {
  echo "transition=$transition" >> "$GITHUB_OUTPUT"
  echo "watcher-red: $WATCHER concluded ${CONCLUSION:-unknown}; transition $transition." >> "$GITHUB_STEP_SUMMARY"
}
trap finish EXIT

case "$CONCLUSION" in
  success|failure) ;;
  *) exit 0 ;;
esac

label=watcher-red
title="watcher-red: $WATCHER"
stamp="$(TZ=America/New_York date '+%b %-d, %Y, %-I:%M %p %Z')"

number="$(gh api "repos/$GH_REPO/issues?state=open&labels=$label&per_page=100" \
  | jq -r --arg title "$title" '[.[] | select(.pull_request == null and .title == $title)][0].number // empty')"

body="$(cat <<EOF
**$WATCHER** is red. This is a scheduled check outside the required \`check\`, so nothing else stops on it.

- Latest red run: $RUN_URL
- Commit: \`$RUN_SHA\` (event \`$RUN_EVENT\`)
- Last seen red: $stamp

The next green run of this workflow closes this issue. It is an alert.
EOF
)"

if [ "$CONCLUSION" = failure ]; then
  closed="$(gh api "repos/$GH_REPO/issues?state=closed&labels=$label&sort=updated&direction=desc&per_page=100" \
    | jq -r --arg title "$title" '[.[] | select(.pull_request == null and .title == $title)][0].number // empty')"
  if [ -z "$number" ] && [ -n "$closed" ]; then
    gh api -X PATCH "repos/$GH_REPO/issues/$closed" -f state=open -f body="$body" >/dev/null
    transition=reopened
  elif [ -z "$number" ]; then
    gh api -X POST "repos/$GH_REPO/labels" -f name="$label" -f color=d73a4a \
      -f description="A scheduled check is red; closed by its next green run" >/dev/null 2>&1 || true
    gh api -X POST "repos/$GH_REPO/issues" -f title="$title" -f body="$body" -f "labels[]=$label" >/dev/null
    transition=opened
  else
    # Still red: refresh the issue silently; no new notification.
    gh api -X PATCH "repos/$GH_REPO/issues/$number" -f body="$body" >/dev/null
    transition=still-red
  fi
elif [ -n "$number" ]; then
  gh api -X POST "repos/$GH_REPO/issues/$number/comments" -f body="Green again ($stamp): $RUN_URL" >/dev/null
  gh api -X PATCH "repos/$GH_REPO/issues/$number" -f state=closed -f state_reason=completed >/dev/null
  transition=closed
fi
