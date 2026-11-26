import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043),
// gate round 1 r1g2: the case screen keeps this card mounted when the route
// moves to another case, so every late answer must belong to the current key.
const source = readFileSync(fileURLToPath(new URL('./CaseRowTopicCards.tsx', import.meta.url)), 'utf8');
const hook = source.slice(source.indexOf('function useSetting'), source.indexOf('function SettingCard'));

describe('case-topic cards drop answers for an earlier issue', () => {
  it('starts a new generation for every key and on unmount', () => {
    expect(hook).toContain('const current = ++generation.current;');
    expect(hook).toContain('const generation = useBusinessOperationCache(key ?? null, () => ({ current: 0 }));');
    expect(hook).toContain('useEffect(() => () => { generation.current += 1; }, [generation]);');
    expect(hook).toContain('const requests = useBusinessRequests(writer, key);');
    expect(hook).toContain('}, [key, live, requests,');
  });

  it('keeps outcomes generation-bound and releases the composing person after settlement', () => {
    expect(hook).toContain('if (ticket.isCurrent() && current === generation.current) setSetting(value);');
    const change = hook.slice(hook.indexOf('async function change'));
    expect(change).toContain('const current = requests.capture().isCurrent;');
    // Both accepted state and its read generation belong to the captured
    // person/subject. A retired ticket cannot skip either settlement.
    expect(change).not.toContain('if (!current()) return;');
    expect(change).toContain('await operate(true, async () => {');
    expect(hook).toContain('const [operate] = useBusinessOperation<boolean>(setBusy, false);');
    expect(change).toContain('ownedGeneration = ++generation.current;');
    expect(change).toContain('const reading = ++generation.current;');
    expect(change).toContain('ownedGeneration = reading;');
    expect(change).toContain("if (reading !== generation.current || !current()) throw new Error('Saved; reread superseded');");
    expect(change).toContain('else if (ownedGeneration === generation.current) {');
    expect(hook).toContain('useBusinessSubjectState<Setting | null>(key ?? null, null)');
    expect(hook).not.toContain('mounted.current');
  });

  it('renders each card only for the person the server says may change it', () => {
    expect(source).toContain('return value.canChange ? { value: value.enabled, note: CHAPTER_NOTE } : null;');
    expect(source).toContain('if (!value.canChange) return null;');
  });

  it('keeps a refused save and a failed re-read apart (#7059 gate r2s1/r4s1)', () => {
    const change = hook.slice(hook.indexOf('async function change'));
    expect(change).toContain('const outcome = await saveThenReload(async () => {');
    expect(change).toContain('await save(writer, key, value);');
    expect(change).toContain("if (await checkBusinessContinuation(writer, current) !== 'current') throw new Error('Saved; refresh unavailable');");
    expect(change).toContain("if (outcome.failure === 'save') setFailure('save');");
    expect(change).toContain('setSetting(outcome.setting);');
    expect(change).toContain('setFailure(outcome.failure);');
    expect(source).toContain('{failure ? <Body>{SAVE_FAILURE_MESSAGES[failure]}</Body> : null}');
    expect(source).toContain('note: caseTopicNote(value.chapterShown)');
  });
});
