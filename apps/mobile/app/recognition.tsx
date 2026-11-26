import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet } from 'react-native';
import { Text } from '../src/components/Text';

import { PinnedHeaderScreen } from '../src/components/PinnedHeader';
import { Body, Button, Card, Heading, Notice, Screen } from '../src/components/ui';
import { useTheme } from '../src/theme/ThemeProvider';
import { typeface } from '../src/theme/typeface';

// The public source the screen cites. It opens in the browser; nothing about
// the worker or the campaign is sent with it.
const NLRB_GUIDANCE_URL = 'https://www.nlrb.gov/about-nlrb/rights-we-protect/whats-law';

// Recognition and an election are separate paths, and neither is a card
// count (PRODUCT.md design principle 4). The screen states that plainly and
// points to qualified review instead of drawing a legal conclusion.
export default function RecognitionScreen() {
  return <PinnedHeaderScreen screenName="Recognition paths"><RecognitionContent /></PinnedHeaderScreen>;
}

function RecognitionContent() {
  const router = useRouter();
  const theme = useTheme();
  const [openFailed, setOpenFailed] = useState(false);

  async function openGuidance() {
    setOpenFailed(false);
    try {
      await Linking.openURL(NLRB_GUIDANCE_URL);
    } catch {
      setOpenFailed(true);
    }
  }

  return (
    <Screen>
      <Text style={[styles.eyebrow, { color: theme.primary }]}>PLAN THE NEXT STEP</Text>
      <Heading>Recognition paths</Heading>
      <Body>A card majority, recognition, and a first contract are different milestones. Review the current requirements with a qualified organizer.</Body>
      <Card>
        <Heading level={2}>Voluntary recognition</Heading>
        <Body>The employer recognizes the chosen representative after a showing of majority support. Confirm which rules and procedures apply to your workplace.</Body>
      </Card>
      <Card>
        <Heading level={2}>Representation election</Heading>
        <Body>A petition starts a formal election process. Eligibility, the bargaining unit, and the election outcome each need their own review.</Body>
      </Card>
      <Card>
        <Heading level={2}>After recognition</Heading>
        <Body>Bargaining a first contract starts only once the representative is recognized or certified. Until then, nothing in this app is a contract.</Body>
      </Card>
      {openFailed ? <Notice>The guidance could not open in a browser. Check your connection and try again.</Notice> : null}
      <Button label="Read current NLRB guidance" variant="secondary" onPress={() => { void openGuidance(); }} />
      <Button label="Ask the Guide about recognition" onPress={() => router.push('/compass' as never)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  eyebrow: { fontSize: 12, lineHeight: 16, ...typeface.heading, letterSpacing: 1.1 },
});
