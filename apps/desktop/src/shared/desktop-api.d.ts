// Type of `window.ocwDesktop` for web code that wants to feature-detect the desktop shell.
import type {
  AddProjectResult,
  ChatgptLoopbackPrepared,
  ChatgptLoopbackResult,
  DesktopStatus,
  PublicProject,
} from "./ipc";

export interface OcwDesktopApi {
  readonly isDesktop: true;
  readonly platform: string;
  status(): Promise<DesktopStatus>;
  addProject(options?: { name?: string }): Promise<AddProjectResult>;
  listProjects(): Promise<PublicProject[]>;
  onStatus(callback: (status: DesktopStatus) => void): () => void;
  /** Dock/taskbar badge (unread mentions, 0 clears). Absent in desktop builds before 04-11. */
  setBadgeCount?(count: number): Promise<void>;
  /** "Sign in with ChatGPT" without pasting (05-07). Absent in desktop builds before 05-07. */
  chatgptLoopbackPrepare?(): Promise<ChatgptLoopbackPrepared>;
  chatgptLoopbackAwait?(flowToken: string, authorizeUrl: string): Promise<ChatgptLoopbackResult>;
  chatgptLoopbackCancel?(flowToken: string): Promise<void>;
}
