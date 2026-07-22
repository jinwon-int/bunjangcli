import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessionMetadata {
  lastLoginAt: string | null;
  lastTransport: 'browser' | 'api' | null;
}

/** Files/dirs that identify a directory as a bunjang-cli session (export target). */
const SESSION_MARKER_ENTRIES = ['session.json', 'browser-profile'] as const;

/**
 * Best-effort recursive permission lockdown (0700 dirs / 0600 files). Mirrors the
 * best-effort chmod already used for session.json — never fatal on non-POSIX
 * filesystems (e.g. some Windows setups), since the session is unusable there anyway
 * without POSIX permission semantics.
 */
function hardenPermissionsRecursive(rootPath: string): void {
  let stat;
  try {
    stat = statSync(rootPath);
  } catch {
    return;
  }
  try {
    chmodSync(rootPath, stat.isDirectory() ? 0o700 : 0o600);
  } catch {
    // best effort on non-POSIX environments
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(rootPath)) {
      hardenPermissionsRecursive(join(rootPath, entry));
    }
  }
}

export class SessionStore {
  readonly rootDir: string;
  readonly userDataDir: string;
  readonly metadataPath: string;

  constructor(rootDir = process.env.BUNJANG_CONFIG_DIR ?? join(homedir(), '.config', 'bunjang-cli')) {
    this.rootDir = rootDir;
    this.userDataDir = join(rootDir, 'browser-profile');
    this.metadataPath = join(rootDir, 'session.json');
  }

  ensure(): void {
    mkdirSync(this.rootDir, { recursive: true });
    mkdirSync(this.userDataDir, { recursive: true });
  }

  profileExists(): boolean {
    return existsSync(this.userDataDir);
  }

  readMetadata(): SessionMetadata {
    if (!existsSync(this.metadataPath)) {
      return { lastLoginAt: null, lastTransport: null };
    }
    const raw = readFileSync(this.metadataPath, 'utf8');
    return JSON.parse(raw) as SessionMetadata;
  }

  saveMetadata(partial: Partial<SessionMetadata>): SessionMetadata {
    this.ensure();
    const next = { ...this.readMetadata(), ...partial } satisfies SessionMetadata;
    writeFileSync(this.metadataPath, JSON.stringify(next, null, 2), 'utf8');
    try {
      chmodSync(this.metadataPath, 0o600);
    } catch {
      // best effort on non-POSIX environments
    }
    return next;
  }

  clear(): void {
    rmSync(this.rootDir, { recursive: true, force: true });
  }

  /** True if `path` looks like a directory produced by `exportTo` (or a manual copy of rootDir). */
  looksLikeExportedSession(path: string): boolean {
    return SESSION_MARKER_ENTRIES.some((entry) => existsSync(join(path, entry)));
  }

  /**
   * Copy this session (browser profile + metadata) to `destPath` so it can be moved to
   * another machine — e.g. `auth login` completed on a machine with a display, then the
   * result exported and copied (scp/rsync) to a headless server that runs `auth import`.
   */
  exportTo(destPath: string, opts: { force?: boolean } = {}): { exportedTo: string; metadata: SessionMetadata } {
    if (!this.profileExists() && !existsSync(this.metadataPath)) {
      throw new Error(
        'No local session found to export. Run `auth login` on a machine with a display first, then export from there.',
      );
    }
    if (existsSync(destPath) && readdirSync(destPath).length > 0 && !opts.force) {
      throw new Error(`Destination "${destPath}" already exists and is not empty. Pass --force to overwrite it.`);
    }
    mkdirSync(destPath, { recursive: true });
    cpSync(this.rootDir, destPath, { recursive: true });
    hardenPermissionsRecursive(destPath);
    return { exportedTo: destPath, metadata: this.readMetadata() };
  }

  /**
   * Import a session directory previously produced by `exportTo` into this store's
   * rootDir, so this machine is authenticated without ever opening a browser. Any
   * existing session is renamed aside (never silently discarded) before the import.
   */
  importFrom(srcPath: string): { backedUpTo: string | null } {
    if (!existsSync(srcPath)) {
      throw new Error(`Source path "${srcPath}" does not exist.`);
    }
    if (!this.looksLikeExportedSession(srcPath)) {
      throw new Error(
        `Source path "${srcPath}" does not look like a bunjang-cli session export ` +
          '(expected a session.json file and/or a browser-profile directory, as produced by `auth export`).',
      );
    }
    let backedUpTo: string | null = null;
    if (existsSync(this.rootDir)) {
      backedUpTo = `${this.rootDir}.bak-${Date.now()}`;
      renameSync(this.rootDir, backedUpTo);
    }
    mkdirSync(this.rootDir, { recursive: true });
    cpSync(srcPath, this.rootDir, { recursive: true });
    hardenPermissionsRecursive(this.rootDir);
    return { backedUpTo };
  }
}
