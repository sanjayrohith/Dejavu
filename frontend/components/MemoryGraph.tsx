"use client";

import { useEffect, useRef, useState } from "react";
import { KINDS, type SlipKind } from "@/lib/content";

/**
 * Full-bleed hero memory graph.
 *
 * The viewBox is measured from the container and mapped 1:1 to CSS pixels, so
 * the graph fills whatever space it is given with no cropping and no distortion
 * (a fixed viewBox with `slice` would clip nodes at some aspect ratios).
 *
 * Node positions are stored normalised (0..1) in two layouts, and scroll
 * progress through the hero lerps between them: the scattered constellation
 * consolidates toward the hub as you scroll, which is what recall does to
 * memory. Everything below is driven from one rAF loop.
 */

const RECALL_CYCLE = 7.5;
const INTRO_MS = 1700;

type NodeDef = {
  kind: SlipKind;
  hub?: boolean;
  a: [number, number]; // layout A — at rest, spread across the viewport
  b: [number, number]; // layout B — consolidated, after scrolling the hero
  amp: number;
  spd: number;
  ph: number;
  depth: number;
};

/* Layout A keeps the constellation in the right ~60% so it never sits under the
   headline; it still spans the hero top-to-bottom. Layout B pulls everything in
   toward the hub as the hero scrolls away. */
const NODES: NodeDef[] = [
  { kind: "decision", hub: true, a: [0.71, 0.22], b: [0.71, 0.20], amp: 4, spd: 0.5, ph: 0.0, depth: 4 },
  { kind: "procedure", a: [0.53, 0.32], b: [0.63, 0.29], amp: 8, spd: 0.42, ph: 1.1, depth: 10 },
  { kind: "pitfall", a: [0.925, 0.30], b: [0.80, 0.28], amp: 7, spd: 0.38, ph: 2.3, depth: 9 },
  { kind: "fact", a: [0.68, 0.53], b: [0.70, 0.39], amp: 6, spd: 0.55, ph: 0.7, depth: 7 },
  { kind: "preference", a: [0.535, 0.73], b: [0.62, 0.42], amp: 9, spd: 0.33, ph: 3.4, depth: 12 },
  { kind: "wip", a: [0.91, 0.64], b: [0.79, 0.41], amp: 8, spd: 0.46, ph: 4.2, depth: 11 },
  { kind: "note", a: [0.70, 0.86], b: [0.69, 0.49], amp: 8, spd: 0.5, ph: 5.0, depth: 10 },
];

const idx = (k: SlipKind) => NODES.findIndex((n) => n.kind === k);

/* Edges use the real link vocabulary: supersedes | contradicts | related. */
const EDGES: { a: SlipKind; b: SlipKind; rel: string; bend: number }[] = [
  { a: "decision", b: "procedure", rel: "related", bend: 0.05 },
  { a: "decision", b: "pitfall", rel: "related", bend: -0.042 },
  { a: "decision", b: "fact", rel: "supersedes", bend: 0.058 },
  { a: "procedure", b: "fact", rel: "related", bend: -0.035 },
  { a: "fact", b: "wip", rel: "related", bend: 0.042 },
  { a: "pitfall", b: "wip", rel: "contradicts", bend: 0.05 },
  { a: "procedure", b: "preference", rel: "related", bend: 0.038 },
  { a: "fact", b: "note", rel: "related", bend: -0.032 },
  { a: "preference", b: "note", rel: "related", bend: -0.038 },
];

type P = { x: number; y: number };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** easeInOutCubic — keeps the scroll morph from starting or stopping abruptly */
const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function edgeGeom(a: P, b: P, bend: number, scale: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = bend * scale;
  const cx = (a.x + b.x) / 2 + (-dy / len) * off;
  const cy = (a.y + b.y) / 2 + (dx / len) * off;
  return { d: `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`, len: len * 1.04 };
}

export default function MemoryGraph() {
  const [active, setActive] = useState<number | null>(null);
  const [dims, setDims] = useState({ w: 1200, h: 800 });
  const spec = active !== null ? KINDS.find((k) => k.kind === NODES[active].kind) : null;

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const groupRefs = useRef<(SVGGElement | null)[]>([]);
  const coreRefs = useRef<(SVGCircleElement | null)[]>([]);
  const flashRefs = useRef<(SVGCircleElement | null)[]>([]);
  const edgeRefs = useRef<(SVGPathElement | null)[]>([]);
  const pulseRefs = useRef<(SVGPathElement | null)[]>([]);
  const waveRef = useRef<SVGCircleElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const target = useRef<P>({ x: 0, y: 0 });
  const par = useRef<P>({ x: 0, y: 0 });
  const scrollP = useRef(0);
  const activeRef = useRef<number | null>(null);
  activeRef.current = active;

  /* measure the container so the viewBox matches it exactly */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0 && height > 0) setDims({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* scroll progress through the hero drives the layout morph */
  useEffect(() => {
    const onScroll = () => {
      const h = wrapRef.current?.offsetHeight || window.innerHeight;
      scrollP.current = clamp01(window.scrollY / h);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const start = performance.now();

    const frame = (now: number) => {
      const t = (now - start) / 1000;
      const { w, h } = dims;
      const scale = Math.min(w, h);
      const intro = reduce ? 1 : easeOut(clamp01((now - start) / INTRO_MS));
      const morph = easeInOut(scrollP.current);

      par.current.x += (target.current.x - par.current.x) * 0.055;
      par.current.y += (target.current.y - par.current.y) * 0.055;

      // node positions: layout morph + idle drift + pointer parallax
      const pos: P[] = NODES.map((n, i) => {
        const nx = lerp(n.a[0], n.b[0], morph);
        const ny = lerp(n.a[1], n.b[1], morph);
        let x = nx * w;
        let y = ny * h;
        if (!reduce) {
          x += Math.sin(t * n.spd + n.ph) * n.amp + par.current.x * n.depth;
          y += Math.cos(t * n.spd * 0.85 + n.ph) * n.amp + par.current.y * n.depth;
        }
        groupRefs.current[i]?.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        return { x, y };
      });

      // recall sweep from the hub
      let waveR = 0;
      let waveAlpha = 0;
      if (!reduce) {
        const phase = (t % RECALL_CYCLE) / RECALL_CYCLE;
        waveR = phase * scale * 1.15;
        waveAlpha = phase < 0.7 ? (1 - phase / 0.7) * 0.3 : 0;
        waveRef.current?.setAttribute("r", waveR.toFixed(1));
        waveRef.current?.setAttribute("opacity", waveAlpha.toFixed(3));
        waveRef.current?.setAttribute("cx", pos[0].x.toFixed(1));
        waveRef.current?.setAttribute("cy", pos[0].y.toFixed(1));
      }

      pos.forEach((p, i) => {
        const base = NODES[i].hub ? 13 : 9;
        const dist = Math.hypot(p.x - pos[0].x, p.y - pos[0].y);
        const hit = reduce
          ? 0
          : Math.max(0, 1 - Math.abs(dist - waveR) / 80) * (waveAlpha > 0 ? 1 : 0);
        coreRefs.current[i]?.setAttribute("r", (base + hit * 4).toFixed(2));
        flashRefs.current[i]?.setAttribute("opacity", (hit * 0.55).toFixed(3));
        flashRefs.current[i]?.setAttribute("r", (22 + hit * 20).toFixed(1));
      });

      // edges follow, with intro draw-in and travelling pulses done in JS so
      // they stay in sync as path lengths change with the morph
      EDGES.forEach((e, i) => {
        const { d, len } = edgeGeom(pos[idx(e.a)], pos[idx(e.b)], e.bend, scale);
        const base = edgeRefs.current[i];
        if (base) {
          base.setAttribute("d", d);
          if (e.rel !== "contradicts") {
            base.setAttribute("stroke-dasharray", len.toFixed(1));
            base.setAttribute(
              "stroke-dashoffset",
              (len * (1 - clamp01(intro * 1.6 - i * 0.06))).toFixed(1),
            );
          }
        }
        const pulse = pulseRefs.current[i];
        if (pulse) {
          pulse.setAttribute("d", d);
          pulse.setAttribute("stroke-dasharray", `5 ${len.toFixed(1)}`);
          const travel = ((t * 0.19 + i * 0.13) % 1) * (len + 5);
          pulse.setAttribute("stroke-dashoffset", (len - travel).toFixed(1));
          pulse.setAttribute("opacity", (intro * (1 - morph * 0.7)).toFixed(2));
        }
      });

      // keep the hover card glued to its (moving) node
      const ai = activeRef.current;
      if (ai !== null && cardRef.current) {
        cardRef.current.style.left = `${pos[ai].x}px`;
        cardRef.current.style.top = `${pos[ai].y}px`;
      }

      // the whole graph recedes as the hero scrolls away
      svgRef.current?.style.setProperty("opacity", String(1 - morph * 0.55));

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [dims]);

  function onMove(e: React.PointerEvent) {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    target.current = {
      x: ((e.clientX - r.left) / r.width - 0.5) * 2,
      y: ((e.clientY - r.top) / r.height - 0.5) * 2,
    };
  }

  const { w, h } = dims;

  return (
    <div
      className="graph"
      ref={wrapRef}
      onPointerMove={onMove}
      onPointerLeave={() => (target.current = { x: 0, y: 0 })}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${h}`}
        width={w}
        height={h}
        role="img"
        aria-label="Dejavu memory graph: typed slips connected by supersedes, contradicts and related links"
      >
        <defs>
          <radialGradient id="hubGlow">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.26" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="haloGrad">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="flashGrad">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.9" />
            <stop offset="70%" stopColor="var(--accent)" stopOpacity="0.15" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* the recall sweep */}
        <circle ref={waveRef} r={0} fill="none" stroke="var(--accent)" strokeWidth={1.2} opacity={0} />

        <g fill="none">
          {EDGES.map((e, i) => {
            const lit =
              active !== null && (NODES[active].kind === e.a || NODES[active].kind === e.b);
            return (
              <g key={i}>
                <path
                  ref={(el) => {
                    edgeRefs.current[i] = el;
                  }}
                  stroke={e.rel === "contradicts" ? "var(--bad)" : "var(--cool)"}
                  strokeWidth={lit ? 2 : 1.3}
                  strokeOpacity={lit ? 0.9 : e.rel === "related" ? 0.42 : 0.6}
                  strokeDasharray={e.rel === "contradicts" ? "5 4" : undefined}
                  style={{ transition: "stroke-opacity .3s, stroke-width .3s" }}
                />
                {e.rel !== "contradicts" && (
                  <path
                    ref={(el) => {
                      pulseRefs.current[i] = el;
                    }}
                    stroke="var(--accent)"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    opacity={0}
                  />
                )}
              </g>
            );
          })}
        </g>

        {NODES.map((n, i) => (
          <g
            key={n.kind}
            ref={(el) => {
              groupRefs.current[i] = el;
            }}
          >
            {n.hub && <circle className="ghub-glow" r={230} fill="url(#hubGlow)" />}
            <g
              className="gnode"
              data-active={active === i}
              style={{ "--d": `${0.35 + i * 0.1}s` } as React.CSSProperties}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((p) => (p === i ? null : p))}
              onClick={() => setActive((p) => (p === i ? null : i))}
              tabIndex={0}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              <circle
                ref={(el) => {
                  flashRefs.current[i] = el;
                }}
                r={22}
                fill="url(#flashGrad)"
                opacity={0}
              />
              <circle className="gnode__halo" r={54} fill="url(#haloGrad)" />
              <circle
                r={n.hub ? 32 : 25}
                fill="transparent"
                stroke="var(--accent)"
                strokeOpacity={n.hub ? 0.42 : 0.24}
                strokeWidth={1}
              />
              {n.hub && (
                <circle
                  className="ghub-scan"
                  r={41}
                  fill="none"
                  stroke="var(--accent)"
                  strokeOpacity={0.4}
                  strokeWidth={1}
                  strokeDasharray="2 8"
                />
              )}
              <circle
                ref={(el) => {
                  coreRefs.current[i] = el;
                }}
                className="gnode__core"
                r={n.hub ? 13 : 9}
                fill={n.hub ? "var(--accent)" : "#ced2da"}
              />
              <text className="gnode__label" y={n.hub ? 58 : 50} textAnchor="middle">
                {n.kind}
              </text>
            </g>
          </g>
        ))}
      </svg>

      {spec && active !== null && (
        <div className="gcard" ref={cardRef}>
          <div className="gcard__kind">{spec.kind}</div>
          <div className="gcard__desc">{spec.use}</div>
          <div className="gcard__eg">{spec.example}</div>
        </div>
      )}
    </div>
  );
}
