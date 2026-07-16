import type { Handoff, Link, RecallResult, Slip } from "./types.ts";

export interface RecallLinkProvider {
  linksFrom(id: string): Link[];
  linksTo(id: string): Link[];
}

export function formatRecall(
  r: RecallResult,
  links?: RecallLinkProvider,
): string {
  const parts: string[] = [];
  if (r.traceId) parts.push(`# recall receipt ${r.traceId}`);
  if (r.activeHandoff) {
    parts.push(
      `# ${handoffHeading(r.activeHandoff)}\n${r.activeHandoff.summary}` +
        (r.activeHandoff.next.length > 0
          ? `\n\nnext:\n${r.activeHandoff.next.map((n) => `- ${n}`).join("\n")}`
          : ""),
    );
  }

  if ((r.readFirst ?? []).length > 0) {
    parts.push(`# read first\n${(r.readFirst ?? []).map((h) => {
      const why = h.nextAgent.reasons.length > 0 ? ` [${h.nextAgent.reasons.join(", ")}]` : "";
      return `- ${h.slip.id}${why}\n  ${h.slip.text.replace(/\n/g, "\n  ")}`;
    }).join("\n")}`);
  }

  if (r.hits.length === 0) {
    parts.push(
      `# recall("${r.query}") — no hits\nTry a broader or differently-phrased query (one or two words, synonyms) before falling back to general knowledge. If still nothing, the user has not recorded this yet — it is safe to ask them or proceed without memory.`,
    );
  } else {
    const hasHigh = r.hits.some((h) => h.trust === "high");
    const heading = hasHigh
      ? `# recall("${r.query}") — repeatedly useful memory found; still verify against live state`
      : `# recall("${r.query}")`;
    parts.push(heading);
    for (const h of r.hits) {
      const tags =
        h.slip.tags.length > 0 ? ` [${h.slip.tags.join(", ")}]` : "";
      const prefix =
        h.trust === "high"
          ? "**[high — repeatedly useful]**"
          : h.trust === "medium"
            ? "**[medium — kept, not yet confirmed]**"
            : "**[low — draft or disputed; verify]**";
      const provenance = formatProvenance(h.slip);
      const safety = formatLinkSafety(h.slip.id, links);
      const next = h.nextAgent && h.nextAgent.read !== "skip" ? ` next-agent:${h.nextAgent.read}/${h.nextAgent.reasons.join("+") || "reason"}` : "";
      parts.push(
        `- ${prefix} ${h.slip.id} · ${h.slip.kind}${tags}${next}\n  ${h.slip.text.replace(/\n/g, "\n  ")}\n  ${provenance}${safety}`,
      );
    }
  }
  return parts.join("\n\n");
}

/**
 * Format the "recents" view returned when recall is called with an
 * empty / whitespace query. No FTS, no scores — just the active handoff
 * (if any) plus the N most recent kept slips, in reverse-chron order.
 *
 * This is the "what was I doing" answer for fresh sessions where the
 * agent doesn't have a query yet.
 */
export function formatRecents(
  activeHandoff: Handoff | null,
  recent: Slip[],
  traceId?: string | null,
): string {
  const parts: string[] = [];
  if (traceId) parts.push(`# recall receipt ${traceId}`);
  if (activeHandoff) {
    parts.push(
      `# ${handoffHeading(activeHandoff)}\n${activeHandoff.summary}` +
        (activeHandoff.next.length > 0
          ? `\n\nnext:\n${activeHandoff.next.map((n) => `- ${n}`).join("\n")}`
          : ""),
    );
  }
  if (recent.length === 0) {
    parts.push(
      `# recall(recents) — nothing kept yet\nNo prior memory in this DB. Ask the user, or proceed.`,
    );
  } else {
    parts.push(`# recall(recents) — ${recent.length} most recent kept slip(s)`);
    for (const s of recent) {
      const tags = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
      parts.push(`- ${s.id} · ${s.kind}${tags}\n  ${s.text.replace(/\n/g, "\n  ")}\n  ${formatProvenance(s)}`);
    }
  }
  return parts.join("\n\n");
}

function handoffHeading(handoff: Handoff): string {
  const ageMs = Math.max(0, Date.now() - handoff.createdAt);
  const age = formatAge(handoff.createdAt);
  return ageMs >= 3 * 24 * 60 * 60 * 1000
    ? `stale handoff · ${age} old · verify before acting`
    : `active handoff · ${age} old`;
}

function formatAge(createdAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatProvenance(slip: Slip): string {
  const created = new Date(slip.createdAt).toISOString();
  return `source: ${slip.authoredBy} · scope: ${slip.scope} · session: ${slip.sessionId} · created: ${created} · used/wrong: ${slip.usedCount}/${slip.wrongCount}`;
}

function formatLinkSafety(id: string, links?: RecallLinkProvider): string {
  if (!links) return "";
  const linkNotes: string[] = [];
  for (const link of links.linksFrom(id)) {
    if (link.kind === "supersedes") linkNotes.push(`supersedes ${link.toId}`);
    if (link.kind === "contradicts") linkNotes.push(`contradicts ${link.toId}`);
  }
  for (const link of links.linksTo(id)) {
    if (link.kind === "supersedes") linkNotes.push(`superseded by ${link.fromId}`);
    if (link.kind === "contradicts") linkNotes.push(`contradicted by ${link.fromId}`);
  }
  return linkNotes.length > 0 ? `\n  links: ${linkNotes.join("; ")}` : "";
}
