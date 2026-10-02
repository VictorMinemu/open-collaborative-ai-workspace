// IPC channel names (no dependencies, so the sandboxed preloads can import them cheaply).

export const Channels = {
  // window.ocwDesktop (web app, remote origin)
  status: "ocw:status",
  addProject: "ocw:add-project",
  listProjects: "ocw:list-projects",
  statusChanged: "ocw:status-changed",
  // window.ocwOnboarding (bundled local page)
  onboardingDefaults: "ocw-onboarding:defaults",
  onboardingStatus: "ocw-onboarding:status",
  onboardingCheckServer: "ocw-onboarding:check-server",
  onboardingEnroll: "ocw-onboarding:enroll",
  onboardingFinish: "ocw-onboarding:finish",
} as const;
