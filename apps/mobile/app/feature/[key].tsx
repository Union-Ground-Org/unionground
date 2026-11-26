import { useLocalSearchParams } from 'expo-router';

import { FeatureScreen } from '../../src/features/FeatureScreen';
import { PinnedHeaderScreen } from '../../src/components/PinnedHeader';
import { Screen, StateMessage } from '../../src/components/ui';
import { FEATURE_TITLES, isFeatureKey } from '../../src/lib/featureCatalog';
import { useApp } from '../../src/state/AppProvider';
import { TaskDocumentHandoffProvider } from '../../src/features/TaskDocumentHandoffProvider';
import { useNativeUi } from '../../src/lib/useNativeUi';

export default function FeatureRoute() {
  const { catalogLabel, language, t } = useNativeUi();
  const { key, source } = useLocalSearchParams<{ key?: string; source?: string }>();
  const { previewHat } = useApp();
  if (!key || !isFeatureKey(key)) {
    const title = t('That workspace is not in this app');
    return (
      <PinnedHeaderScreen screenName={title} language={language}>
        <Screen>
          <StateMessage fitWords title={title} body={t('Union Ground only opens destinations that exist in the product.')} />
        </Screen>
      </PinnedHeaderScreen>
    );
  }
  const content = (
    <PinnedHeaderScreen screenName={catalogLabel(FEATURE_TITLES[key])} language={language}>
      <FeatureScreen
        key={`${previewHat ?? 'none'}:${key}:${source ?? 'index'}`}
        featureKey={key}
        sourceID={source}
      />
    </PinnedHeaderScreen>
  );
  return key === 'tasks'
    ? <TaskDocumentHandoffProvider key={`${key}:${source ?? 'index'}`}>{content}</TaskDocumentHandoffProvider>
    : content;
}
