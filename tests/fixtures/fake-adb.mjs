// Fake `adb` for tests/http.test.mjs (ATELIER_ADB="<node> <this file>"): answers from its argv the commands
// the Android provider sends. Never touches a device. forward tcp:0 prints FAKE_ADB_CDP_PORT, where the
// test runs a fake DevTools endpoint (tests/fixtures/fake-cdp.mjs), as real adb prints the port it chose.
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let args = process.argv.slice(2);
let serial = null;
if (args[0] === '-s') { serial = args[1]; args = args.slice(2); }
const [cmd, ...rest] = args;
const out = (s) => process.stdout.write(s);
const failWith = (msg) => { process.stderr.write(`${msg}\n`); process.exit(1); };

/** A real PNG, 10 x 20 grey pixels: width and height are what inspect reads. */
export function tinyPng(width = 10, height = 20) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0; // filter byte per row
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Run as adb, not when a test imports tinyPng.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const line = rest.join(' ');
  if (cmd === 'devices') out('List of devices attached\nemulator-5554\tdevice\n0123456789ABCDEF\toffline\n\n');
  else if (cmd === 'emu' && line === 'avd name') serial === 'emulator-5554' ? out('Fake_Pixel\r\nOK\r\n') : failWith('KO: not an emulator');
  else if (cmd === 'emu' && line === 'kill') out('OK: killing emulator, bye bye\r\n');
  else if (cmd === 'shell' && line === 'getprop sys.boot_completed') out('1\n');
  else if (cmd === 'shell' && rest[0] === 'pm' && rest[1] === 'list') out(`package:${rest[3]}\npackage:${rest[3]}.extra\n`);
  else if (cmd === 'shell' && rest[0] === 'pidof') out('4242\n');
  // What is in front: com.example.probe (the app id of the http test and the phone driver) unless
  // FAKE_ADB_FRONT names another package, as a launcher covering the app would.
  else if (cmd === 'shell' && line === 'dumpsys window') {
    const front = process.env.FAKE_ADB_FRONT || 'com.example.probe';
    out(`WINDOW MANAGER WINDOWS (dumpsys window windows)\n  mCurrentFocus=Window{5e1c2a u0 ${front}/${front}.MainActivity}\n  mFocusedApp=ActivityRecord{9f3b11 u0 ${front}/.MainActivity t7}\n`);
  }
  else if (cmd === 'shell' && line === 'cat /proc/net/unix') out('Num       RefCount Protocol Flags    Type St Inode Path\n00000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_4242\n00000000: 00000002 00000000 00010000 0001 01 12346 @chrome_devtools_remote\n');
  else if (cmd === 'shell' && rest[0] === 'input') out(`${line}\n`);
  else if (cmd === 'shell' && rest[0] === 'am') out(`Starting: Intent { cmp=${rest[3]} }\n`);
  else if (cmd === 'exec-out' && line === 'screencap -p') process.stdout.write(tinyPng());
  else if (cmd === 'forward' && rest[0] === '--remove') out('');
  else if (cmd === 'forward') process.env.FAKE_ADB_CDP_PORT ? out(`${process.env.FAKE_ADB_CDP_PORT}\n`) : failWith('error: no FAKE_ADB_CDP_PORT');
  else if (cmd === 'install') out('Performing Streamed Install\nSuccess\n');
  else failWith(`fake-adb: no answer for ${args.join(' ')}`);
}
