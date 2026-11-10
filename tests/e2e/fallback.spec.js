// E2E with a MOCKED cloud endpoint (page.route) and the test-only mock local engine (?engine=mock).
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const cloud = { mode: 'ok', delayMs: 0, calls: 0 };

test.beforeEach(async ({ page }) => {
  Object.assign(cloud, { mode: 'ok', delayMs: 0, calls: 0 });
  await page.route('**/api/health', (r) => r.fulfill({ status: cloud.mode === 'ok' ? 200 : 503, body: cloud.mode }));
  await page.route('**/api/chat', async (route) => {
    cloud.calls++;
    const { prompt } = route.request().postDataJSON();
    if (cloud.mode === '503') return route.fulfill({ status: 503, body: 'overloaded' });
    if (cloud.mode === 'timeout') { await new Promise((r) => setTimeout(r, 2000)); return route.abort().catch(() => {}); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: `cloud says ${prompt}` }) });
  });
});

async function open(page, q = 'engine=mock&timeoutMs=300&cooldownMs=0&replayMs=200') {
  await page.goto(`/?${q}`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
}
async function ask(page, text) {
  await page.fill('#prompt', text);
  await page.click('button');
}

test('cloud healthy -> cloud answer', async ({ page }) => {
  await open(page);
  await ask(page, 'hello');
  await expect(page.locator('.answer').first()).toHaveAttribute('data-source', 'cloud');
  await expect(page.locator('.answer').first()).toContainText('cloud says hello');
  await expect(page.locator('#queue')).toHaveText('0');
});

test('cloud 503 -> local model answers and request is queued', async ({ page }) => {
  cloud.mode = '503';
  await open(page);
  await ask(page, 'hello');
  const a = page.locator('.answer').first();
  await expect(a).toHaveAttribute('data-source', 'local');
  await expect(a).toContainText('http_5xx');
  await expect(a).toContainText('[local mock] hello');
  await expect(page.locator('#queue')).toHaveText('1');
});

test('cloud timeout -> local fallback with reason timeout', async ({ page }) => {
  cloud.mode = 'timeout';
  await open(page);
  await ask(page, 'slow');
  await expect(page.locator('.answer').first()).toHaveAttribute('data-source', 'local');
  await expect(page.locator('.answer').first()).toContainText('timeout');
});

test('queued requests replay in order when cloud returns', async ({ page }) => {
  cloud.mode = '503';
  await open(page);
  await ask(page, 'one'); await expect(page.locator('#queue')).toHaveText('1');
  await ask(page, 'two'); await expect(page.locator('#queue')).toHaveText('2');
  cloud.mode = 'ok';
  await expect(page.locator('#queue')).toHaveText('0', { timeout: 5000 });
  const replayed = page.locator('.answer.replayed');
  await expect(replayed).toHaveCount(2);
  // newest first in the UI, so 'two' is on top
  await expect(replayed.nth(0)).toContainText('two → cloud says two');
  await expect(replayed.nth(1)).toContainText('one → cloud says one');
});

test('queue survives a page reload while the cloud is down', async ({ page }) => {
  cloud.mode = '503';
  await open(page);
  await ask(page, 'persist me');
  await expect(page.locator('#queue')).toHaveText('1');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await expect(page.locator('#queue')).toHaveText('1');
});

test('no local engine -> request queued, UI says so', async ({ page }) => {
  cloud.mode = '503';
  await open(page, 'engine=none&timeoutMs=300&replayMs=100000');
  await expect(page.locator('#engine')).toContainText('none');
  await ask(page, 'q');
  await expect(page.locator('.answer').first()).toHaveAttribute('data-source', 'queued');
  await expect(page.locator('#queue')).toHaveText('1');
});

test('measure fallback latency (mocked cloud, mock local engine)', async ({ page }) => {
  await open(page, 'engine=mock&timeoutMs=300&cooldownMs=0&replayMs=100000');
  const measure = (n) => page.evaluate(async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await window.__edge.client.ask(`m${i}`));
    return out.map((r) => ({ source: r.source, reason: r.reason, latencyMs: r.latencyMs }));
  }, n);
  const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const summary = {};
  for (const mode of ['ok', '503', 'timeout']) {
    cloud.mode = mode;
    const n = mode === 'timeout' ? 10 : 30;
    const rows = await measure(n);
    const lat = rows.map((r) => r.latencyMs);
    summary[mode] = { n, sources: [...new Set(rows.map((r) => r.source))], p50_ms: pct(lat, 0.5), p95_ms: pct(lat, 0.95), max_ms: Math.max(...lat) };
  }
  expect(summary.ok.sources).toEqual(['cloud']);
  expect(summary['503'].sources).toEqual(['local']);
  expect(summary.timeout.sources).toEqual(['local']);
  expect(summary.timeout.p50_ms).toBeGreaterThanOrEqual(290);
  mkdirSync('results', { recursive: true });
  writeFileSync('results/e2e-fallback-latency.json', JSON.stringify({
    label: 'MOCKED cloud (Playwright page.route) + mock local echo engine; measures client fallback overhead only, not model speed',
    date: new Date().toISOString().slice(0, 10), browser: 'chromium (Playwright, headless)', timeoutMs: 300, summary,
  }, null, 2));
});

test('record WebGPU availability in this test browser (honest probe)', async ({ page, browserName }) => {
  await open(page);
  const probe = await page.evaluate(async () => {
    const has = 'gpu' in navigator && !!navigator.gpu;
    let adapter = false;
    if (has) { try { adapter = !!(await navigator.gpu.requestAdapter()); } catch { adapter = false; } }
    return { navigator_gpu: has, adapter, ua: navigator.userAgent };
  });
  const text = await page.locator('#gpu').textContent();
  expect(text.startsWith('WebGPU:')).toBe(true);
  mkdirSync('results', { recursive: true });
  writeFileSync('results/webgpu-probe.json', JSON.stringify({ date: new Date().toISOString().slice(0, 10), browserName, headless: true, ...probe, ui: text }, null, 2));
});
