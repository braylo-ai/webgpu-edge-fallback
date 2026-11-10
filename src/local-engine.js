// Local in-browser model. WebGPU only (WebLLM). Returns null when WebGPU is missing so the
// client degrades to "queued" instead of pretending it has a local model.
export const DEFAULT_MODEL = 'SmolLM2-360M-Instruct-q4f16_1-MLC';
export const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.79';

export async function detectWebGPU(nav = globalThis.navigator) {
  if (!nav || !('gpu' in nav) || !nav.gpu) return { available: false, why: 'navigator.gpu missing' };
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return { available: false, why: 'no GPU adapter' };
    return { available: true, why: 'ok' };
  } catch (e) {
    return { available: false, why: `requestAdapter threw: ${e?.message || e}` };
  }
}

export async function createWebLLMEngine({ model = DEFAULT_MODEL, onProgress = () => {}, importer = (u) => import(u) } = {}) {
  const gpu = await detectWebGPU();
  if (!gpu.available) return { engine: null, why: gpu.why };
  const webllm = await importer(WEBLLM_URL);
  const mlc = await webllm.CreateMLCEngine(model, { initProgressCallback: onProgress });
  return {
    why: 'ok',
    engine: {
      name: `webllm:${model}`,
      async generate(prompt) {
        const r = await mlc.chat.completions.create({
          messages: [{ role: 'user', content: prompt }], max_tokens: 128, temperature: 0,
        });
        return r.choices[0].message.content;
      },
    },
  };
}
