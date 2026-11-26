import { useRouter } from 'expo-router';
import { PinnedHeaderScreen } from '../../src/components/PinnedHeader';
import { UnionCatalogScreen, useUnionCatalogCopy } from '../../src/features/UnionCatalogScreen';

export default function PublicUnionsRoute() {
  const router = useRouter();
  const copy = useUnionCatalogCopy();
  return <PinnedHeaderScreen screenName={copy.title} headingTestID="native-route-public-unions" onBack={() => router.canGoBack() ? router.back() : router.replace('/')}>
    <UnionCatalogScreen />
  </PinnedHeaderScreen>;
}
