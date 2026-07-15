/**
 * Minimal ULID implementation.
 *
 * 26 chars: 10 char timestamp (ms) + 16 char randomness, Crockford base32.
 * Sortable by creation time. No external deps.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10;
const RAND_LEN = 16;

function encodeTime(now: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    out = ENCODING[mod] + out;
    now = (now - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(len: number): string {
  let out = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) {
    out += ENCODING[bytes[i]! % ENCODING_LEN];
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now, TIME_LEN) + encodeRandom(RAND_LEN);
}

export function ulidTimestamp(id: string): number {
  if (id.length !== 26) throw new Error(`invalid ulid: ${id}`);
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const c = id[i]!;
    const idx = ENCODING.indexOf(c);
    if (idx === -1) throw new Error(`invalid ulid char: ${c}`);
    time = time * ENCODING_LEN + idx;
  }
  return time;
}
