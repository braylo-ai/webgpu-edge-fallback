// Offline request queue. Persists to any Storage-like object (localStorage in the browser).
// Order is preserved; replay stops at the first failure so later requests never overtake earlier ones.
export class RequestQueue {
  constructor({ storage, key = 'edge-fallback-queue', maxItems = 100, now = () => Date.now() } = {}) {
    if (!storage) throw new Error('storage required');
    this.storage = storage;
    this.key = key;
    this.maxItems = maxItems;
    this.now = now;
    this.seq = 0;
  }

  list() {
    try {
      return JSON.parse(this.storage.getItem(this.key) || '[]');
    } catch {
      return []; // corrupted storage: start empty rather than crash the app
    }
  }

  _save(items) {
    this.storage.setItem(this.key, JSON.stringify(items));
  }

  enqueue(request) {
    const items = this.list();
    const item = { id: `${this.now()}-${this.seq++}`, request, queuedAt: this.now(), attempts: 0 };
    items.push(item);
    let dropped = 0;
    while (items.length > this.maxItems) {
      items.shift();
      dropped++;
    }
    this._save(items);
    return { item, dropped };
  }

  size() {
    return this.list().length;
  }

  // send(request) -> Promise<result>; throws to signal failure.
  async replay(send, onResult = () => {}) {
    const replayed = [];
    let items = this.list();
    while (items.length) {
      const head = items[0];
      try {
        const result = await send(head.request);
        items = this.list().filter((i) => i.id !== head.id);
        this._save(items);
        replayed.push(head.id);
        onResult(head, result);
      } catch (err) {
        head.attempts += 1;
        this._save(items);
        return { replayed, remaining: items.length, stoppedOn: head.id, error: String(err?.message || err) };
      }
    }
    return { replayed, remaining: 0 };
  }
}

export class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
