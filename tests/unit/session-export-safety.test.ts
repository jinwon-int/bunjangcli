import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../src/config/session-store.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, cpSync: vi.fn(actual.cpSync), renameSync: vi.fn(actual.renameSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

describe('session export safety', () => {
  let base: string;
  let store: SessionStore;
  beforeEach(() => {
    vi.mocked(cpSync).mockImplementation(actualFs.cpSync);
    vi.mocked(renameSync).mockImplementation(actualFs.renameSync);
    base = mkdtempSync(join(tmpdir(), 'bunjang-export-safety-'));
    store = new SessionStore(join(base, 'source'));
    store.saveMetadata({ lastTransport: 'browser' });
    writeFileSync(join(store.userDataDir, 'Cookies'), 'synthetic session');
  });
  afterEach(() => {
    vi.mocked(cpSync).mockReset();
    vi.mocked(renameSync).mockReset();
    rmSync(base, { recursive: true, force: true });
  });

  function expectSourceIntact(): void {
    expect(readFileSync(join(store.userDataDir, 'Cookies'), 'utf8')).toBe('synthetic session');
    expect(store.readMetadata().lastTransport).toBe('browser');
  }

  for (const target of ['self', 'ancestor', 'descendant', 'missing descendant', 'alias', 'alias ancestor', 'alias descendant', 'alias with parent traversal']) {
    it(`rejects ${target} before changing either directory`, () => {
      let dest = store.rootDir;
      if (target === 'ancestor') dest = base;
      if (target === 'descendant') dest = store.userDataDir;
      if (target === 'missing descendant') dest = join(store.rootDir, 'missing', 'copy');
      if (target === 'alias') {
        dest = join(base, 'alias');
        symlinkSync(store.rootDir, dest, 'dir');
      }
      if (target === 'alias ancestor') {
        dest = join(base, 'alias');
        symlinkSync(base, dest, 'dir');
      }
      if (target === 'alias descendant') {
        const alias = join(base, 'alias');
        symlinkSync(store.rootDir, alias, 'dir');
        dest = join(alias, 'missing', 'copy');
      }
      if (target === 'alias with parent traversal') {
        const outside = join(base, 'outside');
        mkdirSync(outside);
        const alias = join(outside, 'alias');
        symlinkSync(store.userDataDir, alias, 'dir');
        // Preserve '..' so realpath, not lexical normalization, resolves it.
        dest = `${alias}/..`;
      }
      // A broken implementation can recurse indefinitely through a symlink.
      // Reject the copy in this guard test; the real filesystem still exercises
      // all path resolution and any destructive actions before that point.
      vi.mocked(cpSync).mockImplementationOnce(() => { throw new Error('unexpected copy attempt'); });
      expect(() => store.exportTo(dest, { force: true })).toThrow(/overlap/i);
      expectSourceIntact();
      expect(cpSync).not.toHaveBeenCalled();
      expect(renameSync).not.toHaveBeenCalled();
    });
  }

  it('allows sibling paths that share a textual prefix', () => {
    const dest = `${store.rootDir}-copy`;
    store.exportTo(dest);
    expect(readFileSync(join(dest, 'browser-profile', 'Cookies'), 'utf8')).toBe('synthetic session');
    expectSourceIntact();
  });

  it('keeps an existing export if copying fails', () => {
    const dest = join(base, 'previous');
    mkdirSync(dest);
    writeFileSync(join(dest, 'sentinel'), 'previous export');
    vi.mocked(cpSync).mockImplementationOnce(() => { throw new Error('simulated disk full'); });
    expect(() => store.exportTo(dest, { force: true })).toThrow(/disk full/);
    expect(readFileSync(join(dest, 'sentinel'), 'utf8')).toBe('previous export');
    expectSourceIntact();
    expect(readdirSync(base).sort()).toEqual(['previous', 'source']);
  });

  it('restores the previous export if publishing the copy fails', () => {
    const dest = join(base, 'previous');
    mkdirSync(dest);
    writeFileSync(join(dest, 'sentinel'), 'previous export');
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(from).endsWith('/session')) throw new Error('simulated rename failure');
      actualFs.renameSync(from, to);
    });
    expect(() => store.exportTo(dest, { force: true })).toThrow(/rename failure/);
    expect(readFileSync(join(dest, 'sentinel'), 'utf8')).toBe('previous export');
    expectSourceIntact();
    expect(readdirSync(base).sort()).toEqual(['previous', 'source']);
  });

  it('retains the recovery directory if rollback also fails', () => {
    const dest = join(base, 'previous');
    mkdirSync(dest);
    writeFileSync(join(dest, 'sentinel'), 'previous export');
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(from) !== dest) throw new Error('simulated filesystem failure');
      actualFs.renameSync(from, to);
    });
    expect(() => store.exportTo(dest, { force: true })).toThrow(/preserved at/i);
    const recovery = readdirSync(base).find(name => name.startsWith('.bunjang-export-'))!;
    expect(readFileSync(join(base, recovery, 'previous', 'sentinel'), 'utf8')).toBe('previous export');
    expectSourceIntact();
  });

  it('does not remove the destination when source metadata is invalid', () => {
    const dest = join(base, 'previous');
    mkdirSync(dest);
    writeFileSync(join(dest, 'sentinel'), 'previous export');
    writeFileSync(store.metadataPath, '{invalid');
    expect(() => store.exportTo(dest, { force: true })).toThrow();
    expect(existsSync(join(dest, 'sentinel'))).toBe(true);
  });
});
