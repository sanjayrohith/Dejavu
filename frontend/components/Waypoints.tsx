"use client";

import { useEffect, useRef } from "react";
import { KINDS } from "@/lib/content";
import { getScrollTravel, retainScrollTravel } from "@/lib/scrollTravel";

/**
 * The recall run: the seven slip kinds laid out as waypoints down the road, so
 * scrolling the hero flies you past them one after another.
 *
 * Positions come from the shared scroll travel, in page pixels, projected by
 * hand: a waypoint appears at the vanishing point, swells as you close on it,
 * then sweeps out past the edge of frame. Typed links thread forward from each
 * waypoint to the next, so there is always a line pulling toward the one ahead.
 *
 * Attributes are mutated directly in the rAF rather than driven through React
 * state — same approach as the old MemoryGraph, and it keeps a per-frame
 * animation from re-rendering the tree. Nothing is written at all when travel
 * has not changed, so the run freezes with the rest of the backdrop.
 */

/** where the road converges, as a fraction of the viewport */
const VANISH: [number, number] = [0.58, 0.36];
/** lateral spread in px at unit scale */
const SPREAD = 180;
/** scroll px that reads as "one unit of depth" */
const DEPTH = 420;
/** first waypoint's distance, and the gap between them, in scroll px.
 *  Sized so the last one is passed inside a single viewport of scrolling —
 *  this is the hero's run, and it should not still be going three sections in. */
const FIRST_Z = 100;
const GAP = 133;
/** how far ahead a waypoint is still drawn / how far past before it is dropped */
const FAR = 1400;
const NEAR = -120;

/* Lateral offsets, biased right of centre because the headline owns the lower
   left of the hero and the run must never sweep through it. Laid out by angle
   with at least 45° between consecutive waypoints: two that are adjacent in the
   run are on screen together, and without that separation their labels collide. */
const LANES: [number, number][] = [
  [0.36, -0.51], // decision   −55°
  [0.82, 0.48], // preference  +30°
  [0.19, 0.7], // procedure    +75°
  [0.95, -0.55], // pitfall    −30°
  [0.49, 0.7], // fact         +55°
  [0.34, -0.94], // wip        −70°
  [0.67, 0.12], // note        +10°
];

/* The real link vocabulary, threaded along the run in order. */
const RELS = [
  "related",
  "related",
  "contradicts",
  "related",
  "supersedes",
  "related",
] as const;

const LAST_Z = FIRST_Z + (KINDS.length - 1) * GAP;
/** the overlay is gone this far past the final waypoint */
const RUN_END = LAST_Z + 350;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export default function Waypoints() {
  const rootRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<(SVGGElement | null)[]>([]);
  const coreRefs = useRef<(SVGCircleElement | null)[]>([]);
  const haloRefs = useRef<(SVGCircleElement | null)[]>([]);
  const ringRefs = useRef<(SVGCircleElement | null)[]>([]);
  const labelRefs = useRef<(SVGTextElement | null)[]>([]);
  const edgeRefs = useRef<(SVGPathElement | null)[]>([]);
  const hudRef = useRef<HTMLDivElement>(null);
  const hudIdxRef = useRef<HTMLSpanElement>(null);
  const hudKindRef = useRef<HTMLSpanElement>(null);
  const hudUseRef = useRef<HTMLParagraphElement>(null);
  const tickRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const release = retainScrollTravel();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = window.innerWidth;
    let h = window.innerHeight;
    const onResize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      lastTravel = NaN; // force a redraw at the new size
    };
    window.addEventListener("resize", onResize);

    let raf = 0;
    let lastTravel = NaN;
    let lastActive = -1;

    const draw = (travel: number) => {
      const vx = VANISH[0] * w;
      const vy = VANISH[1] * h;

      // the whole run fades out once the last waypoint is behind you
      const runFade = clamp01((RUN_END - travel) / 350);
      if (rootRef.current) rootRef.current.style.opacity = runFade.toFixed(3);
      if (runFade <= 0) return;

      const pos: { x: number; y: number; a: number; s: number }[] = [];

      for (let i = 0; i < KINDS.length; i++) {
        const d = FIRST_Z + i * GAP - travel;
        const u = d / DEPTH;
        /* Clamp the denominator: once a waypoint is far enough behind the camera
           this term crosses zero, the projection inverts, and every derived
           radius goes negative — which SVG rejects outright. */
        const s = 1 / Math.max(u * 0.85 + 0.3, 0.08);

        // fade in from the distance, and out as it passes the camera
        const a = clamp01((FAR - d) / (FAR * 0.45)) * clamp01((d - NEAR) / 220);

        const [ox, oy] = LANES[i];
        const x = vx + ox * s * SPREAD;
        const y = vy + oy * s * SPREAD;
        pos.push({ x, y, a, s });

        const g = nodeRefs.current[i];
        if (g) {
          g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
          g.setAttribute("opacity", a.toFixed(3));
        }
        // nothing to size while it is invisible, and the geometry is degenerate
        // out there anyway
        if (a <= 0.002) continue;

        coreRefs.current[i]?.setAttribute("r", (2.4 + s * 2.6).toFixed(2));
        haloRefs.current[i]?.setAttribute("r", (14 + s * 22).toFixed(1));
        ringRefs.current[i]?.setAttribute("r", (9 + s * 11).toFixed(1));

        const label = labelRefs.current[i];
        if (label) {
          // labels only once the waypoint is close enough to read, which also
          // keeps the far cluster near the vanishing point from turning to soup
          label.setAttribute("opacity", clamp01((s - 0.9) / 0.5).toFixed(3));
          label.setAttribute("y", (24 + s * 15).toFixed(1));
          label.setAttribute("font-size", Math.min(9 + s * 3.4, 17).toFixed(1));
        }
      }

      // links thread forward, each one pointing at the waypoint ahead
      for (let i = 0; i < RELS.length; i++) {
        const p = edgeRefs.current[i];
        if (!p) continue;
        const a = pos[i];
        const b = pos[i + 1];
        const vis = Math.min(a.a, b.a);
        p.setAttribute("opacity", (vis * 0.85).toFixed(3));
        if (vis <= 0.01) continue;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // bow the link away from the vanishing point so it reads as a path
        const cx = mx + (mx - vx) * 0.16;
        const cy = my + (my - vy) * 0.16;
        p.setAttribute(
          "d",
          `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`,
        );
      }

      // HUD tracks whichever waypoint you are nearest
      let active = -1;
      let best = Infinity;
      for (let i = 0; i < KINDS.length; i++) {
        const d = Math.abs(FIRST_Z + i * GAP - travel);
        if (d < best) {
          best = d;
          active = i;
        }
      }
      if (hudRef.current) {
        hudRef.current.style.opacity = (best < 700 ? runFade : 0).toFixed(3);
      }
      if (active !== lastActive && active >= 0) {
        lastActive = active;
        const spec = KINDS[active];
        if (hudIdxRef.current)
          hudIdxRef.current.textContent = `${String(active + 1).padStart(2, "0")} / ${String(KINDS.length).padStart(2, "0")}`;
        if (hudKindRef.current) hudKindRef.current.textContent = spec.kind;
        if (hudUseRef.current) hudUseRef.current.textContent = spec.use;
        tickRefs.current.forEach((t, i) =>
          t?.setAttribute("data-on", String(i <= active)),
        );
      }
    };

    if (reduce) {
      // no run: park the constellation at a readable depth and leave it
      draw(FIRST_Z + 2 * GAP);
      return () => {
        window.removeEventListener("resize", onResize);
        release();
      };
    }

    const frame = () => {
      const travel = getScrollTravel();
      if (travel !== lastTravel) {
        lastTravel = travel;
        draw(travel);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      release();
    };
  }, []);

  return (
    <div className="wprun" ref={rootRef} aria-hidden="true">
      <svg className="wprun__svg" width="100%" height="100%">
        <defs>
          <radialGradient id="wpHalo">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g fill="none">
          {RELS.map((rel, i) => (
            <path
              key={i}
              ref={(el) => {
                edgeRefs.current[i] = el;
              }}
              stroke={rel === "contradicts" ? "var(--bad)" : "var(--cool)"}
              strokeWidth={1.3}
              strokeDasharray={rel === "contradicts" ? "5 5" : undefined}
              opacity={0}
            />
          ))}
        </g>

        {KINDS.map((k, i) => (
          <g
            key={k.kind}
            ref={(el) => {
              nodeRefs.current[i] = el;
            }}
            opacity={0}
          >
            <circle
              ref={(el) => {
                haloRefs.current[i] = el;
              }}
              r={20}
              fill="url(#wpHalo)"
            />
            <circle
              ref={(el) => {
                ringRefs.current[i] = el;
              }}
              r={14}
              fill="none"
              stroke="var(--accent)"
              strokeOpacity={0.34}
              strokeWidth={1}
            />
            <circle
              ref={(el) => {
                coreRefs.current[i] = el;
              }}
              r={4}
              fill="var(--accent)"
            />
            <text
              className="wprun__label"
              ref={(el) => {
                labelRefs.current[i] = el;
              }}
              textAnchor="middle"
              y={30}
              opacity={0}
            >
              {k.kind}
            </text>
          </g>
        ))}
      </svg>

      <div className="wphud" ref={hudRef}>
        <div className="wphud__top">
          <span className="wphud__idx" ref={hudIdxRef}>
            01 / 07
          </span>
          <span className="wphud__kind" ref={hudKindRef}>
            decision
          </span>
        </div>
        <p className="wphud__use" ref={hudUseRef}>
          A choice that constrains future work
        </p>
        <div className="wphud__ticks">
          {KINDS.map((k, i) => (
            <span
              key={k.kind}
              ref={(el) => {
                tickRefs.current[i] = el;
              }}
              data-on={i === 0}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
