import { describe, expect, it } from 'vitest';

import { notificationCopy, notificationCopyFor } from './notificationCopy';

describe('native notification copy', () => {
  it('keeps every account workflow message available in English and Spanish', () => {
    expect(Object.keys(notificationCopy.es).sort()).toEqual(Object.keys(notificationCopy.en).sort());
    expect(notificationCopyFor('es')).toMatchObject({
      title: 'Notificaciones privadas',
      enable: 'Activar',
      reconnect: 'Reconectar',
      disable: 'Desactivar',
      unavailableTitle: 'Notificaciones no disponibles',
    });
  });

  it('fails safely to English for an unsupported or missing profile language', () => {
    expect(notificationCopyFor('fr')).toBe(notificationCopy.en);
    expect(notificationCopyFor(null)).toBe(notificationCopy.en);
  });
});
