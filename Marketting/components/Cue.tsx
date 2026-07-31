import type { CSSProperties } from "react";

/**
 * A zero-height marker that pins one film frame to one point in the page flow.
 * <Film> finds these by attribute, so pacing is edited here in the document
 * rather than in the scrubber.
 */
export default function Cue({ frame, style }: { frame: number; style?: CSSProperties }) {
  return <span className="cue" data-film-cue={frame} style={style} aria-hidden="true" />;
}
