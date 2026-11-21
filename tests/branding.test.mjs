// The visible name is vibeMomo while every stored or typed identity keeps the old one: the risks are a rename that
// moves the desktop window's storage (Electron names userData after the app), a changed app id or package name, and
// committed icons that no longer match their generator. Reads files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { statusWords } from '../client/components/stage-words.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('the shell, the status line and the desktop build say vibeMomo', () => {
  const html = read('client/index.html');
  assert.match(html, /<title>vibeMomo<\/title>/);
  assert.match(html, /<span class="mark" aria-hidden="true">V<\/span><span class="wordmark">vibeMomo<\/span>/);
  assert.match(html, /<noscript>vibeMomo needs JavaScript enabled\.<\/noscript>/);
  assert.match(html, /%3Cpath d='M9 8\.5l7 15 7-15'/, 'the favicon draws the V of the header mark and the app icon');
  assert.doesNotMatch(html, /Atelier/);
  assert.equal(statusWords({ version: '0.3.29' }).right, 'vibeMomo 0.3.29');
  assert.equal(pkg.build.productName, 'vibeMomo');
  assert.match(pkg.build.artifactName, /^vibeMomo-/);
  const main = read('app/main.cjs');
  assert.match(main, /const PRODUCT = 'vibeMomo';/);
  assert.match(main, /title: PRODUCT,/);
  assert.doesNotMatch(main.replace(/^\s*\/\/.*$/gm, ''), /'Atelier'|"Atelier"|`Atelier/, 'no window, tray or dialog label left with the old name');
});

test('stored and typed identities keep the old name', () => {
  assert.equal(pkg.name, 'atelier', 'Electron names userData after the package when run from source');
  assert.equal(pkg.productName, undefined, 'a top-level productName would rename userData when run from source');
  assert.equal(pkg.build.appId, 'local.atelier.studio', 'the Windows app id that pinned taskbar entries follow');
  const main = read('app/main.cjs');
  const pin = main.indexOf("app.setPath('userData', path.join(app.getPath('appData'), 'atelier'));");
  assert.ok(pin > 0, 'userData is pinned to appData/atelier');
  assert.ok(pin < main.indexOf('requestSingleInstanceLock') && pin < main.indexOf('app.whenReady'), 'pinned before the lock and before ready');
  assert.match(main, /'Atelier projects'/, 'a packaged run keeps new projects where earlier versions put them');
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'atelier.mjs')) && fs.existsSync(path.join(ROOT, 'bin', 'atelier-mcp.mjs')));
});

test('the committed icons are what app/make-icon.cjs draws', () => {
  const { png, ico, ICO_SIZES } = createRequire(import.meta.url)('../app/make-icon.cjs');
  assert.ok(fs.readFileSync(path.join(ROOT, 'app', 'icon.png')).equals(png(256)), 'icon.png: run node app/make-icon.cjs');
  assert.ok(fs.readFileSync(path.join(ROOT, 'app', 'tray.png')).equals(png(32)), 'tray.png: run node app/make-icon.cjs');
  assert.ok(fs.readFileSync(path.join(ROOT, 'app', 'icon.ico')).equals(ico(ICO_SIZES)), 'icon.ico: run node app/make-icon.cjs');
});
