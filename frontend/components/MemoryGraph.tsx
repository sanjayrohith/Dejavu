"use client";

import { useState } from "react";
import { KINDS, type SlipKind } from "@/lib/content";

/* Curated layout — deliberately hand-placed rather than force-directed so the
   composition is deterministic and balanced at every viewport (DESIGN.md §5). */
const VB = { w: 760, h: 520 };

type Node = { kind: SlipKind; x: number; y: number; hub?: boolean };

const NODES: Node[] = [
  { kind: "decision", x: 375, y: 115, hub: true },
  { kind: "procedure", x: 160, y: 225 },
  { kind: "pitfall", x: 595, y: 190 },
  { kind: "fact", x: 400, y: 295 },
  { kind: "preference", x: 135, y: 410 },
  { kind: "wip", x: 615, y: 385 },
  { kind: "note", x: 330, y: 465 },
];

const idx = (k: SlipKind) => NODES.findIndex((n) => n.kind === k);

/* Edges use the real link vocabulary: supersedes | contradicts | related. */
const EDGES: { a: SlipKind; b: SlipKind; rel: string; bend: number }[] = [
  { a: "decision", b: "procedure", rel: "related", bend: 26 },
  { a: "decision", b: "pitfall", rel: "related", bend: -22 },
  { a: "decision", b: "fact", rel: "supersedes", bend: 30 },
  { a: "procedure", b: "fact", rel: "related", bend: -18 },
  { a: "fact", b: "wip", rel: "related", bend: 22 },
  { a: "pitfall", b: "wip", rel: "contradicts", bend: 26 },
  { a: "procedure", b: "preference", rel: "related", bend: 20 },
  { a: "fact", b: "note", rel: "related", bend: -16 },
  { a: "preference", b: "note", rel: "related", bend: -20 },
];

/** Quadratic curve with a perpendicular bend, plus a close-enough length
    for the dash animations (shallow curves, so chord * 1.04 covers it). */
function edgeGeom(a: Node, b: Node, bend: number) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const cx = mx + (-dy / len) * bend;
  const cy = my + (dx / len) * bend;
  return { d: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`, len: len * 1.04 };
}

export default function MemoryGraph() {
  const [active, setActive] = useState<number | null>(null);
  const spec = active !== null ? KINDS.find((k) => k.kind === NODES[active].kind) : null;

  return (
    <div className="graph">
      <svg viewBox={`0 0 ${VB.w} ${VB.h}`} role="img" aria-label="Dejavu memory graph: typed slips connected by supersedes, contradicts and related links">
        <defs>
          <radialGradient id="hubGlow">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="haloGrad">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* ambient glow behind the hub */}
        <circle cx={375} cy={115} r={165} fill="url(#hubGlow)" />

        {/* edges: base trace + travelling pulse */}
        <g fill="none">
          {EDGES.map((e, i) => {
            const A = NODES[idx(e.a)];
            const B = NODES[idx(e.b)];
            const { d, len } = edgeGeom(A, B, e.bend);
            const lit =
              active !== null &&
              (NODES[active].kind === e.a || NODES[active].kind === e.b);
            return (
              <g key={i}>
                <path
                  className="gedge"
                  d={d}
                  stroke={e.rel === "contradicts" ? "var(--bad)" : "var(--cool)"}
                  strokeWidth={lit ? 2 : 1.3}
                  strokeOpacity={lit ? 0.9 : e.rel === "related" ? 0.42 : 0.6}
                  strokeDasharray={e.rel === "contradicts" ? "5 4" : undefined}
                  style={
                    {
                      "--len": e.rel === "contradicts" ? undefined : len,
                      "--d": `${0.15 + i * 0.09}s`,
                      transition: "stroke-opacity .3s, stroke-width .3s",
                    } as React.CSSProperties
                  }
                />
                {e.rel !== "contradicts" && (
                  <path
                    className="gpulse"
                    d={d}
                    stroke="var(--accent)"
                    strokeWidth={2}
                    strokeLinecap="round"
                    style={
                      { "--len": len, "--d": `${1.1 + i * 0.42}s` } as React.CSSProperties
                    }
                  />
                )}
              </g>
            );
          })}
        </g>

        {/* nodes */}
        {NODES.map((n, i) => (
          <g
            key={n.kind}
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
            <circle className="gnode__halo" cx={n.x} cy={n.y} r={44} fill="url(#haloGrad)" />
            <circle
              cx={n.x}
              cy={n.y}
              r={n.hub ? 27 : 21}
              fill="transparent"
              stroke="var(--accent)"
              strokeOpacity={n.hub ? 0.42 : 0.24}
              strokeWidth={1}
            />
            <circle
              className="gnode__core"
              cx={n.x}
              cy={n.y}
              r={n.hub ? 11 : 8}
              fill={n.hub ? "var(--accent)" : "#ced2da"}
            />
            <text className="gnode__label" x={n.x} y={n.y + (n.hub ? 51 : 45)} textAnchor="middle">
              {n.kind}
            </text>
          </g>
        ))}
      </svg>

      {spec && active !== null && (
        <div
          className="gcard"
          style={{
            left: `${(NODES[active].x / VB.w) * 100}%`,
            top: `${(NODES[active].y / VB.h) * 100}%`,
          }}
        >
          <div className="gcard__kind">{spec.kind}</div>
          <div className="gcard__desc">{spec.use}</div>
          <div className="gcard__eg">{spec.example}</div>
        </div>
      )}

      <div className="graph__hint">hover a node — 7 slip kinds, 3 link types</div>
    </div>
  );
}
