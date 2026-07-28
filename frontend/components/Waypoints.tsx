"use client";

import { useEffect, useRef } from "react";
import { KINDS } from "@/lib/content";
import { getScrollTravel, retainScrollTravel } from "@/lib/scrollTravel";

/**
 * The recall run: the seven slip kinds laid out as waypoints down the road, so
 * scrolling the hero flies you past them one after another.
 *
 * Structure comes from three things working together:
 *  - a perspective grid — rays out of the road's vanishing point plus depth
 *    rungs that slide past on the same rhythm as the waypoints;
 *  - two rails — waypoints alternate between an upper-left and a lower-right
 *    rail, so the typed links hop from one path to the other instead of
 *    wandering through a scatter;
 *  - travel-driven accents — edge pulses flow along the links, a scan ring
 *    turns with travel on the nearest waypoint, and passing one fires a ping.
 *
 * Everything positional is a pure function of the shared scroll travel, so the
 * run freezes with the rest of the backdrop. The only time-based motion is two
 * short, event-triggered accents: the intro draw-in once on load, and the
 * ~0.7s ping when a waypoint is actually passed. Both settle and stop.
 *
 * Attributes are mutated directly in the rAF rather than driven through React
 * state — same approach as the old MemoryGraph — and nothing is written at all
 * when there is nothing to animate.
 */

/** where the road converges, as a fraction of the viewport */
const VANISH: [number, number] = [0.6, 0.4];
/** scroll px that reads as "one unit of depth" */
const DEPTH = 420;
/** first waypoint's distance, and the gap between them, in scroll px.
 *  FIRST_Z keeps waypoint 01 fully in frame at load — any closer and the
 *  viewport-scaled projection throws it off the top of a tall screen. The gap
 *  still passes the whole run within about one viewport of scrolling. */
const FIRST_Z = 230;
const GAP = 133;
/** how far ahead a waypoint is still drawn / how far past before it is dropped */
const FAR = 1400;
const NEAR = -120;
/** pass-ping and intro durations */
const PING_MS = 680;
const INTRO_MS = 1500;

/* ---- perspective floor grid ---- */
/** lateral ray positions, as fractions of the floor width at unit scale */
const RAYS = [-1.25, -0.8, -0.42, -0.14, 0.14, 0.42, 0.8, 1.25];
/** depth rungs cycle on the waypoint gap, so the grid ticks off the same beat */
const RUNGS = 9;
const RUNG_SPAN = RUNGS * GAP;

/* Two rails, biased right of centre because the headline owns the lower left:
   even waypoints ride the upper rail, odd ones the lower, so the run reads as
   hopping from one path to the other. Small per-node offsets keep same-rail
   labels from stacking along the ray. */
/* Same-rail members are separated by *angle*, not just radius: two nodes on
   one ray sit at s·r each, and those cross radially at some travel no matter
   how the radii are chosen — which is exactly how procedure and fact ended up
   stacked. ~30° between same-rail neighbours keeps them apart at every depth. */
const LANES: [number, number][] = [
  [0.29, -0.72], // decision — upper rail, steep
  [0.88, 0.36], // preference — lower rail, shallow
  [0.49, -0.38], // procedure — upper, shallow
  [0.45, 0.72], // pitfall — lower, steep
  [0.14, -0.9], // fact — upper, near-vertical
  [1.04, 0.15], // wip — lower, near-horizontal
  [0.48, -0.19], // note — upper, ends near the centre
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
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
/** projection scale at depth d. Clamped: once a waypoint is far enough behind
 *  the camera the denominator crosses zero, the projection inverts, and every
 *  derived radius goes negative — which SVG rejects outright. */
const sOf = (d: number) => 1 / Math.max((d / DEPTH) * 0.85 + 0.3, 0.08);

export default function Waypoints() {
  const rootRef = useRef<HTMLDivElement>(null);
  const rayRefs = useRef<(SVGLineElement | null)[]>([]);
  const rungRefs = useRef<(SVGLineElement | null)[]>([]);
  const nodeRefs = useRef<(SVGGElement | null)[]>([]);
  const coreRefs = useRef<(SVGCircleElement | null)[]>([]);
  const haloRefs = useRef<(SVGCircleElement | null)[]>([]);
  const ringRefs = useRef<(SVGCircleElement | null)[]>([]);
  const scanRefs = useRef<(SVGCircleElement | null)[]>([]);
  const pingRefs = useRef<(SVGCircleElement | null)[]>([]);
  const leaderRefs = useRef<(SVGLineElement | null)[]>([]);
  const labelRefs = useRef<(SVGTextElement | null)[]>([]);
  const edgeRefs = useRef<(SVGPathElement | null)[]>([]);
  const pulseRefs = useRef<(SVGPathElement | null)[]>([]);
  const hudRef = useRef<HTMLDivElement>(null);
  const hudBodyRef = useRef<HTMLDivElement>(null);
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
    const introStart = performance.now();
    /** per-waypoint timestamp of the last camera pass */
    const pings = new Array<number>(KINDS.length).fill(-1e9);

    const draw = (travel: number, now: number) => {
      const vx = VANISH[0] * w;
      const vy = VANISH[1] * h;
      /* All lateral geometry scales off the viewport. A fixed pixel spread
         looked right at one window size and cramped at every other — on a
         1920px screen the whole constellation bunched into a corner. */
      const unit = Math.min(w * 0.16, h * 0.36);
      const floorW = unit * 2.35;
      const floorDrop = unit * 1.7;
      const intro = reduce ? 1 : easeOutCubic(clamp01((now - introStart) / INTRO_MS));

      // the whole run fades out once the last waypoint is behind you
      const runFade = clamp01((RUN_END - travel) / 350);
      if (rootRef.current) rootRef.current.style.opacity = runFade.toFixed(3);
      if (runFade <= 0) return;

      /* ---- grid ---- */
      for (let i = 0; i < RAYS.length; i++) {
        const ray = rayRefs.current[i];
        if (!ray) continue;
        // start away from the vanishing point so nodes spawn into clear space
        const s0 = 0.42;
        const s1 = 5.2;
        ray.setAttribute("x1", (vx + RAYS[i] * s0 * floorW).toFixed(1));
        ray.setAttribute("y1", (vy + s0 * floorDrop).toFixed(1));
        ray.setAttribute("x2", (vx + RAYS[i] * s1 * floorW).toFixed(1));
        ray.setAttribute("y2", (vy + s1 * floorDrop).toFixed(1));
        ray.setAttribute("opacity", (intro * 0.9).toFixed(3));
      }
      for (let k = 0; k < RUNGS; k++) {
        const rung = rungRefs.current[k];
        if (!rung) continue;
        // rungs cycle on the waypoint gap, phase-locked to the waypoints
        const dk =
          ((((FIRST_Z + k * GAP - travel) % RUNG_SPAN) + RUNG_SPAN) % RUNG_SPAN);
        const s = sOf(dk);
        const y = vy + s * floorDrop;
        const hw = s * floorW * 1.3;
        const op =
          clamp01((1050 - dk) / 520) * clamp01((dk - 30) / 150) * intro * 0.4;
        rung.setAttribute("x1", (vx - hw).toFixed(1));
        rung.setAttribute("x2", (vx + hw).toFixed(1));
        rung.setAttribute("y1", y.toFixed(1));
        rung.setAttribute("y2", y.toFixed(1));
        rung.setAttribute("opacity", op.toFixed(3));
      }

      /* ---- nearest waypoint, for the HUD and the scan ring ---- */
      let active = -1;
      let best = Infinity;
      for (let i = 0; i < KINDS.length; i++) {
        const d = Math.abs(FIRST_Z + i * GAP - travel);
        if (d < best) {
          best = d;
          active = i;
        }
      }

      /* ---- waypoints ---- */
      const pos: { x: number; y: number; a: number; s: number }[] = [];

      for (let i = 0; i < KINDS.length; i++) {
        const d = FIRST_Z + i * GAP - travel;
        const s = sOf(d);

        // fade in from the distance, out as it passes, staggered in by the intro
        let a = clamp01((FAR - d) / (FAR * 0.45)) * clamp01((d - NEAR) / 220);
        a *= clamp01(intro * 1.7 - i * 0.1);

        const [ox, oy] = LANES[i];
        const x = vx + ox * s * unit;
        const y = vy + oy * s * unit;
        pos.push({ x, y, a, s });

        const g = nodeRefs.current[i];
        if (g) {
          g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
          g.setAttribute("opacity", a.toFixed(3));
        }
        // nothing to size while it is invisible, and the geometry is
        // degenerate out there anyway
        if (a <= 0.002) continue;

        coreRefs.current[i]?.setAttribute("r", (2.4 + s * 2.6).toFixed(2));
        haloRefs.current[i]?.setAttribute("r", (12 + s * 18).toFixed(1));
        ringRefs.current[i]?.setAttribute("r", (9 + s * 11).toFixed(1));

        // dashed scan ring on the nearest waypoint, turned by travel itself
        const scan = scanRefs.current[i];
        if (scan) {
          scan.setAttribute("opacity", i === active ? "0.5" : "0");
          if (i === active) {
            scan.setAttribute("r", (13 + s * 13).toFixed(1));
            scan.setAttribute("transform", `rotate(${((travel * 0.4) % 360).toFixed(1)})`);
          }
        }

        // pass ping: a ring that bursts outward the moment this one is crossed
        const ping = pingRefs.current[i];
        if (ping) {
          const age = now - pings[i];
          if (age >= 0 && age < PING_MS) {
            const t = age / PING_MS;
            ping.setAttribute(
              "r",
              (10 + s * 8 + easeOutCubic(t) * 70 * (0.5 + s * 0.4)).toFixed(1),
            );
            ping.setAttribute("opacity", ((1 - t) * 0.5).toFixed(3));
          } else {
            ping.setAttribute("opacity", "0");
          }
        }

        // label plus its leader tick, only once close enough to read
        const labelOp = clamp01((s - 0.9) / 0.5);
        const label = labelRefs.current[i];
        if (label) {
          label.setAttribute("opacity", labelOp.toFixed(3));
          label.setAttribute("y", (24 + s * 15).toFixed(1));
          label.setAttribute("font-size", Math.min(9 + s * 3.4, 17).toFixed(1));
        }
        const leader = leaderRefs.current[i];
        if (leader) {
          leader.setAttribute("opacity", (labelOp * 0.8).toFixed(3));
          leader.setAttribute("y1", (12 + s * 11).toFixed(1));
          leader.setAttribute("y2", (14 + s * 15 - 1).toFixed(1));
        }
      }

      /* ---- links thread forward, pulses flow along them with travel ---- */
      for (let i = 0; i < RELS.length; i++) {
        const p = edgeRefs.current[i];
        if (!p) continue;
        const a = pos[i];
        const b = pos[i + 1];
        const vis = Math.min(a.a, b.a);
        p.setAttribute("opacity", (vis * 0.7).toFixed(3));
        const pulse = pulseRefs.current[i];
        if (vis <= 0.01) {
          pulse?.setAttribute("opacity", "0");
          continue;
        }
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // bow the link away from the vanishing point so it reads as a path
        const cx = mx + (mx - vx) * 0.16;
        const cy = my + (my - vy) * 0.16;
        const d = `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
        p.setAttribute("d", d);
        if (pulse) {
          const len = Math.hypot(b.x - a.x, b.y - a.y) * 1.06;
          pulse.setAttribute("d", d);
          pulse.setAttribute("stroke-dasharray", `7 ${len.toFixed(1)}`);
          // driven by travel: packets flow along the links only while scrolling
          pulse.setAttribute(
            "stroke-dashoffset",
            (len - ((travel * 0.55 + i * 47) % (len + 7))).toFixed(1),
          );
          pulse.setAttribute("opacity", (vis * 0.8).toFixed(3));
        }
      }

      /* ---- HUD ---- */
      if (hudRef.current) {
        hudRef.current.style.opacity = (best < 700 ? runFade : 0).toFixed(3);
      }
      if (active !== lastActive && active >= 0) {
        const first = lastActive === -1;
        lastActive = active;
        const spec = KINDS[active];
        if (hudIdxRef.current)
          hudIdxRef.current.textContent = `${String(active + 1).padStart(2, "0")} / ${String(KINDS.length).padStart(2, "0")}`;
        if (hudKindRef.current) hudKindRef.current.textContent = spec.kind;
        if (hudUseRef.current) hudUseRef.current.textContent = spec.use;
        tickRefs.current.forEach((t, i) =>
          t?.setAttribute("data-on", String(i <= active)),
        );
        // replay the swap animation on every change after the initial fill
        const body = hudBodyRef.current;
        if (body && !first && !reduce) {
          body.classList.remove("wphud-swap");
          void body.offsetWidth;
          body.classList.add("wphud-swap");
        }
      }
    };

    if (reduce) {
      // no run: park the constellation at a readable depth and leave it
      draw(FIRST_Z + 2 * GAP, performance.now());
      return () => {
        window.removeEventListener("resize", onResize);
        release();
      };
    }

    const frame = () => {
      const now = performance.now();
      const travel = getScrollTravel();
      const introLive = now - introStart < INTRO_MS + 80;
      const pingLive = pings.some((t) => now - t < PING_MS);

      if (travel !== lastTravel || introLive || pingLive) {
        // fire a ping for every waypoint the camera crossed this step
        if (Number.isFinite(lastTravel) && travel !== lastTravel) {
          for (let i = 0; i < KINDS.length; i++) {
            const z = FIRST_Z + i * GAP;
            if ((lastTravel - z) * (travel - z) < 0 || travel === z) pings[i] = now;
          }
        }
        draw(travel, now);
        lastTravel = travel;
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
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          {/* soft vignette: the grid dissolves at its edges instead of drawing
              hard lines across the hero copy */}
          <radialGradient id="wpGridFade" cx="62%" cy="52%" r="62%">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="65%" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="wpGridMask">
            <rect width="100%" height="100%" fill="url(#wpGridFade)" />
          </mask>
        </defs>

        {/* perspective grid: rays out of the vanishing point + depth rungs */}
        <g fill="none" mask="url(#wpGridMask)">
          {RAYS.map((_, i) => (
            <line
              key={`ray-${i}`}
              className="wprun__ray"
              ref={(el) => {
                rayRefs.current[i] = el;
              }}
              opacity={0}
            />
          ))}
          {Array.from({ length: RUNGS }, (_, k) => (
            <line
              key={`rung-${k}`}
              className="wprun__rung"
              ref={(el) => {
                rungRefs.current[k] = el;
              }}
              opacity={0}
            />
          ))}
        </g>

        <g fill="none">
          {RELS.map((rel, i) => (
            <g key={i}>
              <path
                ref={(el) => {
                  edgeRefs.current[i] = el;
                }}
                stroke={rel === "contradicts" ? "var(--bad)" : "var(--cool)"}
                strokeWidth={1.5}
                strokeDasharray={rel === "contradicts" ? "5 5" : undefined}
                opacity={0}
              />
              {rel !== "contradicts" && (
                <path
                  ref={(el) => {
                    pulseRefs.current[i] = el;
                  }}
                  stroke="var(--accent)"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  opacity={0}
                />
              )}
            </g>
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
              strokeOpacity={0.26}
              strokeWidth={1}
            />
            <circle
              ref={(el) => {
                scanRefs.current[i] = el;
              }}
              r={17}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1}
              strokeDasharray="3 9"
              opacity={0}
            />
            <circle
              ref={(el) => {
                pingRefs.current[i] = el;
              }}
              r={12}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.4}
              opacity={0}
            />
            <circle
              ref={(el) => {
                coreRefs.current[i] = el;
              }}
              r={4}
              fill="var(--accent)"
            />
            <line
              className="wprun__leader"
              ref={(el) => {
                leaderRefs.current[i] = el;
              }}
              x1={0}
              x2={0}
              y1={14}
              y2={22}
              opacity={0}
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
        <div className="wphud__body" ref={hudBodyRef}>
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
        </div>
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
