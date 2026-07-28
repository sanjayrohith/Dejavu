"use client";

import { useEffect, useRef } from "react";
import { getScrollTravel, retainScrollTravel } from "@/lib/scrollTravel";

/**
 * Page-wide ambient constellation — the hero's memory-graph motif carried
 * behind every section at low intensity (DESIGN.md §2: one motif, reused
 * quieter, rather than several borrowed ones).
 *
 * Scroll is the only thing that moves this field — there is no idle drift and no
 * loop running on its own. Hold the page still and the frame is frozen; scroll
 * and the points travel, parallaxed by depth. Matches the road in <Hyperspeed>,
 * so the whole backdrop advances together and stops together.
 */

type Pt = { x: number; y: number; vx: number; r: number; d: number };

const LINK_DIST = 132;
/** px of point travel per px scrolled, before each point's depth is applied.
 *  Kept in step with scrollTravel in <Hyperspeed> so the two backdrop layers
 *  move at a consistent rate rather than one outrunning the other. */
const PARALLAX = 0.16;

export default function AmbientField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let pts: Pt[] = [];
    let raf = 0;
    let lastTravel = getScrollTravel();
    let needsDraw = true;
    const release = retainScrollTravel();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      needsDraw = true;

      // density scaled to viewport area, capped so phones stay cheap
      const count = Math.min(64, Math.round((w * h) / 26000));
      pts = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.13,
        r: Math.random() * 1.5 + 0.7,
        d: Math.random() * 0.7 + 0.3, // depth → how much scroll moves it
      }));
    };

    /** fade points near the edges so wrap-around never pops a link on screen */
    const edgeFade = (p: Pt) => {
      const m = 90;
      return Math.min(
        1,
        Math.min(p.x, w - p.x) / m,
        Math.min(p.y, h - p.y) / m,
      );
    };

    const frame = () => {
      const travel = getScrollTravel();
      const step = travel - lastTravel;
      lastTravel = travel;

      /* Nothing moved and nothing invalidated the canvas — leave the last frame
         on screen untouched rather than clearing and redrawing an identical one */
      if (step === 0 && !needsDraw) {
        raf = requestAnimationFrame(frame);
        return;
      }
      needsDraw = false;

      ctx.clearRect(0, 0, w, h);

      for (const p of pts) {
        /* vx is reused as a per-point direction rather than a velocity, so the
           sideways drift is also paid for in scroll distance */
        p.x += step * p.vx * 0.6;
        p.y -= step * PARALLAX * p.d;
        if (p.x < -20) p.x = w + 20;
        if (p.x > w + 20) p.x = -20;
        if (p.y < -20) p.y = h + 20;
        if (p.y > h + 20) p.y = -20;
      }

      // links first, so dots sit on top
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const fa = edgeFade(a);
        if (fa <= 0) continue;
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist > LINK_DIST) continue;
          const alpha = (1 - dist / LINK_DIST) * 0.16 * fa * edgeFade(b);
          if (alpha <= 0.002) continue;
          ctx.strokeStyle = `rgba(86, 217, 232, ${alpha})`;
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      for (const p of pts) {
        const a = 0.32 * edgeFade(p);
        if (a <= 0.002) continue;
        ctx.fillStyle = `rgba(255, 176, 32, ${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    };
    const stop = () => cancelAnimationFrame(raf);
    const onVisibility = () => (document.hidden ? stop() : start());

    resize();
    start();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, []);

  return <canvas className="ambient" ref={ref} aria-hidden="true" />;
}
