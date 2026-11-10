// Static server + MOCK cloud endpoint for manual demos. Mode via POST /api/_mode {"mode":"ok"|"503"|"timeout"}.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
let mode = 'ok';

export function createDevServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/_mode' && req.method === 'POST') {
      let b = ''; for await (const c of req) b += c;
      mode = JSON.parse(b || '{}').mode || 'ok';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode }));
      return;
    }
    if (url.pathname === '/api/health') {
      res.writeHead(mode === 'ok' ? 200 : 503).end(mode);
      return;
    }
    if (url.pathname === '/api/chat') {
      let b = ''; for await (const c of req) b += c;
      if (mode === '503') { res.writeHead(503).end('overloaded'); return; }
      if (mode === 'timeout') return; // never answer
      const { prompt } = JSON.parse(b || '{}');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: `[mock cloud] ${prompt}` }));
      return;
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, rel);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(data);
    } catch { res.writeHead(404).end('not found'); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5173);
  createDevServer().listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
}
