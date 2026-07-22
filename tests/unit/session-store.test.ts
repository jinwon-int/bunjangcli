import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../../src/config/session-store.js';

function makeLoggedInStore(): { root: string; store: SessionStore } {
  const root = mkdtempSync(join(tmpdir(), 'bunjang-cli-'));
  const store = new SessionStore(root);
  store.ensure();
  store.saveMetadata({ lastLoginAt: '2026-01-01T00:00:00.000Z', lastTransport: 'browser' });
  writeFileSync(join(store.userDataDir, 'Cookies'), 'cookie-data', 'utf8');
  return { root, store };
}

describe('SessionStore', () => {
  it('persists metadata in a permission-restricted session file', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunjang-cli-'));
    const store = new SessionStore(root);
    const metadata = store.saveMetadata({ lastLoginAt: '2026-01-01T00:00:00.000Z', lastTransport: 'browser' });
    expect(metadata.lastTransport).toBe('browser');
    expect(store.readMetadata().lastLoginAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('clears the local session root recursively', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunjang-cli-'));
    const store = new SessionStore(root);
    store.ensure();
    store.saveMetadata({ lastLoginAt: '2026-01-01T00:00:00.000Z', lastTransport: 'browser' });
    writeFileSync(join(store.userDataDir, 'Cookies'), 'cookie-data', 'utf8');

    store.clear();

    expect(existsSync(root)).toBe(false);
    expect(store.profileExists()).toBe(false);
  });

  it('refuses to export when there is no local session', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunjang-cli-'));
    const store = new SessionStore(root);
    const dest = mkdtempSync(join(tmpdir(), 'bunjang-cli-export-'));

    expect(() => store.exportTo(dest)).toThrow(/no local session/i);
  });

  it('exports a logged-in session to a portable directory with locked-down permissions', () => {
    const { store } = makeLoggedInStore();
    const dest = join(mkdtempSync(join(tmpdir(), 'bunjang-cli-export-')), 'session-copy');

    const result = store.exportTo(dest);

    expect(result.exportedTo).toBe(dest);
    expect(result.metadata.lastLoginAt).toBe('2026-01-01T00:00:00.000Z');
    expect(existsSync(join(dest, 'session.json'))).toBe(true);
    expect(existsSync(join(dest, 'browser-profile', 'Cookies'))).toBe(true);
    expect(statSync(dest).mode & 0o777).toBe(0o700);
    expect(statSync(join(dest, 'session.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses to export into a non-empty destination without --force', () => {
    const { store } = makeLoggedInStore();
    const dest = mkdtempSync(join(tmpdir(), 'bunjang-cli-export-'));
    writeFileSync(join(dest, 'existing-file'), 'x', 'utf8');

    expect(() => store.exportTo(dest)).toThrow(/already exists and is not empty/i);
    expect(() => store.exportTo(dest, { force: true })).not.toThrow();
  });

  it('rejects importing a path that does not look like an exported session', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunjang-cli-'));
    const store = new SessionStore(root);
    const bogusSrc = mkdtempSync(join(tmpdir(), 'bunjang-cli-bogus-'));
    writeFileSync(join(bogusSrc, 'not-a-session.txt'), 'nope', 'utf8');

    expect(() => store.importFrom(bogusSrc)).toThrow(/does not look like a bunjang-cli session export/i);
  });

  it('rejects importing a source path that does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunjang-cli-'));
    const store = new SessionStore(root);

    expect(() => store.importFrom(join(root, 'nope'))).toThrow(/does not exist/i);
  });

  it('imports a previously exported session, backing up any existing one first', () => {
    const { store: sourceStore } = makeLoggedInStore();
    const exportDest = join(mkdtempSync(join(tmpdir(), 'bunjang-cli-export-')), 'session-copy');
    sourceStore.exportTo(exportDest);

    const targetRoot = mkdtempSync(join(tmpdir(), 'bunjang-cli-target-'));
    const targetStore = new SessionStore(targetRoot);
    targetStore.ensure();
    targetStore.saveMetadata({ lastLoginAt: '2020-01-01T00:00:00.000Z', lastTransport: 'api' });

    const { backedUpTo } = targetStore.importFrom(exportDest);

    expect(backedUpTo).toBeTruthy();
    expect(existsSync(join(backedUpTo as string, 'session.json'))).toBe(true);
    expect(targetStore.readMetadata().lastLoginAt).toBe('2026-01-01T00:00:00.000Z');
    expect(targetStore.profileExists()).toBe(true);
    expect(readFileSync(join(targetStore.userDataDir, 'Cookies'), 'utf8')).toBe('cookie-data');
  });

  it('imports cleanly when there is no pre-existing session to back up', () => {
    const { store: sourceStore } = makeLoggedInStore();
    const exportDest = join(mkdtempSync(join(tmpdir(), 'bunjang-cli-export-')), 'session-copy');
    sourceStore.exportTo(exportDest);

    const targetRoot = join(mkdtempSync(join(tmpdir(), 'bunjang-cli-target-')), 'fresh');
    const targetStore = new SessionStore(targetRoot);

    const { backedUpTo } = targetStore.importFrom(exportDest);

    expect(backedUpTo).toBeNull();
    expect(targetStore.readMetadata().lastLoginAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
