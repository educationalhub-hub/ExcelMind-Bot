// Per-bot, in-memory catch-up queue. WhatsApp still has to deliver the message.
const RETENTION_MS = 48 * 60 * 60 * 1000;

export class ModerationQueue {
  constructor({ isReady, process, shouldRetry, onError, onDrop, maxSize = 2000, retentionMs = RETENTION_MS }) {
    this.isReady = isReady;
    this.process = process;
    this.shouldRetry = shouldRetry;
    this.onError = onError;
    this.onDrop = onDrop;
    this.maxSize = maxSize;
    this.retentionMs = retentionMs;
    this.pending = new Map();
    this.completed = new Map();
    this.draining = null;
    this.retryTimer = null;
  }

  add(messages = []) {
    const now = Date.now();
    for (const [key, completedAt] of this.completed) {
      if (now - completedAt >= this.retentionMs) this.completed.delete(key);
    }
    for (const message of messages) {
      const { key } = message || {};
      if (!message?.message || !key?.id || key.fromMe || !key.remoteJid?.endsWith('@g.us')) continue;
      const id = `${key.remoteJid}:${key.id}`;
      if (this.pending.has(id) || this.completed.has(id)) continue;
      if (this.pending.size >= this.maxSize) {
        this.onDrop(message, 'Catch-up queue is full; this message could not be queued.');
        continue;
      }
      this.pending.set(id, { message, receivedAt: now, failures: 0 });
    }
  }

  async drain() {
    if (this.draining) return this.draining;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.draining = this._drain().finally(() => {
      this.draining = null;
      if (this.pending.size && this.isReady()) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.drain();
        }, 3000);
      }
    });
    return this.draining;
  }

  async _drain() {
    while (this.pending.size && this.isReady()) {
      const [id, entry] = this.pending.entries().next().value;
      if (Date.now() - entry.receivedAt >= this.retentionMs) {
        this.pending.delete(id);
        this.onDrop(entry.message, 'Catch-up message expired after 48 hours in the queue.');
        continue;
      }
      try {
        // false means the socket changed or disconnected before deletion.
        const processed = await this.process(entry.message);
        if (this.pending.get(id) !== entry) continue; // Cleared during logout/stop.
        if (processed === false) break;
        this.pending.delete(id);
        this.completed.set(id, Date.now());
        if (this.completed.size > this.maxSize * 5) {
          this.completed.delete(this.completed.keys().next().value);
        }
      } catch (error) {
        if (this.pending.get(id) !== entry) continue;
        // A disconnect never consumes a retry: wait for the next connection.open.
        if (!this.isReady()) break;
        if (this.shouldRetry(error) && entry.failures++ < 3) break;
        this.pending.delete(id);
        this.onError(error, entry.message);
      }
    }
  }

  clear() {
    this.pending.clear();
    this.completed.clear();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }
}
