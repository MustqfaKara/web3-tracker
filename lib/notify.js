// macOS bildirimi + Chrome'da OpenSea sayfasi acma + terminal bell
import { execFile } from 'node:child_process';
import { env } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('notify');

export function bell() {
  process.stdout.write('');
}

export function notifyMacOS(title, message) {
  if (process.platform !== 'darwin') return;
  execFile('osascript', [
    '-e',
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
  ], () => { /* sessiz */ });
}

export function openInChrome(url) {
  if (!env.OPEN_IN_CHROME || !url) return;
  if (env.DRY_RUN) {
    log.info(`[dry-run] Chrome acilmadi: ${url}`);
    return;
  }
  execFile('open', ['-a', 'Google Chrome', url], (error) => {
    if (error) log.warn(`Chrome acilamadi: ${error.message}`);
  });
}
