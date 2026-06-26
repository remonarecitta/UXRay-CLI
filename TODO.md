# TODO — WCAG 2.1 AA coverage expansion

## Step 1: Inspect current automated coverage inputs
- [x] Read `init/uxray.config.template.js` to confirm enabled check modules.
- [x] Inspect `src/checks/axe.mjs` to see axe is currently run with default rule set.
- [ ] Inspect remaining check modules for their explicit WCAG tags (keyboard/screenReader/responsive/errors).

## Step 2: Identify missing WCAG 2.1 AA areas
- [ ] Build a list of major WCAG 2.1 AA Success Criteria clusters not targeted by current custom checks (time-based media, motion/seizures, enough time, input assistance/error prevention, predictable behavior, etc.).

## Step 3: Expand automated coverage
- [ ] Configure axe to run a broader rule set / include relevant impact profiles (and/or additional axe scans).
- [ ] Add supplemental custom automated checks using Playwright DOM evaluation for common missing SCs.

## Step 4: Wire checks into config
- [ ] Update `init/uxray.config.template.js` (or provide new config option) to enable the newly added checks.

## Step 5: Testing
- [ ] Run the CLI against a sample app (using existing dev URLs) and verify new findings appear.

## Step 6: Documentation
- [ ] Update README/docs with what is automated vs manual review for WCAG 2.1 AA.
