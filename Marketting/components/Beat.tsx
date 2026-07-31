"use client";

import { useEffect, useRef } from "react";
import { clamp, onFrame } from "@/lib/raf";

/**
 * A full-bleed chapter card between content sections. The film runs uncovered
 * behind it; the card rises in, holds while it is centred, and sinks out — the
 * opposite of <Reveal>, which fires once and stays.
 *
 * Writes straight to style on the rAF tick. Routing this through state would
 * re-render a text block sixty times a second for no benefit.
 */
export default function Beat({
  n,
  kicker,
  line,
  sub,
  align = "center",
}: {
  n: string;
  kicker: string;
  line: React.ReactNode;
  sub?: React.ReactNode;
  align?: "center" | "left";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const card = cardRef.current;
    if (!el || !card) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      card.style.opacity = "1";
      return;
    }

    let last = -2;

    return onFrame(({ vh }) => {
      const r = el.getBoundingClientRect();

      /* -1 = below the fold, 0 = dead centre, +1 = gone past the top */
      const centre = r.top + r.height / 2;
      const p = clamp((vh / 2 - centre) / (vh / 2 + r.height / 2), -1, 1);
      if (Math.abs(p - last) < 0.002) return;
      last = p;

      /* flat-topped window: full strength across the middle third of the
         crossing, so the line is readable for a beat instead of only at the
         exact instant it is centred */
      const a = clamp(1 - Math.pow(Math.abs(p) / 0.62, 2.2), 0, 1);

      card.style.opacity = a.toFixed(3);
      card.style.transform = `translate3d(0, ${(p * -46).toFixed(1)}px, 0) scale(${(
        1 + (1 - a) * 0.03
      ).toFixed(4)})`;
      card.style.filter = a > 0.985 ? "none" : `blur(${((1 - a) * 5).toFixed(2)}px)`;
    });
  }, []);

  return (
    <section className="beat" ref={ref} data-align={align}>
      <div className="wrap">
        <div className="beat__card" ref={cardRef}>
          <p className="beat__kicker">
            <span className="beat__n">{n}</span>
            {kicker}
          </p>
          <p className="beat__line">{line}</p>
          {sub && <p className="beat__sub">{sub}</p>}
        </div>
      </div>
    </section>
  );
}
