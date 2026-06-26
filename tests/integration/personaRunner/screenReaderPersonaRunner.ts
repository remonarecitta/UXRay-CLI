import type { Page } from '@playwright/test';
import { screenReaderMissions, type Mission } from './screenReaderMissions';

export type PersonaRunReport = {
  personaId: string;
  missions: Awaited<ReturnType<Mission['run']>>[];
};

export async function runScreenReaderPersonaMissions(page: Page): Promise<PersonaRunReport> {
  const missions = screenReaderMissions;
  const results: PersonaRunReport['missions'] = [];

  for (const m of missions) {
    // eslint-disable-next-line no-await-in-loop
    const r = await m.run(page);
    results.push(r);
  }

  return {
    personaId: 'persona-screenreader',
    missions: results,
  };
}

