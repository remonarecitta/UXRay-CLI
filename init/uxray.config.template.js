export default {
  baseUrl: "http://localhost:3000",
  appName: "My App",
  sourceRoot: "src",

  // Remove if no login required
  auth: {
    loginUrl:   "/login",
    username:   process.env.UXRAY_USER,
    password:   process.env.UXRAY_PASS,
    waitFor:    "[data-testid='dashboard'], main",
    cookieFile: ".uxray-session.json",
  },

  routes: [
    { name: "Home",   path: "/" },
    { name: "List",   path: "/campaigns",     requiresAuth: true },
    { name: "Create", path: "/campaigns/new", requiresAuth: true },
  ],

  viewports: {
    mobile:  { width: 375,  height: 812  },
    tablet:  { width: 768,  height: 1024 },
    desktop: { width: 1280, height: 800  },
    dark:    { width: 1280, height: 800, darkMode: true },
  },

  thresholds: {
    contrast:     4.5,
    touchPx:      44,
    fontScalePct: 200,
    maxTabs:      60,
  },

  checks: ["axe", "keyboard", "screenReader", "responsive", "errors"],

  personas: {
    screenReader: { enabled: true },
    keyboard:     { enabled: true },
    mobile:       { enabled: true },
    senior:       { enabled: true },
  },

  missions: {
    createForm: {
      path:       "/campaigns/new",
      submitText: "Create",
      successUrl: "**/campaigns",
      formTestId: "campaign-form",
      // unlabeledField: "Internal notes",
      fields: [
        // { role: "textbox", name: "Campaign name", testId: "name-input", value: "Test" },
      ],
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
