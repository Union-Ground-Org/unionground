import * as Linking from 'expo-linking';
import { View } from 'react-native';

import { Body, Button, Card, Heading } from './ui';
import { ATTRIBUTION_NOTICE, OFFICIAL_SERVICE_LABEL, operatorPageUrl, phoneBrand, showsOfficialServiceMark } from '../lib/brand';
import { mobileConfig } from '../lib/config';

// About this app (Settings): who runs the server this app talks to, the
// "Official Union Ground service" mark (official build on the official
// backend only), the NOTICE attribution, and the source code the AGPL offers.
export function ServiceIdentityCard() {
  const operatorUrl = mobileConfig.backendConfigured ? operatorPageUrl(mobileConfig.portalBaseUrl) : null;
  const official = showsOfficialServiceMark(phoneBrand, mobileConfig);
  return (
    <Card>
      <Heading level={2}>About this app</Heading>
      {official ? <Body>{OFFICIAL_SERVICE_LABEL.en}</Body> : null}
      <View>
        {operatorUrl ? (
          <Button label="Who runs this server" variant="secondary" onPress={() => { void Linking.openURL(operatorUrl); }} />
        ) : (
          <Body muted>This app is not connected to a server, so no one runs one for it yet.</Body>
        )}
      </View>
      <Body muted>{ATTRIBUTION_NOTICE}</Body>
      <Button label="Source code" variant="secondary" onPress={() => { void Linking.openURL(phoneBrand.sourceCodeUrl); }} />
      <Body muted>Running a modified copy? Build it with SOURCE_CODE_URL set to your own source code, as the license requires.</Body>
    </Card>
  );
}
