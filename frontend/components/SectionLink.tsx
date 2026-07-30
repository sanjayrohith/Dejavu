"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A node on the page's spine. Replaces a plain <hr>: as it scrolls into view the
 * trace draws outward from the centre and the node lights, so each section
 * boundary reads as another slip linked into the graph.
 */
export default function SectionLink({ label }: { label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="slink" ref={ref} data-shown={shown} aria-hidden="true">
      <span className="slink__trace" />
      <span className="slink__node">
        <span className="slink__ping" />
      </span>
      {label && <span className="slink__label">{label}</span>}
    </div>
  );
}
