// IPC channel names (no dependencies, so the sandboxed preloads can import them cheaply).

export const Channels = {
  // window.ocwDesktop (web app, remote origin)
  status: "ocw:status",
  addProject: "ocw:add-project",
  listProjects: "ocw:list-projects",
  statusChanged: "ocw:status-changed",
  /** Dock/taskbar badge = the unread mention count (CHAT-10); the only thing web content may set. */
  setBadgeCount: "ocw:set-badge-count",
  /**
   * "Sign in with ChatGPT" without pasting (05-07): a one-shot 127.0.0.1 callback listener in the main process.
   * prepare → { flowToken, port }; await(flowToken, authorizeUrl) opens the system browser and resolves with the
   * loopback URL; cancel(flowToken) closes it.
   */
  chatgptLoopbackPrepare: "ocw:chatgpt-loopback-prepare",
  chatgptLoopbackAwait: "ocw:chatgpt-loopback-await",
  chatgptLoopbackCancel: "ocw:chatgpt-loopback-cancel",
  // window.ocwOnboarding (bundled local page)
  onboardingDefaults: "ocw-onboarding:defaults",
  onboardingStatus: "ocw-onboarding:status",
  onboardingCheckServer: "ocw-onboarding:check-server",
  onboardingEnroll: "ocw-onboarding:enroll",
  onboardingFinish: "ocw-onboarding:finish",
} as const;
