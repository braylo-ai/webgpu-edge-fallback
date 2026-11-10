// Edge-fallback client: cloud first; on 5xx/429/timeout/network -> local model in the browser.
// Every request that the cloud did not answer is queued and replayed when the cloud is healthy again.
import { callCloud, CloudUnavailable } from './cloud.js';

export class EdgeFallbackClient {
  constructor({
    cloudUrl, healthUrl, fetchImpl = (...a) => fetch(...a), localEngine = null, queue,
    timeoutMs = 4000, cooldownMs = 15000, now = () => performance.now(), onEvent = () => {},
  }) {
    Object.assign(this, { cloudUrl, healthUrl, fetchImpl, localEngine, queue, timeoutMs, cooldownMs, now, onEvent });
    this.breakerOpenUntil = -Infinity;
  }

  breakerOpen() {
    return this.now() < this.breakerOpenUntil;
  }

  async ask(prompt) {
    const t0 = this.now();
    const body = { prompt };
    let reason = 'breaker_open';
    if (!this.breakerOpen()) {
      try {
        const data = await callCloud({ fetchImpl: this.fetchImpl, url: this.cloudUrl, body, timeoutMs: this.timeoutMs });
        this.breakerOpenUntil = -Infinity;
        return { source: 'cloud', text: data.text, latencyMs: this.now() - t0 };
      } catch (err) {
        if (!(err instanceof CloudUnavailable)) throw err; // 4xx: caller bug, do not mask it
        reason = err.reason;
        this.breakerOpenUntil = this.now() + this.cooldownMs;
        this.onEvent({ type: 'cloud_down', reason });
      }
    }
    const fallbackAt = this.now();
    const { dropped } = this.queue.enqueue(body);
    if (dropped) this.onEvent({ type: 'queue_overflow', dropped });
    if (this.localEngine) {
      try {
        const text = await this.localEngine.generate(prompt);
        return { source: 'local', text, reason, queued: true, latencyMs: this.now() - t0,
                 fallbackDecisionMs: fallbackAt - t0, engine: this.localEngine.name };
      } catch (err) {
        this.onEvent({ type: 'local_failed', error: String(err?.message || err) });
      }
    }
    return { source: 'queued', text: null, reason, queued: true, latencyMs: this.now() - t0 };
  }

  async cloudHealthy() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const r = await this.fetchImpl(this.healthUrl, { signal: ctrl.signal });
      clearTimeout(t);
      return r.ok;
    } catch {
      return false;
    }
  }

  // Replay queued requests once the cloud answers health checks. Returns the replay summary.
  async replayIfHealthy(onResult = () => {}) {
    if (this.queue.size() === 0) return { replayed: [], remaining: 0, skipped: 'empty' };
    if (!(await this.cloudHealthy())) return { replayed: [], remaining: this.queue.size(), skipped: 'unhealthy' };
    const summary = await this.queue.replay(
      (body) => callCloud({ fetchImpl: this.fetchImpl, url: this.cloudUrl, body, timeoutMs: this.timeoutMs }),
      onResult,
    );
    if (summary.remaining === 0) this.breakerOpenUntil = -Infinity;
    return summary;
  }
}
