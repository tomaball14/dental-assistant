// Local server that mimics Vercel: /api/<name> -> api/<name>.js, everything else from public/.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const port = Number(process.env.PORT) || 3000;

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname.startsWith('/api/')) {
      const name = pathname.slice(5).replace(/[^a-z-]/g, '');
      const mod = await import(join(root, 'api', `${name}.js`));
      return await mod.default(req, res);
    }
    const file = join(root, 'public', pathname === '/' ? 'index.html' : pathname.replace(/\.\./g, ''));
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    if (!res.headersSent) { res.writeHead(404); res.end('Not found'); }
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
