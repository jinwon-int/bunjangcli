import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../../src/domain/models.js';
import { SessionStore } from '../../src/config/session-store.js';
import { SessionService } from '../../src/domain/services/session-service.js';
import { CapabilityRouter } from '../../src/transports/router/capability-router.js';
import { FakeTransport } from '../helpers/fakes.js';

/** Simulates a machine where Playwright's browser binaries aren't installed yet. */
class ThrowingStatusTransport extends FakeTransport {
  async getSessionStatus(): Promise<SessionStatus> {
    throw new Error("browserType.launchPersistentContext: Executable doesn't exist at /fake/chromium");
  }
}

describe('session metadata guardrails', () => {
  it('does not claim authentication without a recorded login', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunjang-session-'));
    const store = new SessionStore(root);
    store.ensure();
    const metadata = store.readMetadata();
    expect(metadata.lastLoginAt).toBeNull();
  });

  it('clears the local session and reports a logged-out status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunjang-session-'));
    const store = new SessionStore(root);
    store.ensure();
    store.saveMetadata({ lastLoginAt: '2026-01-01T00:00:00.000Z', lastTransport: 'browser' });

    const router = new CapabilityRouter(
      new FakeTransport('browser', ['auth']),
      new FakeTransport('api', []),
      { preferredTransport: 'browser' },
    );
    const service = new SessionService(router, store);

    const result = await service.logout();

    expect(result.transportUsed).toBe('browser');
    expect(result.status.authenticated).toBe(false);
    expect(result.status.profileExists).toBe(false);
    expect(result.status.lastLoginAt).toBeNull();
    expect(result.status.detectedBy).toBe('missing-session-metadata');
  });

  it('exports a session then imports it on another store, reporting live status via the router', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'bunjang-session-src-'));
    const sourceStore = new SessionStore(sourceRoot);
    sourceStore.ensure();
    sourceStore.saveMetadata({ lastLoginAt: '2026-01-01T00:00:00.000Z', lastTransport: 'browser' });
    writeFileSync(join(sourceStore.userDataDir, 'Cookies'), 'cookie-data', 'utf8');

    const router = new CapabilityRouter(
      new FakeTransport('browser', ['auth']),
      new FakeTransport('api', []),
      { preferredTransport: 'browser' },
    );
    const sourceService = new SessionService(router, sourceStore);

    const exportDest = join(mkdtempSync(join(tmpdir(), 'bunjang-session-export-')), 'session-copy');
    const exportResult = await sourceService.exportSession(exportDest);
    expect(exportResult.exportedTo).toBe(exportDest);
    expect(exportResult.warning).toMatch(/treat it like a password/i);
    expect(existsSync(join(exportDest, 'session.json'))).toBe(true);

    const targetRoot = join(mkdtempSync(join(tmpdir(), 'bunjang-session-target-')), 'fresh');
    const targetStore = new SessionStore(targetRoot);
    const targetService = new SessionService(router, targetStore);

    const importResult = await targetService.importSession(exportDest);

    expect(importResult.backedUpTo).toBeNull();
    expect(importResult.transportUsed).toBe('browser');
    // FakeTransport reports its fixed status regardless of on-disk state; this asserts
    // that importSession actually calls through the router rather than short-circuiting.
    expect(importResult.status.authenticated).toBe(true);
    expect(targetStore.readMetadata().lastLoginAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects exporting when there is nothing to export, and importing a bogus path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunjang-session-empty-'));
    const store = new SessionStore(root);
    const router = new CapabilityRouter(
      new FakeTransport('browser', ['auth']),
      new FakeTransport('api', []),
      { preferredTransport: 'browser' },
    );
    const service = new SessionService(router, store);

    await expect(service.exportSession(join(root, 'dest'))).rejects.toThrow(/no local session/i);
    await expect(service.importSession(join(root, 'does-not-exist'))).rejects.toThrow(/does not exist/i);
  });

  it('reports a successful import even when the post-import live status check fails', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'bunjang-session-src2-'));
    const sourceStore = new SessionStore(sourceRoot);
    sourceStore.ensure();
    sourceStore.saveMetadata({ lastLoginAt: '2026-02-02T00:00:00.000Z', lastTransport: 'browser' });
    writeFileSync(join(sourceStore.userDataDir, 'Cookies'), 'cookie-data', 'utf8');
    const exportDest = join(mkdtempSync(join(tmpdir(), 'bunjang-session-export2-')), 'session-copy');
    sourceStore.exportTo(exportDest);

    const targetRoot = join(mkdtempSync(join(tmpdir(), 'bunjang-session-target2-')), 'fresh');
    const targetStore = new SessionStore(targetRoot);
    const failingRouter = new CapabilityRouter(
      new ThrowingStatusTransport('browser', ['auth']),
      new FakeTransport('api', []),
      { preferredTransport: 'browser' },
    );
    const targetService = new SessionService(failingRouter, targetStore);

    // Must not throw/reject: the filesystem import already succeeded by this point, so a
    // browser-launch failure during the follow-up status check should not surface as an
    // importSession failure (e.g. Playwright's browser binaries aren't installed yet).
    const result = await targetService.importSession(exportDest);

    expect(result.backedUpTo).toBeNull();
    expect(result.transportUsed).toBeNull();
    expect(result.statusCheckError).toMatch(/Executable doesn't exist/);
    expect(result.status.authenticated).toBe(false);
    expect(result.status.detectedBy).toBe('import-succeeded-status-unverified');
    // The actual import did happen, even though live status could not be verified.
    expect(targetStore.readMetadata().lastLoginAt).toBe('2026-02-02T00:00:00.000Z');
    expect(targetStore.profileExists()).toBe(true);
  });
});
