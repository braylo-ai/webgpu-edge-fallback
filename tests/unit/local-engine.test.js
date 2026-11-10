import test from 'node:test';
import assert from 'node:assert/strict';
import { detectWebGPU, createWebLLMEngine } from '../../src/local-engine.js';

test('detectWebGPU: missing navigator.gpu', async () => {
  assert.equal((await detectWebGPU({})).available, false);
});
test('detectWebGPU: null adapter', async () => {
  const r = await detectWebGPU({ gpu: { requestAdapter: async () => null } });
  assert.deepEqual(r, { available: false, why: 'no GPU adapter' });
});
test('createWebLLMEngine returns null engine without WebGPU and never imports WebLLM', async () => {
  let imported = false;
  const r = await createWebLLMEngine({ importer: async () => { imported = true; } });
  assert.equal(r.engine, null); assert.equal(imported, false);
});
