import { describe, expect, it, vi } from 'vitest';

import type { CompassSource } from '../models/member';
import {
  activateCompassSource,
  compassSourceMatchesReaderRecord,
  compassSourcesWithDestinations,
  compassSourceWithDestination,
} from './compassSourceNavigation';

function source(overrides: Partial<CompassSource> = {}): CompassSource {
  return {
    id: 'kb:article-12',
    kind: 'contract',
    title: 'Article 12 — Discipline',
    ref: 'Contract · Article 12',
    destination: '/feature/rights?source=kb%3Aarticle-12',
    ...overrides,
  };
}

describe('Guide approved-source navigation', () => {
  it('maps approved source kinds to reader routes already owned by the app', () => {
    expect(compassSourceWithDestination(source())).toMatchObject({ destination: '/feature/rights?source=kb%3Aarticle-12' });
    expect(compassSourceWithDestination({
      id: 'doc:handbook', kind: 'document', title: 'Worker handbook', ref: 'Campaign library · handbook',
    })).toMatchObject({ destination: '/feature/chapter?source=doc%3Ahandbook' });
    expect(compassSourceWithDestination({
      id: 'public:unions', kind: 'public_page', title: 'Union catalog', ref: '/public/unions',
    })).toMatchObject({ destination: '/public/unions' });
    // The public chapter directory does not ship, so its pages never route.
    expect(compassSourceWithDestination({
      id: 'public:hours', kind: 'public_page', title: 'Office hours', ref: '/public/chapters/harborview/about-us/office-hours',
    })).toMatchObject({ destination: null });
  });

  it('recognizes the live FAQ vocabulary and carries the exact cited article', () => {
    expect(compassSourceWithDestination({
      id: 'kb:leave-faq', kind: 'faq', title: 'Leave FAQ', ref: 'Paid leave',
    })).toMatchObject({ destination: '/feature/rights?source=kb%3Aleave-faq' });
  });

  it('matches a reader record only to the routed source identity', () => {
    expect(compassSourceMatchesReaderRecord('kb:leave-faq', 'kb', 'leave-faq')).toBe(true);
    expect(compassSourceMatchesReaderRecord('kb:leave-faq', 'kb', 'discipline')).toBe(false);
    expect(compassSourceMatchesReaderRecord('doc:handbook', 'doc', 'handbook')).toBe(true);
  });

  it('requires a destination before a row may route', () => {
    const navigate = vi.fn();
    const populate = vi.fn();

    expect(activateCompassSource(source({ kind: 'unknown', ref: 'Unmapped source', destination: null }), navigate, populate))
      .toBe('populated');
    expect(navigate).not.toHaveBeenCalled();
    expect(populate).toHaveBeenCalledWith('Tell me more about Article 12 — Discipline (Unmapped source).');
  });

  it('opens a resolved destination without populating or submitting a question', () => {
    const navigate = vi.fn();
    const populate = vi.fn();

    expect(activateCompassSource(source(), navigate, populate)).toBe('opened');
    expect(navigate).toHaveBeenCalledWith('/feature/rights?source=kb%3Aarticle-12');
    expect(populate).not.toHaveBeenCalled();
  });

  it('does not turn an arbitrary public ref into a route', () => {
    expect(compassSourceWithDestination({
      id: 'public:unsafe', kind: 'public', title: 'Unknown page', ref: 'https://example.com/not-owned',
    }).destination).toBeNull();
  });
});

// #7504 and its follow-up: the server now lists only the sources an answer
// cites, a chapter-library source included when the answer cites the article
// in its excerpt. The native card renders exactly that list.
describe('Guide approved sources from the cited-source list', () => {
  it('keeps the server list and its order, and routes each source to a reader that can open it', () => {
    const shaped = compassSourcesWithDestinations([
      { id: 'kb:handbook', kind: 'faq', title: 'Committee handbook', ref: 'Campaign library · Committee handbook' },
      { id: 'kb:article-12', kind: 'contract', title: 'Article 12 — Discipline', ref: 'County CBA 2025–2028 · Article 12' },
      { id: 'doc:minutes', kind: 'document', title: 'October minutes', ref: 'Campaign library · Minutes' },
    ]);
    expect(shaped.map((item) => item.id)).toEqual(['kb:handbook', 'kb:article-12', 'doc:minutes']);
    // #7536 review P2: a kb: article whose ref says "Chapter library" opens in
    // the knowledge reader, which resolves kb:<slug>; the chapter reader would
    // show the unavailable-source state for it.
    expect(shaped[0]).toMatchObject({ destination: '/feature/rights?source=kb%3Ahandbook' });
    expect(compassSourceMatchesReaderRecord(shaped[0]?.id, 'kb', 'handbook')).toBe(true);
    expect(compassSourceMatchesReaderRecord(shaped[0]?.id, 'doc', 'handbook')).toBe(false);
    expect(shaped[1]).toMatchObject({ destination: '/feature/rights?source=kb%3Aarticle-12' });
    expect(compassSourceMatchesReaderRecord(shaped[1]?.id, 'kb', 'article-12')).toBe(true);
    expect(shaped[2]).toMatchObject({ destination: '/feature/chapter?source=doc%3Aminutes' });
    expect(compassSourceMatchesReaderRecord(shaped[2]?.id, 'doc', 'minutes')).toBe(true);
  });

  it('shows no approved-sources block for an answer that cites none', () => {
    expect(compassSourcesWithDestinations([])).toEqual([]);
    expect(compassSourcesWithDestinations(undefined)).toEqual([]);
  });

  it('drops a malformed row rather than inventing a source', () => {
    expect(compassSourcesWithDestinations([
      { id: 'kb:a', kind: 'contract', title: 'Article 9', ref: 'Contract · Article 9' },
      { id: 'kb:b', kind: 'contract', title: 'No ref' },
      null,
      ['kb:c'],
    ]).map((item) => item.id)).toEqual(['kb:a']);
  });
});
