/**
 * The scroll film: a 150-frame camera move that crosses a lantern-lit bridge at
 * dawn, arrives at a gate, passes through it, and settles inside a candlelit
 * hall. The page rides that shot from top to bottom.
 *
 * Frames live in /public/frames, built by scripts/build-frames.sh from 1280x720
 * masters that are kept in git history rather than in the tree — that script
 * documents how to restore them. The masters are heavily compressed, so each
 * one is deblocked and debanded *before* being resampled; see the script for
 * why. Two sets, because a phone should not pull a desktop sequence:
 *   hd — 1920x1080 WebP, every frame
 *   sm — 1280x720  WebP, every other frame
 *
 * Both are delivered above the master's 1280px so that what the browser
 * enlarges is a clean picture rather than a grid of JPEG blocks.
 */

export const FRAME_COUNT = 150;

export interface FrameSet {
  dir: "hd" | "sm";
  ext: "jpg" | "webp";
  /** 1 = every frame, 2 = every other frame */
  step: number;
  width: number;
  height: number;
}

export const HD: FrameSet = { dir: "hd", ext: "webp", step: 1, width: 1920, height: 1080 };
export const SM: FrameSet = { dir: "sm", ext: "webp", step: 2, width: 1280, height: 720 };

export function frameSrc(set: FrameSet, n: number): string {
  return `/frames/${set.dir}/${String(n).padStart(3, "0")}.${set.ext}`;
}

/**
 * Nearest frame index this set actually ships. The sm set samples every other
 * frame, so rounding to a plain integer there can land on a frame that was never
 * encoded — and the painter would bracket-blend around it, which is exactly the
 * soft double image the caller was trying to avoid.
 */
export function nearestFrame(set: FrameSet, f: number): number {
  const snapped = Math.round((f - 1) / set.step) * set.step + 1;
  return snapped < 1 ? 1 : snapped > FRAME_COUNT ? FRAME_COUNT : snapped;
}

/** Frame indices this set actually ships, low to high. */
export function frameList(set: FrameSet): number[] {
  const out: number[] = [];
  for (let n = 1; n <= FRAME_COUNT; n += set.step) out.push(n);
  if (out[out.length - 1] !== FRAME_COUNT) out.push(FRAME_COUNT);
  return out;
}

/**
 * Fetch order. Not 1..150: the opening frames come first so the hero paints
 * immediately, then a coarse pass every fifth frame so a fast scroll always has
 * *something* near the target, then the gaps fill in.
 */
export function fetchOrder(set: FrameSet): number[] {
  const all = frameList(set);
  const seen = new Set<number>();
  const order: number[] = [];
  const push = (n: number) => {
    if (n != null && !seen.has(n)) {
      seen.add(n);
      order.push(n);
    }
  };

  for (let i = 0; i < Math.min(8, all.length); i++) push(all[i]);
  for (let i = 0; i < all.length; i += Math.max(1, Math.round(5 / set.step))) push(all[i]);
  for (const n of all) push(n);

  return order;
}

/* ---------------- the shot, in acts ---------------- */

/**
 * How dark the veil over the film sits, by frame. Interpolated linearly.
 *
 * Near zero, deliberately. The plate is the page's subject, not its wallpaper,
 * and every point of veil is contrast taken from the picture to make type
 * easier. Type buys its own contrast instead — the panels are blurred glass and
 * the hero copy carries a three-stop shadow — so none of it needs the whole
 * frame held down. What is left here is act-aware only in the sense that the
 * bright dawn exterior can carry a hair more than the candlelit interior, where
 * the plate is already near-black and any veil at all eats the candles.
 */
export const VEIL_STOPS: [frame: number, opacity: number][] = [
  [1, 0.06],
  [60, 0.06],
  [88, 0.05],
  [96, 0.03],
  [110, 0.02],
  [150, 0.03],
];

export function veilAt(frame: number): number {
  const s = VEIL_STOPS;
  if (frame <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (frame <= s[i][0]) {
      const [f0, v0] = s[i - 1];
      const [f1, v1] = s[i];
      const t = (frame - f0) / (f1 - f0);
      return v0 + (v1 - v0) * t;
    }
  }
  return s[s.length - 1][1];
}

/**
 * Cue frames, in document order. Each is attached to a marker in the page; the
 * scrubber interpolates between neighbouring markers, so the pacing is set by
 * how much page sits between two cues rather than by a fixed frames-per-pixel.
 *
 * The exterior travel (1–96) is spread thin over the sparse cinematic beats;
 * the interior (96–150) drifts slowly under the dense reference content, which
 * is where a reader actually stops to read.
 */
export const CUE = {
  top: 1,
  heroEnd: 14,
  beatApproach: 30,
  problem: 46,
  beatDoor: 68,
  how: 84,
  beatThreshold: 96,
  lap1: 108,
  lap2: 118,
  lap3: 126,
  lap4: 133,
  boundaries: 138,
  mcp: 142,
  shared: 145,
  beatArchive: 147,
  install: 149,
  end: 150,
} as const;
