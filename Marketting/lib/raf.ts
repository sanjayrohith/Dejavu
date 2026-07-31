/**
 * One requestAnimationFrame loop for the whole page.
 *
 * The film scrubber and every scroll-linked panel read the same scroll position
 * on the same tick, so they can never disagree by a frame — and a page with a
 * dozen scroll-driven elements still costs exactly one rAF and one passive
 * scroll listener.
 */

export interface Tick {
  /** seconds since the previous tick, clamped so a backgrounded tab can't jump */
  dt: number;
  /** window.scrollY, sampled once per frame */
  y: number;
  /** document scroll range in px, ≥ 0 */
  max: number;
  /** viewport height */
  vh: number;
}

type Cb = (t: Tick) => void;

const subs = new Set<Cb>();
let raf = 0;
let last = 0;

function frame(now: number) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
  last = now;

  const vh = window.innerHeight;
  const tick: Tick = {
    dt,
    y: window.scrollY,
    max: Math.max(0, document.documentElement.scrollHeight - vh),
    vh,
  };

  for (const cb of subs) cb(tick);
  raf = requestAnimationFrame(frame);
}

function start() {
  if (raf || !subs.size || document.hidden) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}

function stop() {
  if (!raf) return;
  cancelAnimationFrame(raf);
  raf = 0;
}

let boundVisibility = false;

/** Subscribe to the shared loop. Returns an unsubscribe function. */
export function onFrame(cb: Cb): () => void {
  subs.add(cb);

  if (!boundVisibility) {
    boundVisibility = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stop();
      else start();
    });
  }

  start();

  return () => {
    subs.delete(cb);
    if (!subs.size) stop();
  };
}

/* ---------------- easing ---------------- */

/** Smoothstep — eases out of one cue and into the next. */
export function smooth(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Frame-rate independent damping. `speed` is roughly "how many e-folds per
 * second", so the same visual weight at 60Hz and at 144Hz.
 */
export function damp(current: number, target: number, speed: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-speed * dt));
}

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
