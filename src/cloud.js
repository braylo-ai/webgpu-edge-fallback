// Cloud call with timeout. Classifies failures so the client can decide whether to fall back.
export class CloudUnavailable extends Error {
  constructor(reason, status) {
    super(`cloud unavailable: ${reason}`);
    this.reason = reason; // 'timeout' | 'http_5xx' | 'http_429' | 'network'
    this.status = status;
  }
}

export class CloudClientError extends Error {
  constructor(status, body) {
    super(`cloud rejected request: HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

const FALLBACK_STATUSES = new Set([429, 500, 502, 503, 504]);

export async function callCloud({ fetchImpl, url, body, timeoutMs = 4000 }) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new CloudUnavailable(timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  if (FALLBACK_STATUSES.has(res.status)) {
    throw new CloudUnavailable(res.status === 429 ? 'http_429' : 'http_5xx', res.status);
  }
  if (!res.ok) {
    throw new CloudClientError(res.status, await res.text().catch(() => ''));
  }
  const data = await res.json();
  if (typeof data?.text !== 'string') throw new CloudClientError(res.status, 'missing text field');
  return data;
}
