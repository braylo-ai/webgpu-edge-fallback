import { EdgeFallbackClient } from './client.js';
import { RequestQueue } from './queue.js';
import { createWebLLMEngine, detectWebGPU } from './local-engine.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const log = (msg) => { const li = document.createElement('li'); li.textContent = msg; $('events').prepend(li); };

// TEST-ONLY: ?engine=mock swaps WebLLM for a deterministic echo engine so Playwright can run
// without a GPU or a model download. The UI labels it so it is never mistaken for a real model.
function mockEngine() {
  return { name: 'mock-echo (test only)', async generate(p) { return `[local mock] ${p}`; } };
}

async function boot() {
  const gpu = await detectWebGPU();
  $('gpu').textContent = gpu.available ? 'WebGPU: available' : `WebGPU: unavailable (${gpu.why})`;
  let engine = null;
  if (params.get('engine') === 'mock') engine = mockEngine();
  else if (params.get('engine') !== 'none' && gpu.available) {
    $('engine').textContent = 'Local model: loading…';
    try {
      const r = await createWebLLMEngine({ onProgress: (p) => { $('engine').textContent = `Local model: ${p.text}`; } });
      engine = r.engine;
    } catch (e) { log(`local model failed to load: ${e.message}`); }
  }
  $('engine').textContent = engine ? `Local model: ${engine.name}` : 'Local model: none (requests will queue)';

  const queue = new RequestQueue({ storage: localStorage });
  const client = new EdgeFallbackClient({
    cloudUrl: '/api/chat', healthUrl: '/api/health', localEngine: engine, queue,
    timeoutMs: Number(params.get('timeoutMs') || 4000), cooldownMs: Number(params.get('cooldownMs') || 15000),
    onEvent: (e) => log(`${e.type}${e.reason ? `: ${e.reason}` : ''}`),
  });
  const renderQueue = () => { $('queue').textContent = String(queue.size()); };
  renderQueue();

  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const prompt = $('prompt').value.trim();
    if (!prompt) return;
    $('prompt').value = '';
    const r = await client.ask(prompt);
    const div = document.createElement('div');
    div.className = `answer ${r.source}`;
    div.dataset.source = r.source;
    div.textContent = `[${r.source}${r.reason ? ` · ${r.reason}` : ''} · ${Math.round(r.latencyMs)} ms] ${r.text ?? '(queued for cloud)'}`;
    $('answers').prepend(div);
    renderQueue();
  });

  const replay = async () => {
    const s = await client.replayIfHealthy((item, result) => {
      const div = document.createElement('div');
      div.className = 'answer replayed';
      div.dataset.source = 'replayed';
      div.textContent = `[cloud replay] ${item.request.prompt} → ${result.text}`;
      $('answers').prepend(div);
    });
    if (s.replayed.length) log(`replayed ${s.replayed.length} queued request(s)`);
    renderQueue();
  };
  addEventListener('online', replay);
  setInterval(replay, Number(params.get('replayMs') || 5000));
  window.__edge = { client, queue, replay };
  document.body.dataset.ready = '1';
}
boot();
