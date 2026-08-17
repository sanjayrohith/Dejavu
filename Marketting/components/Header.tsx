"use client";

import { useEffect, useState } from "react";
import { REPO } from "@/lib/content";

export default function Header() {
  const [stuck, setStuck] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setStuck(y > 24);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? Math.min(100, (y / max) * 100) : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <header className="hdr" data-stuck={stuck}>
      <div className="wrap hdr__in">
        <a className="brand" href="#top">
          <span className="brand__dot" />
          dejavu
        </a>
        <nav className="hdr__nav">
          <a className="hide-sm" href="#problem">
            Problem
          </a>
          <a className="hide-sm" href="#how-intro">
            How it works
          </a>
          <a className="hide-sm" href="#boundaries">
            Boundaries
          </a>
          <a className="hide-sm" href="#install">
            Install
          </a>
          <a className="hide-sm" href="#resources">
            Docs &amp; license
          </a>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </nav>
        {/* inside the pill so the bar clips to the glass capsule */}
        <span
          className="hdr__prog"
          style={{ "--p": `${progress}%` } as React.CSSProperties}
        />
      </div>
    </header>
  );
}
