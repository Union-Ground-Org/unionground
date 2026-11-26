import { useLocalSearchParams, useRouter } from 'expo-router';
import { PinnedHeaderScreen } from '../../../src/components/PinnedHeader';
import { UnionCatalogScreen, useUnionCatalogCopy } from '../../../src/features/UnionCatalogScreen';

export default function PublicUnionProfileRoute() {
  const { key } = useLocalSearchParams<{ key?: string }>();
  const router = useRouter();
  const copy = useUnionCatalogCopy();
  return <PinnedHeaderScreen screenName={copy.title} onBack={() => router.canGoBack() ? router.back() : router.replace('/public/unions')}>
    <UnionCatalogScreen key={key} catalogKey={key ?? 'invalid'} />
  </PinnedHeaderScreen>;
}
