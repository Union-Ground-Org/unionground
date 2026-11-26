import { useLocalSearchParams } from 'expo-router';

import { PinnedHeaderScreen } from '../../src/components/PinnedHeader';
import { LegalDocumentScreen } from '../../src/features/LegalDocumentScreen';
import { legalDocument } from '../../src/lib/legalDocuments';
import { useNativeUi } from '../../src/lib/useNativeUi';

export default function LegalRoute() {
  const { page } = useLocalSearchParams<{ page?: string }>();
  const { language, t } = useNativeUi();
  const key = page ?? '';
  return (
    <PinnedHeaderScreen screenName={legalDocument(key)?.title ?? t('Legal')} language={language}>
      <LegalDocumentScreen page={key} />
    </PinnedHeaderScreen>
  );
}
