// Finding pi's CLI (cli.js) and the bash that workflows' sh() uses.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readJSON } from './core.mjs';
import { L } from '../i18n.mjs';

// ---------- locating pi ----------
export const PI_PACKAGES = ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent', 'pi-coding-agent'];
export function globalRoots() {
  const exeDir = path.dirname(process.execPath);
  return [
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
    process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(exeDir, '..', 'lib', 'node_modules'), // nvm, fnm, volta, official tarballs
    path.join(exeDir, 'node_modules'), // Windows installer layout
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean);
}
export function binOf(dir) {
  const pkg = readJSON(path.join(dir, 'package.json'), null);
  if (!pkg) return null;
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin.pi || Object.values(pkg.bin)[0]);
  const p = bin && path.join(dir, bin);
  return p && fs.existsSync(p) ? p : null;
}
export function findCli() {
  if (process.env.PI_CLI && fs.existsSync(process.env.PI_CLI)) return process.env.PI_CLI;
  const search = roots => {
    for (const r of roots) for (const name of PI_PACKAGES) {
      const p = binOf(path.join(r, name));
      if (p) return p;
    }
    return null;
  };
  let p = search(globalRoots());
  if (p) return p;
  // Last resort: ask npm where global packages live
  try {
    const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 20000,
      shell: process.platform === 'win32',
      windowsHide: true,
    }).trim();
    if (root) p = search([root]);
  } catch {}
  return p;
}
export const noCli = () =>
  L(
    "cannot find pi's CLI. Install pi globally with npm, or set the env var PI_CLI to the path of pi's cli.js",
    '找不到 pi 的 CLI。请用 npm 全局安装 pi，或把环境变量 PI_CLI 设为 pi 的 cli.js 路径'
  );
