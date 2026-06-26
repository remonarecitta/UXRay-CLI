
import type { MissionResult } from './screenReaderMissions';

export type ComplianceReport = {
  generatedAt: string;
  personas: Array<{
    personaId: string;
    missions: Array<{
      missionId: string;
      pass: boolean;
      evidence: MissionResult['evidence'];
      mappedSeededBugs: string[];
      mappedWcagAreas: string[];
    }>;
  }>;
  routes: Array<{
    route: string;
    exercised: string[];
    mappedSeededBugs: string[];
    mappedWcagAreas: string[];
  }>;
};

// Seeded bug mapping for the current persona missions.
// If you add missions later, extend this mapping.
const missionToSeededBugIds: Record<string, string[]> = {
  // Note: per-mission mapping should not duplicate within the same array.
  'mission-create-campaign-sr': ['#10'],
  'mission-create-campaign-keyboard-journey': ['#10'],
  'mission-cancel-campaign-modal-focus': ['#3'],
};

const missionToWcagAreas: Record<string, string[]> = {

  'mission-create-campaign-sr': ['WCAG 1.3.1/4.1.2 (Name, Role, Value / Info & Relationships)'],
  'mission-create-campaign-keyboard-journey': ['WCAG 1.3.1/4.1.2 (Name, Role, Value / Info & Relationships)'],
  'mission-cancel-campaign-modal-focus': ['WCAG 2.4.3 (Focus Order)'],
};

const missionToRoutes: Record<string, string[]> = {
  'mission-create-campaign-sr': ['/campaigns/new'],
  'mission-create-campaign-keyboard-journey': ['/campaigns/new'],
  'mission-cancel-campaign-modal-focus': ['/campaigns/:id'],
};

function uniq(arr: string[]) {
  return Array.from(new Set(arr));
}

export function buildComplianceReport(params: {
  personaId: string;
  missions: MissionResult[];
}): ComplianceReport {
  const { personaId, missions } = params;

  const mappedMissions = missions.map((m) => ({
    missionId: m.missionId,
    pass: m.pass,
    evidence: m.evidence,
    mappedSeededBugs: uniq(missionToSeededBugIds[m.missionId] || []),
    mappedWcagAreas: uniq(missionToWcagAreas[m.missionId] || []),
  }));


  const routeMap = new Map<
    string,
    {
      route: string;
      exercised: string[];
      mappedSeededBugs: string[];
      mappedWcagAreas: string[];
    }
  >();

  for (const mm of mappedMissions) {
    const routes = missionToRoutes[mm.missionId] || [];
    for (const r of routes) {
      const existing = routeMap.get(r);
      if (!existing) {
        routeMap.set(r, {
          route: r,
          exercised: [mm.missionId],
          mappedSeededBugs: mm.mappedSeededBugs,
          mappedWcagAreas: mm.mappedWcagAreas,
        });
      } else {
        existing.exercised.push(mm.missionId);
        existing.mappedSeededBugs.push(...mm.mappedSeededBugs);
        existing.mappedWcagAreas.push(...mm.mappedWcagAreas);
      }
    }
  }

  const routes = Array.from(routeMap.values()).map((r) => ({
    ...r,
    exercised: uniq(r.exercised),
    mappedSeededBugs: uniq(r.mappedSeededBugs),
    mappedWcagAreas: uniq(r.mappedWcagAreas),
  }));

  return {
    generatedAt: new Date().toISOString(),
    personas: [
      {
        personaId,
        missions: mappedMissions,
      },
    ],
    routes,
  };
}

