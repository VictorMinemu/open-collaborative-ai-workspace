// IPC channel names (no dependencies, so the sandboxed preloads can import them cheaply).

export const Channels = {
  // window.ocwDesktop (web app, remote origin)
  status: "ocw:status",
  addProject: "ocw:add-project",
  listProjects: "ocw:list-projects",
  statusChanged: "ocw:status-changed",
  /** Dock/taskbar badge = the unread mention count (CHAT-10); the only thing web content may set. */
  setBadgeCount: "ocw:set-badge-count",
  // window.ocwOnboarding (bundled local page)
  onboardingDefaults: "ocw-onboarding:defaults",
  onboardingStatus: "ocw-onboarding:status",
  onboardingCheckServer: "ocw-onboarding:check-server",
  onboardingEnroll: "ocw-onboarding:enroll",
  onboardingFinish: "ocw-onboarding:finish",
} as const;
