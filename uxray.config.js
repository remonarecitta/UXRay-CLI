export default {
  baseUrl:    "http://localhost:3000",
  appName:    "UXRay Demo App",
  sourceRoot: "src",

  // No auth — mock app is open
  auth: null,

  routes: [
    { name: "Campaigns",    path: "/campaigns" },
    { name: "Detail",       path: "/campaigns/CMP-1001" },
    { name: "Create",       path: "/campaigns/new" },
  ],

  viewports: {
    mobile:  { width: 375,  height: 812 },
    desktop: { width: 1280, height: 800 },
    dark:    { width: 1280, height: 800, darkMode: true },
  },

  thresholds: {
    contrast:     4.5,
    touchPx:      44,
    fontScalePct: 200,
    maxTabs:      60,
  },

  checks: ["axe", "keyboard", "responsive", "wcagExtended"],

  personas: {
    screenReader: { enabled: true },
    keyboard:     { enabled: true },
    mobile:       { enabled: true },
    senior:       { enabled: true },
  },

  missions: {
    createForm: {
      path:           "/campaigns/new",
      submitText:     "Create campaign",
      successUrl:     "**/campaigns",
      unlabeledField: "Notes for internal review",
      fields: [
        { role: "textbox", name: "Campaign name",       testId: "campaign-form-name",        value: "Test Campaign" },
        { role: "textbox", name: "Description",         testId: "campaign-form-description", value: "A test" },
        { role: "textbox", name: "Origin airport",      testId: "campaign-form-origin",      value: "MUC" },
        { role: "textbox", name: "Destination airport", testId: "campaign-form-destination", value: "BCN" },
      ],
    },
    cancelModal: {
      path:        "/campaigns/CMP-1001",
      triggerText: "Cancel campaign",
    },
  },

  output: {
    dir:         ".uxray",
    findings:    "findings.json",
    report:      "report.html",
    reportJson:  "report.json",
    screenshots: "screenshots",
  },

  scoring: { critical: 10, major: 5, minor: 2 },
};