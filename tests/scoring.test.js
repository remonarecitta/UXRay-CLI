import { test } from "node:test";
import assert from "node:assert/strict";

function calculateAuditScore(findings, scoringWeights) {
  const automated = findings.filter((f) => f.source !== "manual-required");

  const uniqueFindings = [
    ...new Map(
      automated.map((f) => [`${f.title}|${f.source}`, f])
    ).values(),
  ];

  const deductions =
    uniqueFindings.filter((f) => f.severity === "critical").length * (scoringWeights.critical || 10) +
    uniqueFindings.filter((f) => f.severity === "major").length    * (scoringWeights.major    || 5)  +
    uniqueFindings.filter((f) => f.severity === "minor").length    * (scoringWeights.minor    || 2);

  return Math.max(0, 100 - deductions);
}

test("score is 100 with no findings", () => {
  assert.equal(calculateAuditScore([], { critical: 10, major: 5, minor: 2 }), 100);
});

test("score floors at 0 — never negative", () => {
  const findings = Array.from({ length: 20 }, (_, i) => ({
    id: `f-${i}`, title: `Finding ${i}`, source: "axe", severity: "critical",
  }));
  assert.equal(calculateAuditScore(findings, { critical: 10, major: 5, minor: 2 }), 0);
});

test("manual gaps do not affect score", () => {
  const findings = [
    { id: "m-1", title: "Audio captions", source: "manual-required", severity: "manual" },
  ];
  assert.equal(calculateAuditScore(findings, { critical: 10, major: 5, minor: 2 }), 100);
});

test("one critical deducts 10 points", () => {
  const findings = [
    { id: "f-1", title: "Button missing name", source: "axe", severity: "critical" },
  ];
  assert.equal(calculateAuditScore(findings, { critical: 10, major: 5, minor: 2 }), 90);
});

test("duplicates are deduplicated before scoring", () => {
  const findings = [
    { id: "f-1", title: "Button missing name", source: "axe", severity: "critical", route: "/a" },
    { id: "f-2", title: "Button missing name", source: "axe", severity: "critical", route: "/b" },
    { id: "f-3", title: "Button missing name", source: "axe", severity: "critical", route: "/c" },
  ];
  // Same title+source = 1 unique finding = 10 points deducted
  assert.equal(calculateAuditScore(findings, { critical: 10, major: 5, minor: 2 }), 90);
});

test("mixed severities calculate correctly", () => {
  const findings = [
    { id: "f-1", title: "Critical issue",  source: "axe",      severity: "critical" },
    { id: "f-2", title: "Major issue",     source: "keyboard", severity: "major" },
    { id: "f-3", title: "Minor issue",     source: "responsive", severity: "minor" },
  ];
  // 100 - (1×10 + 1×5 + 1×2) = 83
  assert.equal(calculateAuditScore(findings, { critical: 10, major: 5, minor: 2 }), 83);
});

test("custom scoring weights are respected", () => {
  const findings = [
    { id: "f-1", title: "Critical issue", source: "axe", severity: "critical" },
  ];
  assert.equal(calculateAuditScore(findings, { critical: 5, major: 2, minor: 1 }), 95);
});

test("different sources with same title count as separate findings", () => {
  const findings = [
    { id: "f-1", title: "No label", source: "axe",          severity: "major" },
    { id: "f-2", title: "No label", source: "screenReader",  severity: "major" },
  ];
  // Two unique findings (different source) = 100 - (2×5) = 90
  assert.equal(calculateAuditScore(findings, { critical: 10, major: 5, minor: 2 }), 90);
});
