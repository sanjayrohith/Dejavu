"use client";

import { useEffect, useRef, useState } from "react";
import {
  FRAME_COUNT,
  HD,
  SM,
  fetchOrder,
  frameSrc,
  veilAt,
  type FrameSet,
} from "@/lib/film";
import { clamp, damp, onFrame, smooth } from "@/lib/raf";

/** How hard the frame chases the scroll. Higher = tighter, lower = floatier. */
const CHASE = 9;
/** Parallel image requests. Enough to saturate a connection, few enough to
    keep the opening frames ahead of the reader. */
const CONCURRENCY = 8;
/** The coarse pass is this many frames; below it the hero still shows a loader. */
const READY_AT = 10;

interface Cue {
  /** scrollY at which this cue is exactly on screen */
  pos: number;
  frame: number;
}

/**
 * The page's backdrop: a scrubbed image sequence pinned behind everything.
 *
 * Cues are read from the DOM — any element carrying `data-film-cue="<frame>"`
 * anchors that frame to its own position — so pacing is edited in the page, not
 * in here. Between two cues the frame eases (smoothstep) rather than tracking
 * scroll linearly, which lands each arrival instead of sliding past it.
 */
export default function Film() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** first frame is painted — fade the plate in under the hero */
  const [shown, setShown] = useState(false);
  /** enough of the sequence is in that scrubbing won't dissolve — drop the bar */
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const set: FrameSet = window.matchMedia("(max-width: 900px)").matches ? SM : HD;

    /* ---------------- frame store ---------------- */

    const images = new Map<number, HTMLImageElement>();
    let loadedCount = 0;

    /** Nearest frame at or below `n` that has actually decoded. */
    function below(n: number): number | null {
      for (let i = Math.floor(n); i >= 1; i--) if (images.has(i)) return i;
      return null;
    }

    /** Nearest frame at or above `n` that has actually decoded. */
    function above(n: number): number | null {
      for (let i = Math.ceil(n); i <= FRAME_COUNT; i++) if (images.has(i)) return i;
      return null;
    }

    /* ---------------- loading ---------------- */

    const order = fetchOrder(set);
    let cursor = 0;
    let disposed = false;

    function pump() {
      if (disposed || cursor >= order.length) return;
      const n = order[cursor++];
      if (images.has(n)) return pump();

      const img = new Image();
      img.decoding = "async";
      img.src = frameSrc(set, n);

      const settle = (ok: boolean) => {
        if (disposed) return;
        if (ok) {
          images.set(n, img);
          loadedCount++;
          setProgress(loadedCount / order.length);
          if (loadedCount === 1) {
            render(current);
            setShown(true);
          }
          if (loadedCount >= READY_AT) setReady(true);
        }
        pump();
      };

      /* decode() up front so drawImage never stalls the compositor mid-scroll */
      img
        .decode()
        .then(() => settle(true))
        .catch(() => settle(img.complete && img.naturalWidth > 0));
    }

    for (let i = 0; i < CONCURRENCY; i++) pump();

    /* ---------------- cues ---------------- */

    let cues: Cue[] = [];

    function measure() {
      const vh = window.innerHeight;
      const max = Math.max(0, document.documentElement.scrollHeight - vh);
      const els = document.querySelectorAll<HTMLElement>("[data-film-cue]");

      const next: Cue[] = [];
      els.forEach((el) => {
        const frame = Number(el.dataset.filmCue);
        if (!Number.isFinite(frame)) return;
        const top = el.getBoundingClientRect().top + window.scrollY;
        next.push({ pos: clamp(top - vh * 0.5, 0, max), frame });
      });

      next.sort((a, b) => a.pos - b.pos);
      cues = next;
    }

    function targetFrame(y: number): number {
      if (!cues.length) return 1;
      if (y <= cues[0].pos) return cues[0].frame;

      for (let i = 1; i < cues.length; i++) {
        if (y > cues[i].pos) continue;
        const a = cues[i - 1];
        const b = cues[i];
        const span = b.pos - a.pos;
        const t = span > 0 ? smooth((y - a.pos) / span) : 1;
        return a.frame + (b.frame - a.frame) * t;
      }
      return cues[cues.length - 1].frame;
    }

    /** Reduced motion gets the act, not the move: snap to the nearest cue. */
    function snapFrame(y: number): number {
      if (!cues.length) return 1;
      let best = cues[0];
      for (const c of cues) if (y >= c.pos) best = c;
      return best.frame;
    }

    /* ---------------- painting ---------------- */

    let cw = 0;
    let ch = 0;
    let dpr = 1;

    function resize() {
      cw = root!.clientWidth;
      ch = root!.clientHeight;

      /* The plate is only 1280px wide, so a retina backing store would just
         upscale further for nothing. Cap the buffer at a modest multiple of the
         source and let the browser's bilinear filter do the rest — same picture,
         a quarter of the fill rate on a 4K display. */
      const ceiling = cw > 0 ? (set.width * 1.7) / cw : 2;
      dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2, ceiling));

      canvas!.width = Math.round(cw * dpr);
      canvas!.height = Math.round(ch * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.imageSmoothingEnabled = true;
      ctx!.imageSmoothingQuality = "high";
      render(current);
    }

    function cover(img: HTMLImageElement, alpha: number) {
      const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
      const w = img.naturalWidth * s;
      const h = img.naturalHeight * s;
      ctx!.globalAlpha = alpha;
      ctx!.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    }

    let painted = -1;

    function render(f: number) {
      if (!cw || !ch) return;

      const lo = below(f);
      const hi = above(f);
      if (lo == null && hi == null) return;

      ctx!.globalAlpha = 1;
      ctx!.fillStyle = "#07080b";
      ctx!.fillRect(0, 0, cw, ch);

      if (lo == null) cover(images.get(hi!)!, 1);
      else if (hi == null || hi === lo) cover(images.get(lo)!, 1);
      else {
        /* blend the two bracketing frames — this is what turns 150 discrete
           stills into continuous motion, and it also dissolves gracefully over
           gaps that have not finished downloading yet */
        cover(images.get(lo)!, 1);
        cover(images.get(hi)!, clamp((f - lo) / (hi - lo), 0, 1));
      }
      ctx!.globalAlpha = 1;

      root!.style.setProperty("--film-veil", veilAt(f).toFixed(3));
      root!.style.setProperty("--film-warm", clamp((f - 88) / 26, 0, 1).toFixed(3));
      painted = f;
    }

    /* ---------------- loop ---------------- */

    let current = 1;

    const stop = onFrame(({ dt, y }) => {
      const target = reduced ? snapFrame(y) : targetFrame(y);
      current = reduced ? target : damp(current, target, CHASE, dt);

      /* settle exactly, so a held frame is a held frame and not a slow crawl */
      if (Math.abs(target - current) < 0.004) current = target;
      if (Math.abs(current - painted) < 0.004) return;

      render(current);
    });

    /* ---------------- wiring ---------------- */

    resize();
    measure();

    let remeasure = 0;
    const scheduleMeasure = () => {
      clearTimeout(remeasure);
      remeasure = window.setTimeout(measure, 120);
    };

    const onResize = () => {
      resize();
      scheduleMeasure();
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    /* the document grows as fonts swap in and reveals expand — cue positions
       are only correct once that settles, so watch the page box too */
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(document.documentElement);
    document.fonts?.ready.then(scheduleMeasure).catch(() => {});

    return () => {
      disposed = true;
      stop();
      ro.disconnect();
      clearTimeout(remeasure);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      images.clear();
    };
  }, []);

  return (
    <div className="film" ref={rootRef} aria-hidden="true">
      <canvas className="film__canvas" ref={canvasRef} data-ready={shown} />
      <div className="film__veil" />
      <div className="film__vignette" />
      <div className="film__grain" />
      <div className="film__load" data-done={ready}>
        <span className="film__load-bar" style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}
