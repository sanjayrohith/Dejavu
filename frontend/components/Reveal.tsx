"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One-shot scroll reveal. Deliberately not scroll-jacked (DESIGN.md §4).
 *
 * `stagger` moves the animation onto the direct children instead of the
 * wrapper, so list and grid items assemble one after another rather than the
 * whole block appearing at once. Child delays come from :nth-child in CSS.
 */
export default function Reveal({
  children,
  delay = 0,
  as: Tag = "div",
  className = "",
  stagger = false,
}: {
  children: React.ReactNode;
  delay?: number;
  as?: React.ElementType;
  className?: string;
  stagger?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -60px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={`rv ${stagger ? "rv--stagger" : ""} ${className}`}
      data-shown={shown}
      style={{ "--rd": `${delay}ms` } as React.CSSProperties}
    >
      {children}
    </Tag>
  );
}
