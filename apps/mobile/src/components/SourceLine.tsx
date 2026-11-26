import { useState } from 'react';
import { Linking, View } from 'react-native';
import { Text } from './Text';
import { Body, Button } from './ui';
import { spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
// One register and one model with the web SourceLine, without the catalogue:
// sourceLine.* is a namespace chunk of src/lib/i18n.js and src/lib/sourceLine.js
// is catalogue-free (PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917).
import { sourceLineT } from '../../../../src/lib/i18n/sourceLine.js';
import { sourceLineModel, type SourceLineEntry } from '../../../../src/lib/sourceLine.js';

type Language = 'en' | 'es';

// REQ-UG-PROVENANCE-CONTRACT-20261012: the native source line,
// "Source: <publisher>, retrieved <date ET>", the publisher opening the
// captured URL, and for a computed or authored item a toggle that lists its
// inputs. A record that cannot be shown says so. docs/conventions/provenance.md.
function SourceText({ entry, language, onOpen }: { entry: SourceLineEntry; language: Language; onOpen: (href: string) => void }) {
  const theme = useTheme();
  return <>
    <Text
      accessibilityRole="link"
      accessibilityLabel={sourceLineT(language, 'sourceLine.opensBrowser', { publisher: entry.publisher })}
      onPress={() => onOpen(entry.href)}
      style={{ color: theme.foreground, textDecorationLine: 'underline' }}
    >{entry.publisher}</Text>
    {entry.title ? ` · ${entry.title}` : ''}
    {`, ${sourceLineT(language, 'sourceLine.retrieved', { date: entry.retrieved })}`}
  </>;
}

export function SourceLine({ provenance, inputs = [], language }: { provenance: unknown; inputs?: unknown[]; language: Language }) {
  const [expanded, setExpanded] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const model = sourceLineModel(provenance, { lang: language, inputs });
  if (!model) return <Body accessibilityRole="text">{sourceLineT(language, 'sourceLine.unavailable', {})}</Body>;
  const open = (href: string) => {
    setOpenFailed(false);
    void Linking.openURL(href).catch(() => setOpenFailed(true));
  };
  return <View style={{ gap: spacing.xs }}>
    <Body muted>{`${sourceLineT(language, 'sourceLine.label', {})} `}<SourceText entry={model} language={language} onOpen={open} /></Body>
    {model.inputs.length ? <>
      <Button
        variant="secondary"
        label={expanded ? sourceLineT(language, 'sourceLine.hideInputs', {}) : sourceLineT(language, 'sourceLine.inputs', { count: model.inputs.length })}
        onPress={() => setExpanded((value) => !value)}
      />
      {expanded ? model.inputs.map((input) => <Body key={input.key} muted>
        {'publisher' in input
          ? <SourceText entry={input} language={language} onOpen={open} />
          : sourceLineT(language, 'sourceLine.inputReference', { reference: input.reference })}
      </Body>) : null}
    </> : null}
    {openFailed ? <Body accessibilityRole="alert">{sourceLineT(language, 'sourceLine.openFailed', {})}</Body> : null}
  </View>;
}
