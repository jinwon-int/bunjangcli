import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const hasOptIn = process.env.BUNJANG_E2E === '1';
const hasAuthenticatedOptIn = process.env.BUNJANG_AUTH_E2E === '1';
const hasInteractiveLoginOptIn = process.env.BUNJANG_LOGIN_E2E === '1';
const execFileAsync = promisify(execFile);

describe('public Bunjang CLI smoke', () => {
  it('searches public listings without a logged-in session', async () => {
    const { stdout } = await execFileAsync('node', ['dist/src/cli.js', '--json', 'search', '펜텔', '--max-items', '1']);
    const payload = JSON.parse(stdout) as { items: Array<{ id: string; title: string }> };
    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items[0]?.id).toMatch(/^\d+$/);
  });

  it('fetches a public item detail through the CLI', async () => {
    const { stdout } = await execFileAsync('node', ['dist/src/cli.js', '--json', 'item', 'get', '391084752']);
    const payload = JSON.parse(stdout) as { item: { id: string; title: string } };
    expect(payload.item.id).toBe('391084752');
    expect(payload.item.title.length).toBeGreaterThan(0);
  });

  it('returns a non-null item price for a known public listing', async () => {
    const { stdout } = await execFileAsync('node', ['dist/src/cli.js', '--json', 'item', 'get', '391084752']);
    const payload = JSON.parse(stdout) as { item: { price: number | null } };
    expect(typeof payload.item.price).toBe('number');
    expect(payload.item.price).toBeGreaterThan(1000);
  });
});

describe.skipIf(!hasOptIn)('manual Bunjang smoke prerequisites', () => {
  it('has a session metadata file before running live smoke tests', () => {
    const configDir = process.env.BUNJANG_CONFIG_DIR ?? join(homedir(), '.config', 'bunjang-cli');
    expect(existsSync(join(configDir, 'session.json'))).toBe(true);
  });
});

describe.skipIf(!hasAuthenticatedOptIn)('authenticated Bunjang smoke', () => {
  it('reports authenticated session status via CLI', async () => {
    const { stdout } = await execFileAsync('node', ['dist/src/cli.js', '--json', 'auth', 'status']);
    const payload = JSON.parse(stdout) as { status: { authenticated: boolean } };
    expect(payload.status.authenticated).toBe(true);
  });

  it('executes at least one authenticated read flow', { timeout: 30000 }, async () => {
    const { stdout } = await execFileAsync('node', ['dist/src/cli.js', '--json', 'favorite', 'list']);
    const payload = JSON.parse(stdout) as { items: unknown[] } | { error: string };
    expect('items' in payload).toBe(true);
  });

  it('executes an authenticated chat read smoke path', { timeout: 30000 }, async () => {
    const { stdout } = await execFileAsync('node', ['dist/src/cli.js', '--json', 'chat', 'list']);
    const payload = JSON.parse(stdout) as { threads: unknown[] } | { error: string };
    expect('threads' in payload).toBe(true);
  });

  // Regression coverage for the 2026-07 Bunjang mobile-web redesign: the favorite
  // ("bookmark") button's class was renamed and an app-install bottom-sheet nudge began
  // intercepting clicks on it. Round-trips add -> remove on a long-lived public listing
  // and asserts against the listing's real favoriteCount (fetched fresh via the
  // read-only `item get` path) rather than trusting the mutating command's own report,
  // so it fails closed if the click silently lands on the wrong element again.
  it('adds then removes a favorite, verified via a fresh item lookup', { timeout: 60000 }, async () => {
    const listingId = '394694708';
    const countBefore = await fetchFavoriteCount(listingId);

    const addResult = await execFileAsync('node', ['dist/src/cli.js', '--json', 'favorite', 'add', listingId]);
    const addPayload = JSON.parse(addResult.stdout) as { item: { raw?: { favoritedAfter?: boolean | null } } };
    expect(addPayload.item.raw?.favoritedAfter).not.toBe(false);
    expect(await fetchFavoriteCount(listingId)).toBe(countBefore + 1);

    const removeResult = await execFileAsync('node', ['dist/src/cli.js', '--json', 'favorite', 'remove', listingId]);
    const removePayload = JSON.parse(removeResult.stdout) as { item: { raw?: { favoritedAfter?: boolean | null } } };
    expect(removePayload.item.raw?.favoritedAfter).not.toBe(true);
    expect(await fetchFavoriteCount(listingId)).toBe(countBefore);
  });
});

async function fetchFavoriteCount(listingId: string): Promise<number> {
  const { stdout } = await execFileAsync('node', ['dist/src/cli.js', '--json', 'item', 'get', listingId]);
  const payload = JSON.parse(stdout) as { item: { favoriteCount: number | null } };
  if (typeof payload.item.favoriteCount !== 'number') {
    throw new Error(`Expected a numeric favoriteCount for ${listingId}, got ${JSON.stringify(payload.item.favoriteCount)}`);
  }
  return payload.item.favoriteCount;
}

describe.skipIf(!hasInteractiveLoginOptIn)('interactive login / reauth smoke', () => {
  it('supports a manual auth bootstrap run', async () => {
    const { stdout } = await execFileAsync('node', ['dist/src/cli.js', '--json', 'auth', 'login'], {
      env: process.env,
      timeout: 300000,
    });
    const payload = JSON.parse(stdout) as { status: { authenticated: boolean } };
    expect(payload.status.authenticated).toBe(true);
  });
});
