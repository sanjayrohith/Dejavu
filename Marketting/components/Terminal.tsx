"use client";

import { useState } from "react";

/**
 * Cockpit-style terminal panel.
 * `html` is authored in lib/content.ts (static, first-party) — never user input.
 * `copy` is the plain text placed on the clipboard.
 */
export default function Terminal({
  title,
  html,
  copy,
}: {
  title: string;
  html: string;
  copy?: string;
}) {
  const [done, setDone] = useState(false);

  async function onCopy() {
    const text = copy ?? html.replace(/<[^>]+>/g, "");
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      /* clipboard blocked (insecure context) — leave the label unchanged */
    }
  }

  return (
    <div className="term">
      <div className="term__bar">
        <div className="term__dots">
          <i />
          <i />
          <i />
        </div>
        <span className="term__title">{title}</span>
        <button className="term__copy" onClick={onCopy} type="button">
          {done ? "copied" : "copy"}
        </button>
      </div>
      <pre className="term__body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
