import type { Command } from 'commander';
import { printSessionStatus } from '../output/formatters.js';
import { printJson } from '../output/json.js';
import { createAppContext } from '../runtime/create-app-context.js';

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('Authenticate and inspect CLI session status');

  auth
    .command('login')
    .description('Open a headful browser and let the user log in')
    .action(async function () {
      const ctx = createAppContext(this.parent?.parent?.opts());
      const result = await ctx.sessionService.login();
      if (this.parent?.parent?.opts().json) printJson(result);
      else printSessionStatus(result.status);
    });

  auth
    .command('status')
    .description('Show current authentication/session status')
    .action(async function () {
      const ctx = createAppContext(this.parent?.parent?.opts());
      const result = await ctx.sessionService.status();
      if (this.parent?.parent?.opts().json) printJson(result);
      else printSessionStatus(result.status);
    });

  auth
    .command('logout')
    .description('Clear the local CLI session/profile so the next auth flow starts logged out')
    .action(async function () {
      const ctx = createAppContext(this.parent?.parent?.opts());
      const result = await ctx.sessionService.logout();
      if (this.parent?.parent?.opts().json) printJson(result);
      else printSessionStatus(result.status);
    });

  auth
    .command('export <destPath>')
    .description(
      'Copy this session (cookies/browser profile) to a portable directory so it can be moved to another ' +
        'machine — e.g. run `auth login` on a machine with a display, export the result, then copy it ' +
        '(scp/rsync) to a headless server and run `auth import` there. No browser needed on the headless side.',
    )
    .option('--force', 'overwrite a non-empty destination directory')
    .action(async function (destPath: string, cmdOpts: { force?: boolean }) {
      const ctx = createAppContext(this.parent?.parent?.opts());
      const result = await ctx.sessionService.exportSession(destPath, { force: !!cmdOpts.force });
      if (this.parent?.parent?.opts().json) printJson(result);
      else {
        console.log(`Exported session to ${result.exportedTo}`);
        console.warn(`\n⚠️  ${result.warning}\n`);
      }
    });

  auth
    .command('import <srcPath>')
    .description(
      'Import a session directory previously produced by `auth export` (e.g. copied in via scp/rsync) so ' +
        'this machine is authenticated without opening a browser. Intended for headless servers/CI/agent nodes.',
    )
    .action(async function (srcPath: string) {
      const ctx = createAppContext(this.parent?.parent?.opts());
      const result = await ctx.sessionService.importSession(srcPath);
      if (this.parent?.parent?.opts().json) printJson(result);
      else {
        if (result.backedUpTo) console.log(`Existing session backed up to ${result.backedUpTo}`);
        printSessionStatus(result.status);
      }
    });
}
