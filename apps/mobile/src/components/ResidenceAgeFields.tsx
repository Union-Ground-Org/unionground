import { useId, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';

import { Body, Button, Heading } from './ui';
import { RESIDENCE_REGIONS } from '../../../../src/lib/residenceRegions.js';
import {
  LEGAL_ACCEPTANCE_AGE_HELP,
  LEGAL_ACCEPTANCE_AGE_RECHECK,
  LEGAL_ACCEPTANCE_STATE,
  LEGAL_ACCEPTANCE_STATE_CHOOSE,
  legalAcceptanceAgeLabel,
} from '../lib/legalAcceptance';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

type Region = { code: string; en: string; es: string };
const REGIONS = RESIDENCE_REGIONS as readonly Region[];

// The native invitation clickwrap and the
// re-acceptance card ask where the person lives, then show the one age
// attestation that state selects, the same rule and list as the website
// (src/components/ResidenceAgeFields.jsx). Changing the state clears the
// checkbox, because the sentence the person agreed to has changed. The server
// derives the rule from the state again.
export function ResidenceAgeFields({ residenceState, onResidenceState, ageAttested, onAgeAttested, disabled = false }: {
  residenceState: string;
  onResidenceState: (code: string) => void;
  ageAttested: boolean;
  onAgeAttested: (value: boolean) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  //  (M1-2): a checked age box cleared by a new state says so, through the
  // app's announcement queue, until the box is checked again.
  const [recheck, setRecheck] = useState(false);
  const announce = useAccessibilityAnnouncementQueue(useId());
  const chosen = REGIONS.find((region) => region.code === residenceState);
  const ageLabel = legalAcceptanceAgeLabel(residenceState);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${LEGAL_ACCEPTANCE_STATE}: ${chosen ? chosen.en : LEGAL_ACCEPTANCE_STATE_CHOOSE}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[styles.row, { borderColor: theme.border }]}
      >
        <Body muted>{LEGAL_ACCEPTANCE_STATE}</Body>
        <Body>{chosen ? chosen.en : LEGAL_ACCEPTANCE_STATE_CHOOSE}</Body>
      </Pressable>
      <Body muted>{LEGAL_ACCEPTANCE_AGE_HELP}</Body>
      {ageLabel ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={ageLabel}
          accessibilityState={{ checked: ageAttested, disabled }}
          disabled={disabled}
          onPress={() => { if (!ageAttested) setRecheck(false); onAgeAttested(!ageAttested); }}
          style={[styles.row, { borderColor: theme.border }]}
        ><Body>{ageAttested ? '☑' : '☐'} {ageLabel}</Body></Pressable>
      ) : null}
      {recheck && ageLabel && !ageAttested ? <Body>{LEGAL_ACCEPTANCE_AGE_RECHECK}</Body> : null}
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <Heading level={2}>{LEGAL_ACCEPTANCE_STATE}</Heading>
          <FlatList
            style={styles.list}
            data={REGIONS}
            keyExtractor={(region) => region.code}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel={item.en}
                accessibilityState={{ checked: item.code === residenceState }}
                onPress={() => {
                  onResidenceState(item.code);
                  if (ageAttested) {
                    setRecheck(true);
                    announce(LEGAL_ACCEPTANCE_AGE_RECHECK);
                  }
                  onAgeAttested(false);
                  setOpen(false);
                }}
                style={[styles.option, { borderColor: theme.border }]}
              ><Body>{item.code === residenceState ? '● ' : ''}{item.en}</Body></Pressable>
            )}
          />
          <Button label="Cancel" variant="secondary" onPress={() => setOpen(false)} />
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: minimumTouchTarget, justifyContent: 'center', padding: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md },
  sheet: { flex: 1, gap: spacing.md, padding: spacing.lg, paddingTop: spacing.xl },
  // The list takes the space between the heading and Cancel and scrolls
  // inside it; without flex it grows to all 57 rows and pushes Cancel off screen.
  list: { flex: 1 },
  option: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth },
});
