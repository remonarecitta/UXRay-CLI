import { test, expect } from '@playwright/test';
import { runScreenReaderPersonaMissions } from './personaRunner/screenReaderPersonaRunner';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test('persona runner — screen reader missions: Create Campaign + Cancel Campaign focus journey', async ({ page }) => {
  // Ensure locators work relative to app base
  await page.goto(`${BASE_URL}/campaigns/new`);

  const report = await runScreenReaderPersonaMissions(page);

  // Convert report into a single pass/fail expectation
  const failing = report.missions.filter((m) => !m.pass);

  // Build a compliance/coverage report to prevent blind spots.
  const { buildComplianceReport } = await import('./personaRunner/complianceReport');
  const compliance = buildComplianceReport({ personaId: report.personaId, missions: report.missions });

  if (failing.length) {
    console.log('Persona run report (FAIL):', JSON.stringify(report, null, 2));
    console.log('Compliance coverage report (FAIL):', JSON.stringify(compliance, null, 2));
  } else {
    console.log('Persona run report (PASS):', JSON.stringify(report, null, 2));
    console.log('Compliance coverage report (PASS):', JSON.stringify(compliance, null, 2));
  }


  // We intentionally expect this repo’s seeded bugs to fail these missions.
  // So the persona runner is verified by asserting at least one mission fails.
  expect(failing.length).toBeGreaterThan(0);

  // And specifically mission #mission-create-campaign-sr should fail due to Bug #10.
  const internalNotesMission = report.missions.find((m) => m.missionId === 'mission-create-campaign-sr');
  expect(internalNotesMission?.pass).toBe(false);
});

