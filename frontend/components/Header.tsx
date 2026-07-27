"use client";

import { useEffect, useState } from "react";
import { REPO } from "@/lib/content";

export default function Header() {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
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
          <a className="hide-sm" href="#how">
            How it works
          </a>
          <a className="hide-sm" href="#boundaries">
            Boundaries
          </a>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </nav>
      </div>
    </header>
  );
}
