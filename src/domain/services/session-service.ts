import { SessionStore } from '../../config/session-store.js';
import type { SessionStatus } from '../models.js';
import { CapabilityRouter } from '../../transports/router/capability-router.js';

const SESSION_TRANSFER_WARNING =
  'This directory contains your live Bunjang login session (cookies/browser profile). ' +
  'Treat it like a password: copy it only over a secure/private channel (e.g. scp or rsync over SSH), ' +
  'never commit it to git or paste its contents anywhere, and remove stray copies once the target ' +
  'machine has imported it.';

export class SessionService {
  constructor(
    private readonly router: CapabilityRouter,
    private readonly store: SessionStore,
  ) {}

  async login() {
    const result = await this.router.loginInteractive();
    return { status: result.value, transportUsed: result.transportUsed };
  }

  async status() {
    const result = await this.router.getSessionStatus();
    return { status: result.value, transportUsed: result.transportUsed };
  }

  async logout() {
    this.store.clear();
    return { status: this.loggedOutStatus(), transportUsed: 'browser' as const };
  }

  /**
   * Export the local session to a portable directory. Intended for the headless-server
   * workflow: complete `auth login` on a machine with a display, export, copy the result
   * (scp/rsync) to a headless machine, then `auth import` it there — no browser needed
   * on the headless side. See docs/headless-auth.md.
   */
  async exportSession(destPath: string, opts: { force?: boolean } = {}) {
    const result = this.store.exportTo(destPath, opts);
    return { ...result, warning: SESSION_TRANSFER_WARNING };
  }

  /** Import a session directory produced by `exportSession` and report the resulting status. */
  async importSession(srcPath: string) {
    const { backedUpTo } = this.store.importFrom(srcPath);
    const result = await this.router.getSessionStatus();
    return { status: result.value, transportUsed: result.transportUsed, backedUpTo };
  }

  private loggedOutStatus(): SessionStatus {
    return {
      authenticated: false,
      profileExists: this.store.profileExists(),
      userDataDir: this.store.userDataDir,
      metadataPath: this.store.metadataPath,
      headfulLoginRequired: true,
      lastLoginAt: null,
      detectedBy: 'missing-session-metadata',
    };
  }
}
