import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export interface SessionMetadata {
  lastLoginAt: string | null;
  lastTransport: 'browser' | 'api' | null;
}

/** Files/dirs that identify a directory as a bunjang-cli session (export target). */
const SESSION_MARKER_ENTRIES = ['session.json', 'browser-profile'] as const;

/** Resolve symlinks in existing ancestors, including for a not-yet-created destination. */
function canonicalPath(path: string): string {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
  // The JS implementation lexically collapses '..' before resolving symlinks.
  // Native resolution follows the same directory traversal as filesystem writes.
  return realpathSync.native(path);
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

interface EntryKind {
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/**
 * Best-effort recursive permission lockdown (0700 dirs / 0600 files). Mirrors the
 * best-effort chmod already used for session.json — never fatal on non-POSIX
 * filesystems (e.g. some Windows setups), or if a directory becomes unreadable mid-walk,
 * since the actual data copy (cpSync) has already completed by the time this runs.
 *
 * Never follows symlinks: `fs.cpSync` preserves symlinks as symlinks rather than
 * dereferencing them, so a session directory can legitimately contain one (e.g. a stale
 * Chromium lock file). Following it here would chmod/recurse into whatever it points at,
 * which may be outside the session directory entirely.
 */
function hardenPermissionsRecursive(rootPath: string): void {
  let stat;
  try {
    stat = lstatSync(rootPath);
  } catch {
    return;
  }
  hardenEntry(rootPath, { isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink() });
}

function hardenEntry(entryPath: string, kind: EntryKind): void {
  if (kind.isSymbolicLink) return;

  try {
    chmodSync(entryPath, kind.isDirectory ? 0o700 : 0o600);
  } catch {
    // best effort on non-POSIX environments
  }
  if (!kind.isDirectory) return;

  let entries;
  try {
    // withFileTypes avoids an extra lstat/stat syscall per child — readdir already knows
    // whether each entry is a directory/symlink.
    entries = readdirSync(entryPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    hardenEntry(join(entryPath, entry.name), {
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    });
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
    const source = canonicalPath(this.rootDir);
    const destination = canonicalPath(destPath);
    if (containsPath(source, destination) || containsPath(destination, source)) {
      throw new Error('Export destination and local session directory overlap. Choose a separate directory.');
    }
    const validateDestination = (): void => {
      if (existsSync(destPath)) {
        if (lstatSync(destPath).isSymbolicLink()) {
          throw new Error(`Destination "${destPath}" is a symbolic link. Choose a separate directory.`);
        }
        if (!statSync(destPath).isDirectory()) {
          throw new Error(`Destination "${destPath}" already exists and is not a directory.`);
        }
        if (readdirSync(destPath).length > 0 && !opts.force) {
          throw new Error(`Destination "${destPath}" already exists and is not empty. Pass --force to overwrite it.`);
        }
      }
    };
    validateDestination();
    const metadata = this.readMetadata();
    mkdirSync(dirname(destination), { recursive: true });
    // Build on the destination filesystem so publication can use rename. The
    // private staging directory also keeps an incomplete copy out of the target.
    const staging = mkdtempSync(join(dirname(destination), '.bunjang-export-'));
    const stagedSession = join(staging, 'session');
    const previous = join(staging, 'previous');
    let preserveRecovery = false;
    try {
      cpSync(this.rootDir, stagedSession, { recursive: true });
      hardenPermissionsRecursive(stagedSession);
      validateDestination();
      const hadPrevious = existsSync(destPath);
      if (hadPrevious) renameSync(destPath, previous);
      try {
        renameSync(stagedSession, destPath);
      } catch (error) {
        if (hadPrevious) {
          try {
            renameSync(previous, destPath);
          } catch {
            preserveRecovery = true;
            throw new Error(`Export failed; previous export preserved at "${previous}" for recovery.`, { cause: error });
          }
        }
        throw error;
      }
      return { exportedTo: destPath, metadata };
    } finally {
      if (!preserveRecovery) rmSync(staging, { recursive: true, force: true });
    }
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
    if (existsSync(this.rootDir) && realpathSync(this.rootDir) === realpathSync(srcPath)) {
      throw new Error(
        `Source path "${srcPath}" is this store's own session directory — there is nothing to import ` +
          '(it would have to move itself aside before copying from itself). Export to a different path first ' +
          'if you meant to make a portable copy.',
      );
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
