/**
 * One scroll-driven travel value, shared by every backdrop layer.
 *
 * The road, the ambient field and the hero waypoints all have to advance from
 * the same number: any drift between them and the illusion that they occupy one
 * space falls apart. This also keeps the "frozen unless scrolling" guarantee in
 * a single place instead of being re-derived (and re-broken) per component.
 *
 * The value is *pixels of page scrolled*, smoothed. Each layer applies its own
 * rate on top, so they can move at different speeds while staying in lockstep.
 */

/** how fast travel chases the real scroll position, per second */
const SMOOTHING_RATE = 12;
/** below this gap travel snaps, so it reaches a true stop rather than creeping */
const SETTLE = 1e-4;

let travel = 0;
let target = 0;
let lastScrollY = 0;
let lastT = 0;
let raf = 0;
let refs = 0;
let reduced = false;

const onScroll = () => {
  const y = window.scrollY;
  const dy = y - lastScrollY;
  lastScrollY = y;
  if (dy === 0 || reduced) return;
  target += dy;
};

const frame = (t: number) => {
  // clamped so a backgrounded tab does not resume with one enormous step
  const dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 1 / 60;
  lastT = t;

  const gap = target - travel;
  if (Math.abs(gap) < SETTLE) travel = target;
  else travel += gap * (1 - Math.exp(-dt * SMOOTHING_RATE));

  raf = requestAnimationFrame(frame);
};

/**
 * Start (or join) the shared loop. Ref-counted — the listener and rAF exist
 * only while at least one layer is mounted. Returns the release function.
 */
export function retainScrollTravel(): () => void {
  if (typeof window === "undefined") return () => {};

  if (refs === 0) {
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    lastScrollY = window.scrollY;
    // seed from the current position: reloading deep in the page should not
    // animate the entire backdrop up from zero
    travel = window.scrollY;
    target = travel;
    lastT = 0;
    window.addEventListener("scroll", onScroll, { passive: true });
    raf = requestAnimationFrame(frame);
  }
  refs++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refs--;
    if (refs === 0) {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    }
  };
}

/** Smoothed pixels of page scrolled. Exactly constant while the page is still. */
export function getScrollTravel(): number {
  return travel;
}
