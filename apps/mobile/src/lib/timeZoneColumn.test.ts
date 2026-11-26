// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), final of #9617
// (stage 568B): before the time_zone migration applies, a case or step
// deadline read runs again without the column instead of failing.
import { describe, expect, it } from 'vitest';
import { missingTimeZoneColumn, readWithTimeZoneFallback, withoutTimeZoneColumn } from './timeZoneColumn';

describe('reads that carry time_zone before its migration applies', () => {
  it('knows the missing-column answers that name time_zone, and only those', () => {
    expect(missingTimeZoneColumn({ code: '42703', message: 'column member_cases.time_zone does not exist' })).toBe(true);
    expect(missingTimeZoneColumn({ code: 'PGRST204', message: "Could not find the 'time_zone' column of 'casework_deadlines' in the schema cache" })).toBe(true);
    expect(missingTimeZoneColumn({ code: '42703', message: 'column member_cases.deadline does not exist' })).toBe(false);
    expect(missingTimeZoneColumn({ code: '42501', message: 'time_zone permission denied' })).toBe(false);
    expect(missingTimeZoneColumn(null)).toBe(false);
  });

  it('drops only the time_zone column', () => {
    expect(withoutTimeZoneColumn('case_id,id,label,due_at,status,time_zone')).toBe('case_id,id,label,due_at,status');
    expect(withoutTimeZoneColumn('id,deadline')).toBe('id,deadline');
  });

  it('runs the read once more without the column, and leaves every other error alone', async () => {
    const asked: string[] = [];
    const missing = await readWithTimeZoneFallback('id,deadline,time_zone', async (columns) => {
      asked.push(columns);
      return columns.includes('time_zone') ? { data: null, error: { code: '42703', message: 'column member_cases.time_zone does not exist' } } : { data: [{ id: 'c' }], error: null };
    });
    expect(missing).toEqual({ data: [{ id: 'c' }], error: null });
    expect(asked).toEqual(['id,deadline,time_zone', 'id,deadline']);
    const offline = await readWithTimeZoneFallback('id,time_zone', async () => ({ data: null, error: { message: 'offline' } }));
    expect(offline.error).toEqual({ message: 'offline' });
  });
});
