import { SessionStore } from '../../config/session-store.js';
import type { SessionStatus, TransportName } from '../models.js';
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
   * on the headless side. See README.md's "헤드리스 서버에서 로그인하기" section.
   */
  async exportSession(destPath: string, opts: { force?: boolean } = {}) {
    const result = this.store.exportTo(destPath, opts);
    return { ...result, warning: SESSION_TRANSFER_WARNING };
  }

  /**
   * Import a session directory produced by `exportSession` and report the resulting
   * status. The import itself is a plain filesystem copy (`SessionStore.importFrom`) and
   * is considered successful the moment that returns; the live status check afterward
   * (which needs a real browser) is best-effort on top of that. If it fails — e.g.
   * Playwright's browser binaries aren't installed yet on this machine — we still report
   * the import as successful rather than letting an unrelated verification failure look
   * like the import itself failed. Run `auth status` separately once the browser is
   * available to get a verified answer.
   */
  async importSession(srcPath: string) {
    const { backedUpTo } = this.store.importFrom(srcPath);
    try {
      const result = await this.router.getSessionStatus();
      return { status: result.value, transportUsed: result.transportUsed, backedUpTo, statusCheckError: null };
    } catch (error) {
      const metadata = this.store.readMetadata();
      const status: SessionStatus = {
        authenticated: false,
        profileExists: this.store.profileExists(),
        userDataDir: this.store.userDataDir,
        metadataPath: this.store.metadataPath,
        headfulLoginRequired: false,
        lastLoginAt: metadata.lastLoginAt,
        detectedBy: 'import-succeeded-status-unverified',
      };
      const transportUsed: TransportName | null = null;
      return {
        status,
        transportUsed,
        backedUpTo,
        statusCheckError: error instanceof Error ? error.message : String(error),
      };
    }
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
