const clone = (value) => structuredClone(value);
const fingerprint = (value) => JSON.stringify(value);

export class ReferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReferenceError";
    this.code = code;
  }
}

export class ResponseItemCache {
  constructor({ maxEntries = 256, ttlMs = 600_000, now = () => Date.now() } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError("maxEntries must be positive");
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new TypeError("ttlMs must be positive");
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.expired = new Map();
    this.counters = { cached_responses: 0, expanded_references: 0, unknown_references: 0, expired_references: 0, collisions: 0, evictions: 0 };
  }

  #prune() {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        this.expired.set(id, now);
      }
    }
    for (const [id, at] of this.expired) if (now - at > this.ttlMs) this.expired.delete(id);
  }

  store(response) {
    this.#prune();
    if (!response || typeof response !== "object" || !Array.isArray(response.output)) return { stored: 0 };
    const candidates = [];
    if (typeof response.id === "string" && response.id) candidates.push([response.id, response.output]);
    for (const item of response.output) if (typeof item?.id === "string" && item.id) candidates.push([item.id, item]);
    const within = new Map();
    for (const [id, value] of candidates) {
      const mark = fingerprint(value);
      if ((within.has(id) && within.get(id) !== mark) || (this.entries.has(id) && this.entries.get(id).fingerprint !== mark)) {
        this.counters.collisions++;
        throw new ReferenceError("reference_collision", "response/item ID collision; response was not cached");
      }
      within.set(id, mark);
    }
    const expiresAt = this.now() + this.ttlMs;
    for (const [id, value] of candidates) {
      this.entries.delete(id);
      this.entries.set(id, { value: clone(value), fingerprint: fingerprint(value), expiresAt });
      this.expired.delete(id);
    }
    while (this.entries.size > this.maxEntries) {
      const id = this.entries.keys().next().value;
      this.entries.delete(id);
      this.expired.set(id, this.now());
      this.counters.evictions++;
    }
    this.counters.cached_responses++;
    return { stored: candidates.length };
  }

  resolve(id) {
    this.#prune();
    const entry = this.entries.get(id);
    if (!entry) {
      if (this.expired.has(id)) {
        this.counters.expired_references++;
        throw new ReferenceError("expired_reference", "item_reference is expired or was evicted");
      }
      this.counters.unknown_references++;
      throw new ReferenceError("unknown_reference", "item_reference is unknown");
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    return clone(entry.value);
  }

  stats() {
    this.#prune();
    return { ...this.counters, entries: this.entries.size, max_entries: this.maxEntries, ttl_ms: this.ttlMs };
  }
}

export function expandReferences(body, cache, { variant = "exact" } = {}) {
  if (!body || typeof body !== "object" || !Array.isArray(body.input)) return { body, expanded: 0 };
  let expanded = 0;
  const input = [];
  for (const item of body.input) {
    if (item?.type !== "item_reference") {
      input.push(item);
      continue;
    }
    if (typeof item.id !== "string" || !item.id) throw new ReferenceError("invalid_reference", "item_reference must contain a non-empty id");
    const resolved = cache.resolve(item.id);
    const values = Array.isArray(resolved) ? resolved : [resolved];
    for (const value of values) input.push(normalize(value, variant));
    expanded++;
  }
  cache.counters.expanded_references += expanded;
  return { body: expanded ? { ...body, input } : body, expanded };
}

function normalize(item, variant) {
  if (variant === "exact") return item;
  if (variant === "strip-output-metadata") {
    const { id: _id, status: _status, ...supported } = item;
    return supported;
  }
  throw new ReferenceError("invalid_variant", "unsupported adapter normalization variant");
}
