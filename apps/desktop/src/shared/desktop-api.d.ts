// Type of `window.ocwDesktop` for web code that wants to feature-detect the desktop shell.
import type { AddProjectResult, DesktopStatus, PublicProject } from "./ipc";

export interface OcwDesktopApi {
  readonly isDesktop: true;
  readonly platform: string;
  status(): Promise<DesktopStatus>;
  addProject(options?: { name?: string }): Promise<AddProjectResult>;
  listProjects(): Promise<PublicProject[]>;
  onStatus(callback: (status: DesktopStatus) => void): () => void;
}
