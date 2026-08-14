import { SessionChange, SessionManager } from "../application/session-manager";
import { PastedImage } from "../domain/codex-input";
import { ImageInputStore } from "../infrastructure/filesystem/image-input-store";

const FINISHED_STATUSES = new Set(["ready", "completed", "failed", "interrupted", "disconnected"]);

export class SessionImageInputCoordinator {
  private readonly pending = new Map<string, Set<string>>();
  private readonly subscription: { dispose(): void };

  public constructor(
    private readonly manager: SessionManager,
    private readonly store: ImageInputStore,
  ) {
    this.subscription = manager.onDidChange((change) => this.handleSessionChange(change));
  }

  public async sendMessage(sessionId: string, text: string, images: readonly PastedImage[]): Promise<void> {
    const paths = await this.store.save(images);
    try {
      await this.manager.sendMessage(sessionId, text, paths);
    } catch (error) {
      await this.store.remove(paths);
      throw error;
    }
    if (!paths.length) return;
    const pending = this.pending.get(sessionId) ?? new Set<string>();
    for (const path of paths) pending.add(path);
    this.pending.set(sessionId, pending);
    this.removeIfFinished(sessionId);
  }

  public dispose(): void {
    this.subscription.dispose();
    const paths = [...this.pending.values()].flatMap((values) => [...values]);
    this.pending.clear();
    void this.store.remove(paths);
  }

  private handleSessionChange(change: SessionChange): void {
    if (change.sessionId) this.removeIfFinished(change.sessionId);
    else for (const sessionId of this.pending.keys()) this.removeIfFinished(sessionId);
  }

  private removeIfFinished(sessionId: string): void {
    const paths = this.pending.get(sessionId);
    if (!paths?.size) return;
    const session = this.manager.get(sessionId);
    if (session && !FINISHED_STATUSES.has(session.status)) return;
    this.pending.delete(sessionId);
    void this.store.remove([...paths]);
  }
}
