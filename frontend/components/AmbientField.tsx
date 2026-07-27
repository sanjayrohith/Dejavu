"use client";

import { useEffect, useRef } from "react";

/**
 * Page-wide ambient constellation — the hero's memory-graph motif carried
 * behind every section at low intensity (DESIGN.md §2: one motif, reused
 * quieter, rather than several borrowed ones).
 *
 * Points drift slowly and link to near neighbours; scrolling imparts momentum,
 * so the field reacts to the reader instead of looping indifferently.
 */

type Pt = { x: number; y: number; vx: number; vy: number; r: number; d: number };

const LINK_DIST = 132;

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
    let boost = 0;
    let lastScroll = window.scrollY;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // density scaled to viewport area, capped so phones stay cheap
      const count = Math.min(64, Math.round((w * h) / 26000));
      pts = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.13,
        vy: (Math.random() - 0.5) * 0.13,
        r: Math.random() * 1.5 + 0.7,
        d: Math.random() * 0.7 + 0.3, // depth → how much scroll moves it
      }));
    };

    const onScroll = () => {
      const dy = window.scrollY - lastScroll;
      lastScroll = window.scrollY;
      boost = Math.max(-40, Math.min(40, boost + dy * 0.35));
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
      boost *= 0.9;
      ctx.clearRect(0, 0, w, h);

      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy - boost * 0.02 * p.d;
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
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas className="ambient" ref={ref} aria-hidden="true" />;
}
