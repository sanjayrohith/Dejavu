import { driftIsSuspect } from "./anchors.ts";
import type { DoctorReport } from "./doctor.ts";
import type {
  AnchorState,
  AnchorStatus,
  DuplicateSuggestion,
  Handoff,
  Link,
  OrientationPacket,
  RecallHit,
  RecallResult,
  Slip,
  TouchingResult,
} from "./types.ts";

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
    for (const h of r.hits) parts.push(formatHit(h, links));
  }
  return parts.join("\n\n");
}

/**
 * One rendered memory: trust, identity, drift, text, provenance, links.
 *
 * Shared by recall and orientation so the two packets cannot drift apart
 * in how they present the same slip — an agent should not have to learn
 * two layouts depending on which call produced the memory.
 */
function formatHit(hit: RecallHit & { nextAgent?: { read: string; reasons: string[] } }, links?: RecallLinkProvider): string {
  const tags = hit.slip.tags.length > 0 ? ` [${hit.slip.tags.join(", ")}]` : "";
  const prefix =
    hit.trust === "high"
      ? "**[high — repeatedly useful]**"
      : hit.trust === "medium"
        ? "**[medium — kept, not yet confirmed]**"
        : "**[low — draft or disputed; verify]**";
  const provenance = formatProvenance(hit.slip);
  const safety = formatLinkSafety(hit.slip.id, links);
  const next =
    hit.nextAgent && hit.nextAgent.read !== "skip"
      ? ` next-agent:${hit.nextAgent.read}/${hit.nextAgent.reasons.join("+") || "reason"}`
      : "";
  return (
    `- ${prefix} ${hit.slip.id} · ${hit.slip.kind}${tags}${formatDriftMarker(hit.drift)}${next}\n` +
    `  ${hit.slip.text.replace(/\n/g, "\n  ")}\n` +
    `  ${provenance}${safety}${formatAnchors(hit.anchors)}`
  );
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

/**
 * Format the packet a session opens with.
 *
 * Sections in the order a fresh agent needs them, each labelled with what
 * it is and why it is there. The point of the layout is that an agent
 * skimming the top of its context can tell "this is about the file I am
 * already editing" from "this is a standing preference" without reading
 * every entry — a distinction a flat recency list cannot express.
 *
 * Empty sections are omitted rather than printed empty. A packet with
 * nothing in it says so plainly, because "no memory here yet" is a useful
 * answer and an invented one is not.
 */
export function formatOrientation(
  packet: OrientationPacket,
  links?: RecallLinkProvider,
): string {
  const parts: string[] = [];
  if (packet.traceId) parts.push(`# recall receipt ${packet.traceId}`);

  const context = describeWorktree(packet);
  if (context) parts.push(context);

  if (packet.activeHandoff) {
    parts.push(
      `# ${handoffHeading(packet.activeHandoff)}\n${packet.activeHandoff.summary}` +
        (packet.activeHandoff.next.length > 0
          ? `\n\nnext:\n${packet.activeHandoff.next.map((n) => `- ${n}`).join("\n")}`
          : ""),
    );
  }

  if (packet.hazards.length > 0) {
    const suspect = packet.hazards.filter((hit) => driftIsSuspect(hit.drift)).length;
    const files = packet.paths.length;
    parts.push(
      suspect > 0
        ? `# hazards — ${packet.hazards.length} anchored memory about the ${files} file(s) you are changing, ${suspect} about code that has since changed`
        : `# hazards — ${packet.hazards.length} anchored memory about the ${files} file(s) you are changing`,
    );
    for (const hit of packet.hazards) parts.push(formatHit(hit, links));
  }

  if (packet.activeWork.length > 0) {
    parts.push(`# active work — ${packet.activeWork.length} open item(s) in this repository`);
    for (const hit of packet.activeWork) parts.push(formatHit(hit, links));
  }

  if (packet.mustKnow.length > 0) {
    parts.push(
      `# must know — ${packet.mustKnow.length} standing decision(s) and preference(s); these override generic best practice`,
    );
    for (const hit of packet.mustKnow) parts.push(formatHit(hit, links));
  }

  if (packet.other.length > 0) {
    parts.push(`# also known — ${packet.other.length} other kept memory in this repository`);
    for (const hit of packet.other) parts.push(formatHit(hit, links));
  }

  const empty =
    !packet.activeHandoff &&
    packet.hazards.length === 0 &&
    packet.activeWork.length === 0 &&
    packet.mustKnow.length === 0 &&
    packet.other.length === 0;
  if (empty) {
    parts.push(`# nothing kept yet\nNo prior memory in this repository. Ask the user, or proceed.`);
  }

  return parts.join("\n\n");
}

/**
 * The one-line statement of where this session is.
 *
 * Returned empty when the working tree told us nothing — outside a
 * checkout, or with git unavailable — because a header claiming "0
 * changed files" would assert a clean tree we never actually observed.
 */
function describeWorktree(packet: OrientationPacket): string {
  if (packet.worktreeUnavailable) return "";
  const where = packet.branch ? `branch ${packet.branch}` : "detached HEAD";
  if (packet.paths.length === 0) return `# orientation — ${where} · working tree clean`;
  const truncated = packet.pathsTruncated ? ", truncated" : "";
  return (
    `# orientation — ${where} · ${packet.paths.length} changed file(s)${truncated}\n` +
    packet.paths.map((path) => `- ${path}`).join("\n")
  );
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

/**
 * A compact drift marker for the hit's header line.
 *
 * `verified` is deliberately loud rather than silent: "this memory is
 * about code that has not moved" is the strongest freshness signal
 * dejavu can produce, and it is worth the handful of characters.
 */
function formatDriftMarker(drift: AnchorStatus | null | undefined): string {
  switch (drift) {
    case "verified":
      return " · code unchanged";
    case "drifted":
      return " · CODE CHANGED — verify before relying on this";
    case "orphaned":
      return " · CODE DELETED — verify before relying on this";
    case "unknown":
      return " · code not checked";
    default:
      return "";
  }
}

/** One line per anchor, naming the file and what happened to it. */
function formatAnchors(states: AnchorState[] | undefined): string {
  if (!states || states.length === 0) return "";
  const lines = states.map((state) => {
    const where = state.anchor.symbol
      ? `${state.anchor.path}#${state.anchor.symbol}`
      : state.anchor.line
        ? `${state.anchor.path}:${state.anchor.line}`
        : state.anchor.path;
    return `${where} — ${state.status}`;
  });
  return `\n  anchors: ${lines.join("; ")}`;
}

/**
 * Format a reverse lookup for an agent about to touch a set of files.
 *
 * Deliberately leads with the drifted and orphaned memory: the whole
 * point of asking "what do you know about these files" before editing
 * them is to find the notes that are about to be — or already are —
 * wrong.
 */
export function formatTouching(result: TouchingResult, links?: RecallLinkProvider): string {
  const parts: string[] = [];
  if (result.traceId) parts.push(`# recall receipt ${result.traceId}`);

  if (result.paths.length === 0) {
    return [...parts, `# touching — no repository-relative paths given`].join("\n\n");
  }

  const scope = result.paths.join(", ");
  if (result.hits.length === 0) {
    return [
      ...parts,
      `# touching(${scope}) — no memory anchored to these files\nNothing has been written about this code yet. Consider anchoring what you learn: remember(text, { anchors: ["${result.paths[0]}"] }).`,
    ].join("\n\n");
  }

  const suspect = result.hits.filter((hit) => hit.drift === "drifted" || hit.drift === "orphaned");
  parts.push(
    suspect.length > 0
      ? `# touching(${scope}) — ${result.hits.length} anchored memory, ${suspect.length} about code that has since changed`
      : `# touching(${scope}) — ${result.hits.length} anchored memory, all still matching the code`,
  );

  const ordered = [...suspect, ...result.hits.filter((hit) => !suspect.includes(hit))];
  for (const hit of ordered) parts.push(formatAnchoredHit(hit, links));
  return parts.join("\n\n");
}

function formatAnchoredHit(hit: RecallHit, links?: RecallLinkProvider): string {
  const tags = hit.slip.tags.length > 0 ? ` [${hit.slip.tags.join(", ")}]` : "";
  return (
    `- **[${hit.trust}]** ${hit.slip.id} · ${hit.slip.kind}${tags}${formatDriftMarker(hit.drift)}\n` +
    `  ${hit.slip.text.replace(/\n/g, "\n  ")}\n` +
    `  ${formatProvenance(hit.slip)}${formatLinkSafety(hit.slip.id, links)}${formatAnchors(hit.anchors)}`
  );
}

/**
 * The one-line fact behind a write-time duplicate suggestion: which slip,
 * how much overlap, and a snippet of what it already says.
 *
 * Deliberately just the fact. The call to action ("link it with...")
 * differs by surface — a shell command for the CLI, a tool argument for
 * MCP — so each caller appends its own, the same split `formatHit` keeps
 * between presenting a slip and any next-agent hint beside it.
 */
export function formatDuplicateSuggestion(suggestion: DuplicateSuggestion): string {
  const pct = Math.round(suggestion.overlap * 100);
  const snippet = suggestion.slip.text.length > 100
    ? `${suggestion.slip.text.slice(0, 99)}…`
    : suggestion.slip.text;
  const verb = suggestion.kind === "duplicate" ? "possible duplicate of" : "overlaps existing memory";
  return `${verb} ${suggestion.slip.id} (${pct}% overlap) — kept "${snippet}"`;
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

/** Adaptive byte formatting — a freshly-created database is a few KB, not "0.00 MB". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Render a `dejavu doctor` report for a person, not an agent — this is a
 * support/ops tool, so the layout favors a quick scan over the
 * kind/trust/provenance conventions the recall-facing formatters above
 * follow.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`dejavu doctor`);
  lines.push(`version:  ${report.version}`);
  lines.push(`runtime:  bun ${report.runtime.bun} · ${report.runtime.platform} · git ${report.runtime.git}`);
  const size = report.database.sizeBytes !== null ? formatBytes(report.database.sizeBytes) : "unknown";
  lines.push(`db:       ${report.database.path} (${size})`);
  lines.push(`sqlite:   ${report.database.sqlite}`);
  lines.push(
    `fts:      ${report.database.ftsIndexed}/${report.database.ftsTotal} indexed` +
      (report.database.ftsInSync ? "" : " — OUT OF SYNC"),
  );

  lines.push("");
  lines.push(`scopes (${report.scopes.length}):`);
  if (report.scopes.length === 0) {
    lines.push(`  (none yet)`);
  } else {
    for (const s of report.scopes) {
      lines.push(
        `  ${s.scope}: ${s.slips} slips (${s.kept} kept, ${s.drafts} draft, ${s.expired} expired), ` +
          `${s.handoffs} handoffs (${s.activeHandoffs} active), ${s.anchoredSlips} anchored`,
      );
    }
  }

  lines.push("");
  lines.push(`current scope: ${report.currentScope.scope} (${report.currentScope.source})`);
  const session = report.currentScope.session;
  lines.push(
    `  session: ${session.id}` +
      (session.claimed
        ? ` (claimed by ${session.harness}, ${Math.round((session.ageMs ?? 0) / 1000)}s old)`
        : " (per-process)"),
  );
  const anchors = report.currentScope.anchors;
  lines.push(
    `  anchors: ${anchors.total} total — ${anchors.verified} verified, ${anchors.drifted} drifted, ` +
      `${anchors.orphaned} orphaned, ${anchors.unknown} unknown`,
  );

  lines.push("");
  lines.push(
    report.warnings.length > 0
      ? `warnings:\n${report.warnings.map((w) => `  - ${w}`).join("\n")}`
      : `warnings: none`,
  );

  return lines.join("\n");
}
