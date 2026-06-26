import type { Page } from '@playwright/test';

export type MissionResult = {
  missionId: string;
  pass: boolean;
  evidence: {
    attempted: string;
    detail?: string;
  };
};

export type Mission = {
  missionId: string;
  title: string;
  run: (page: Page) => Promise<MissionResult>;
};

async function tryExpectVisible(
  locator: {
    first: () => {
      waitFor: (options: { state: 'visible'; timeout: number }) => Promise<void>;
    };
  },
  timeoutMs = 3000
) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Screen reader persona mission: Create Campaign (focus on “real label” not placeholder).
 *
 * Seeded Bug #10: textarea in Internal notes section has NO label/aria-label.
 * That should cause getByRole('textbox', { name: 'Internal notes' }) to FAIL.
 */
export const createCampaignScreenReaderMission: Mission = {
  missionId: 'mission-create-campaign-sr',
  title: 'Create Campaign — Screen reader can locate all required fields by label',
  run: async (page) => {
    const attempted = 'textbox with accessible name "Internal notes"';

    await page.goto('http://localhost:3000/campaigns/new');
    await page.waitForLoadState('domcontentloaded');

    // The mission checks label association / accessible name.
    const internalNotes = page.getByRole('textbox', { name: 'Internal notes' });

    const exists = await tryExpectVisible(internalNotes);

    if (!exists) {
      return {
        missionId: 'mission-create-campaign-sr',
        pass: false,
        evidence: {
          attempted,
          detail:
            'Expected screen reader accessible name "Internal notes" for the notes textarea, but no matching textbox was found.',
        },
      };
    }

    return {
      missionId: 'mission-create-campaign-sr',
      pass: true,
      evidence: {
        attempted,
        detail: 'Found a textbox whose accessible name matches "Internal notes".',
      },
    };
  },
};

/**
 * Keyboard journey mission: Create Campaign (keyboard-only “complete the form” flow).
 *
 * This mission is designed to catch “passes axe but fails real journey” patterns:
 * - focuses should move logically
 * - required labeled fields must be findable by accessible name
 * - submit should be reachable
 *
 * Seeded Bug #10 should cause this mission to fail because the textarea has no real label.
 */
export const createCampaignKeyboardJourneyMission: Mission = {
  missionId: 'mission-create-campaign-keyboard-journey',
  title: 'Create Campaign — Keyboard journey can complete the form (labels discoverable)',
  run: async (page) => {
    const attempted = 'keyboard-only completion of required fields + notes textarea by label';

    await page.goto('http://localhost:3000/campaigns/new');
    await page.waitForLoadState('domcontentloaded');

    // Focus the first form control via keyboard.
    await page.keyboard.press('Tab');

    // Required fields we expect to be present by label.
    const requiredFields = [
      { name: 'Campaign name', value: 'My Campaign' },
      { name: 'Origin airport', value: 'MUC' },
      { name: 'Destination airport', value: 'BCN' },
      { name: 'Member tier', type: 'select' as const, value: 'GOLD' },
      { name: 'Start date', value: '2026-01-01' },
      { name: 'End date', value: '2026-12-31' },
      { name: 'Miles per booking', value: '1000' },
      // Bug #10: should fail because textarea has no SR-accessible name.
      { name: 'Internal notes', value: 'Optional notes via keyboard' },
    ];

    // Fill via role/name to simulate what SR/keyboard users need (discoverable by accessible name).
    for (const f of requiredFields) {
      if (f.type === 'select') {
        const sel = page.getByRole('combobox', { name: f.name });
        const ok = await tryExpectVisible(sel);
        if (!ok) {
          return {
            missionId: 'mission-create-campaign-keyboard-journey',
            pass: false,
            evidence: {
              attempted,
              detail: `Could not locate select by accessible name "${f.name}" via keyboard/SR semantics.`,
            },
          };
        }
        await sel.selectOption(f.value);
        continue;
      }

      const input = page.getByRole('textbox', { name: f.name });
      const ok = await tryExpectVisible(input);
      if (!ok) {
        return {
          missionId: 'mission-create-campaign-keyboard-journey',
          pass: false,
          evidence: {
            attempted,
            detail: `Could not locate textbox by accessible name "${f.name}". This breaks a keyboard-only journey.`,
          },
        };
      }

      // Type into the field.
      await input.fill('');
      await input.type(f.value);
    }

    // Submit.
    // Use the form submit button (primary) explicitly.
    // The accessible name can include extra whitespace depending on the component.
    const submit = page.getByRole('button').filter({ hasText: 'Create campaign' });
    await submit.first().click();


    // Confirm navigation away (the form demo navigates back to /campaigns)
    await page.waitForURL('**/campaigns', { timeout: 5000 });

    return {
      missionId: 'mission-create-campaign-keyboard-journey',
      pass: true,
      evidence: {
        attempted,
        detail: 'Keyboard journey completed and navigated to /campaigns.',
      },
    };
  },
};

/**
 * Screen reader persona mission: Cancel Campaign modal focuses the dialog.
 *
 * Seeded Bug #3: Modal does not focus on open; dialog is missing focus target logic.
 */
export const cancelCampaignModalFocusMission: Mission = {
  missionId: 'mission-cancel-campaign-modal-focus',
  title: 'Cancel Campaign — Modal steals focus on open (SR/keyboard)',
  run: async (page) => {
    await page.goto('http://localhost:3000/campaigns/CMP-1001');
    await page.waitForLoadState('domcontentloaded');

    // Activate modal via the primary button.
    await page.getByRole('button', { name: 'Cancel campaign' }).click();

    // Modal markup is missing aria-modal / focus, and its accessible name can vary.
    // Wait for the dialog by role only.
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Check focus: dialog should be focused OR contain a focused element inside.
    const active = await page.evaluate(
      () => document.activeElement?.getAttribute('role') || document.activeElement?.tagName
    );

    const hasFocusInside = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return false;
      return d.contains(document.activeElement);
    });

    const pass = hasFocusInside;

    return {
      missionId: 'mission-cancel-campaign-modal-focus',
      pass,
      evidence: {
        attempted: 'Focus moved into the dialog after it opened',
        detail: pass
          ? `Focus appears inside the dialog. activeElement=${active}`
          : `Focus did not move into the dialog. activeElement=${active}`,
      },
    };
  },
};

export const screenReaderMissions: Mission[] = [
  createCampaignScreenReaderMission,
  createCampaignKeyboardJourneyMission,
  cancelCampaignModalFocusMission,
];

