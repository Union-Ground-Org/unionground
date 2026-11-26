# MI1 native Expo integration

Native surfaces for organization operations, integrations, analytics, and
worker Q&A. Each destination reuses platform-neutral engines;
web JSX is fenced from the Metro graph.

## Boundaries

- Shared pure modules under `src/features/operations` are imported. Web JSX
  desks are not mounted.
- Authenticated reads use the selected campaign's organization id and the same
  admin + MFA RPC boundary as web. The phone does not invent an organization
  id, insert audit rows, seed job runs, or execute jobs.
- Pay remains outside this delivery. Preview data and authenticated data never
  share persistence.
- Home overlay drawers, elevation tokens, and 48px targets are unchanged.

## Destinations

| Key | Route | Who |
| --- | --- | --- |
| `operations` | `/feature/operations` | Admin |
| `integrations` | `/feature/integrations` | Organization admin or Campaign chair |
| `analytics` | `/feature/analytics` | Organization staff grant |
| `qa` | `/feature/qa` | Active campaign worker; campaign leader queue by grant |

## Persistence honesty

`MI1_NATIVE_PERSISTENCE` in `src/lib/mi1Shared.ts` records that the ledger and
job RPCs are wired. Empty audit results and `never_run` job rows remain honest
states when no activity or scheduler run exists.
