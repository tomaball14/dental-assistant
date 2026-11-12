// Runs the app without Vercel.
//   npm run dev   -> demo on http://localhost:3000
//   npm start     -> office-computer mode: real practice data saved in ./data,
//                    reachable from phones on the office Wi-Fi, access code required.
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomInt } from 'node:crypto';
import os from 'node:os';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const office = process.argv.includes('--office');

// Load .env (KEY=value lines) without any packages.
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (office) {
  process.env.LOCAL_DATA_DIR ||= join(root, 'data');
  if (!process.env.APP_ACCESS_CODE) {
    // First run: make an office code and remember it in .env.
    process.env.APP_ACCESS_CODE = String(randomInt(100000, 999999));
    const prior = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
    await writeFile(envPath, `${prior}${prior && !prior.endsWith('\n') ? '\n' : ''}APP_ACCESS_CODE=${process.env.APP_ACCESS_CODE}\n`);
  }
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const port = Number(process.env.PORT) || 3000;
const host = office ? '0.0.0.0' : '127.0.0.1';

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname.startsWith('/api/')) {
      const name = pathname.slice(5).replace(/[^a-z-]/g, '');
      const mod = await import(new URL(`../api/${name}.js`, import.meta.url));
      return await mod.default(req, res);
    }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '').replace(/\.\./g, '');
    const body = await readFile(join(root, 'public', rel));
    res.writeHead(200, { 'Content-Type': types[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    if (!res.headersSent) { res.writeHead(404); res.end('Not found'); }
  }
}).listen(port, host, () => {
  if (!office) return console.log(`Demo running: http://localhost:${port}`);
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => `http://${n.address}:${port}`);
  console.log('\n  Front Desk Assistant is running on this computer.\n');
  console.log(`  On this computer:   http://localhost:${port}`);
  lan.forEach((u) => console.log(`  On office phones:   ${u}   (same Wi-Fi)`));
  console.log(`\n  Office code:        ${process.env.APP_ACCESS_CODE}`);
  console.log('  Patient data is saved only in the "data" folder on this computer.');
  console.log('  Keep this window open while the office is using it.\n');
});
