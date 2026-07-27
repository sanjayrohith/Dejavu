"use client";

import { useEffect, useRef, useState } from "react";
import { LAPS, TRUST } from "@/lib/content";
import Terminal from "./Terminal";
import Reveal from "./Reveal";

/**
 * The four-lap core. A sticky HUD advances as each lap enters view — contained
 * motion within this section only, not a full-page scroll-jack (DESIGN.md §3.3).
 */
export default function Laps() {
  const [current, setCurrent] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        const i = refs.current.indexOf(visible.target as HTMLElement);
        if (i >= 0) setCurrent(i);
      },
      { threshold: [0.25, 0.5, 0.75], rootMargin: "-114px 0px -35% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <section className="laps" id="how">
      <div className="hud">
        <div className="wrap hud__in">
          <span className="hud__stage">
            Lap {String(current + 1).padStart(2, "0")} / 04
          </span>
          <span className="hud__track">
            {LAPS.map((l, i) => (
              <span key={l.id} className="hud__seg" data-on={i <= current} />
            ))}
          </span>
          <span className="hud__label">{LAPS[current].stage}</span>
        </div>
      </div>

      {LAPS.map((lap, i) => (
        <article
          key={lap.id}
          id={lap.id}
          className="lap"
          ref={(el) => {
            refs.current[i] = el;
          }}
        >
          <div className="wrap lap__grid">
            <Reveal>
              <div className="lap__n">
                {lap.n} — {lap.stage}
              </div>
              <h2>{lap.title}</h2>
              {lap.body.map((p, j) => (
                <p className="lap__body" key={j}>
                  {p}
                </p>
              ))}

              {/* trust ≠ relevance belongs to the recall lap specifically */}
              {lap.id === "recall" && (
                <div className="trust">
                  {TRUST.map((t) => (
                    <div className="trust__row" key={t.level} data-t={t.level}>
                      <span className="trust__tag">{t.level}</span>
                      <span className="trust__desc">{t.desc}</span>
                    </div>
                  ))}
                </div>
              )}
            </Reveal>

            <Reveal delay={110}>
              <Terminal title={lap.term.title} html={lap.term.lines} />
            </Reveal>
          </div>
        </article>
      ))}
    </section>
  );
}
