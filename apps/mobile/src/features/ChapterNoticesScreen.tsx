import { useEffect, useState } from 'react';

import { Body, Button, Card, Heading, Screen, StateMessage } from '../components/ui';
import { useNativeUi } from '../lib/useNativeUi';
import { deviceZonedDateTime } from '../lib/evidenceTimestamp';
import { loadMySentNotices, type SentNotice } from '../services/stewardDeskSections';
import { useTheme } from '../theme/ThemeProvider';
import { NoticeComposer } from './NoticeComposer';
import { useDeskScope } from './StewardDeskSectionsScreen';

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 2 of 4): working as Chapter Administrator or President, an
// officer writes and sends a chapter notice on the phone, as the website's
// notice desk does (src/features/notices/OfficerNoticeDesk.jsx), and sees the
// notices they sent. The composer is the Steward desk's Broadcasts composer;
// the audience list and the publish call are the website's own
// (src/lib/noticeAudience.js), and the server checks the role again.
export function ChapterNoticesScreen({ title }: { title: string }) {
  const { t, locale, catalogLabel } = useNativeUi();
  const theme = useTheme();
  const scope = useDeskScope();
  const [sent, setSent] = useState<SentNotice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    setFailed(false);
    void loadMySentNotices()
      .then((rows) => { if (current) setSent(rows); })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [scope.key, reload]);

  // Ledger 526: the one zoned format, shared with the Campaigns list.
  const when = (value: string | null) => deviceZonedDateTime(value, locale) ?? '';

  return (
    <Screen>
      <Heading>{catalogLabel(title)}</Heading>
      <NoticeComposer scope={scope} resumeItemID="chapter-notices" onSent={() => setReload((value) => value + 1)} />
      <Heading level={2}>{t('Notices you sent')}</Heading>
      {failed ? <Card>
        <Body style={{ color: theme.destructive }}>{t('Your sent notices could not be loaded.')}</Body>
        <Button label={t('Try again')} variant="secondary" onPress={() => setReload((value) => value + 1)} />
      </Card> : sent === null ? <StateMessage title={t('Loading your notices')} body={t('Getting the notices you sent.')} />
        : sent.length === 0 ? <Body muted>{t('You have not sent a notice yet.')}</Body>
          : sent.map((notice) => (
            <Card key={notice.id}>
              <Heading level={3}>{notice.title}</Heading>
              {notice.publishedAt ? <Body muted>{t('Sent {when}', { when: when(notice.publishedAt) })}</Body> : null}
              {notice.retracted ? <Body muted>{t('Retracted')}</Body> : null}
              {notice.readCount !== null && notice.audienceCount !== null
                ? <Body muted>{t('Read by {read} of {audience}', { read: notice.readCount, audience: notice.audienceCount })}</Body> : null}
            </Card>
          ))}
    </Screen>
  );
}
