/**
 * All copy here traces back to README.md / docs.
 * No invented metrics, no fabricated social proof — see DESIGN.md §6.
 */

export const REPO = "https://github.com/sanjayrohith/Dejavu";

/** README → "Why Dejavu": what agents lose between sessions. */
export const LOSSES: { lead: string; rest: string }[] = [
  { lead: "The decision", rest: "and why it was made" },
  { lead: "The command", rest: "that finally worked" },
  { lead: "The failure mode", rest: "that should not be repeated" },
  { lead: "The exact next step", rest: "after context compaction" },
  { lead: "The user's preference", rest: "that is specific to this project" },
  { lead: "The verified fact", rest: "re-checked from scratch instead of recalled" },
];

export const TRUST = [
  { level: "low", desc: "Draft or disputed; verify before relying on it." },
  { level: "medium", desc: "Kept, but not yet confirmed through use." },
  { level: "high", desc: "Kept and materially useful at least twice." },
] as const;

/** README → "Design boundaries". */
export const BOUNDARIES = [
  { is: "local-first", not: "not remote-only" },
  { is: "lexical + deterministic", not: "not vector-first" },
  { is: "repository-scoped", not: "not one global memory soup" },
  { is: "append-only + auditable", not: "not silently self-rewriting" },
  { is: "budgeted", not: "not a transcript injector" },
  { is: "honest about stale state", not: "not eventually-consistent theater" },
];

/** README → shared mode "It already proves". */
export const SHARED_PROVES = [
  "Server commit before write receipt",
  "Immediate read-after-write in the writer's mirror",
  "Live peer updates that never block writes",
  "Contiguous revision watermarks + explicit stale state",
  "Offline catch-up",
  "Replayable hard deletion with payload redaction",
  "Bounded stream lifetimes and reauthentication points",
  "Token-to-space isolation in local dogfood",
];

/**
 * The chapter cards that sit between sections, over uncovered film. Each one
 * restates a claim the sections then evidence — nothing here is a new promise.
 */
export const BEATS = [
  {
    id: "approach",
    n: "01",
    kicker: "the walk back",
    line: "Every session starts at the gate again.",
    sub: "The decision, the command that finally worked, the failure mode not to repeat — all of it evaporates with the context window, and the next agent pays to rediscover it.",
  },
  {
    id: "door",
    n: "02",
    kicker: "a door, not a dump",
    line: "Memory that opens on the right repository.",
    sub: "Scope is a first-class key, not a tag. A slip written in one repository does not walk into the next one, and recall arrives budgeted rather than pasted.",
  },
  {
    id: "threshold",
    n: "03",
    kicker: "cross the threshold",
    line: "Inside, everything is still inspectable.",
    sub: "One SQLite file. Append-only slips, explicit supersession, receipts you can assess. Nothing rewrites itself behind your back.",
  },
  {
    id: "archive",
    n: "04",
    kicker: "what you are left holding",
    line: "A memory you can open, read, and delete.",
    sub: "No account, no daemon, no embeddings required, no transcript dump. Sixty seconds from install to an agent that continues.",
  },
] as const;

export interface Lap {
  id: string;
  n: string;
  stage: string;
  title: string;
  body: string[];
  term: { title: string; lines: string };
  /** film frame this lap is anchored to — see lib/film.ts */
  cue: number;
}

export const LAPS: Lap[] = [
  {
    id: "remember",
    cue: 108,
    n: "Lap 01",
    stage: "Remember",
    title: "Typed memory, without filing work",
    body: [
      "Every slip carries one kind — decision, preference, procedure, pitfall, fact, wip, or note. Agents may set it; if they don't, Dejavu applies a conservative deterministic heuristic. Never a hidden model call.",
      "Slips are immutable. A correction doesn't rewrite history, it writes a new slip and links it with supersedes. The old claim stays inspectable.",
    ],
    term: {
      title: "dejavu remember",
      lines: [
        '<span class="c-prompt">$</span> <span class="c-cmd">dejavu remember "Use Vitest" --kind=decision --keep</span>',
        '<span class="c-out">kept decision 01KYJ1N5X5WQEX4RV19RVES1GG</span>',
        "",
        '<span class="c-prompt">$</span> <span class="c-cmd">dejavu link 01KYJ1N5X5 supersedes 01KYHZ8M2Q</span>',
        '<span class="c-out">linked  01KYJ1N5X5 <span class="c-key">supersedes</span> 01KYHZ8M2Q</span>',
      ].join("\n"),
    },
  },
  {
    id: "recall",
    cue: 118,
    n: "Lap 02",
    stage: "Recall",
    title: "Bounded packets, and trust is not relevance",
    body: [
      "Recall takes an approximate token budget and optional kind filters. Dejavu retrieves locally, follows supersession to current memory, deduplicates, and stops before the packet outgrows the budget.",
      "BM25 answers “does this text match?” — it does not answer “is this true?”. Dejavu keeps those separate, so a lexical hit is never labelled authoritative.",
    ],
    term: {
      title: "dejavu recall",
      lines: [
        '<span class="c-prompt">$</span> <span class="c-cmd">dejavu recall "deploy staging" \\</span>',
        '<span class="c-cmd">      --tokens=700 --kind=decision,pitfall</span>',
        '<span class="c-out">receipt: 01KYJ1NBR3JCYAK1MF1DC6C9RQ</span>',
        '<span class="c-out">[<span class="c-good">high</span>] 01KYJ1N5X5  decision  wrangler deploy --env staging</span>',
        '<span class="c-out">      scope: repo:dejavu:9bea41ad8915</span>',
        '<span class="c-out">[<span class="c-key">low</span>]  01KYHZ8M2Q  pitfall   staging secrets are not inherited</span>',
      ].join("\n"),
    },
  },
  {
    id: "handoff",
    cue: 126,
    n: "Lap 03",
    stage: "Handoff",
    title: "Continuation that stops when the work stops",
    body: [
      "A handoff is an active continuation packet, not a permanent instruction. Only active, repository-scoped handoffs appear in normal recall — resolved or abandoned work stops directing the next agent.",
      "An unresolved handoff older than three days is labelled stale and advisory, so the next agent verifies it before acting on it.",
    ],
    term: {
      title: "dejavu handoff",
      lines: [
        '<span class="c-prompt">$</span> <span class="c-cmd">dejavu handoff "Auth refactor implemented, not deployed"</span>',
        '<span class="c-out">active handoff 01KYJ1P7T4 — repo:dejavu:9bea41ad8915</span>',
        '<span class="c-out">  next: run integration tests</span>',
        '<span class="c-out">  next: deploy canary</span>',
        "",
        '<span class="c-prompt">$</span> <span class="c-cmd">dejavu resolve 01KYJ1P7T4 completed</span>',
        '<span class="c-out">resolved <span class="c-good">completed</span></span>',
      ].join("\n"),
    },
  },
  {
    id: "verify",
    cue: 133,
    n: "Lap 04",
    stage: "Verify",
    title: "A feedback loop you can actually measure",
    body: [
      "Each recall returns a content-free receipt id. After acting, an agent assesses it: useful, wrong, missed, or no_memory_needed. The trace stores the query, scope, returned ids, session and author — never a copy of the memory text or the transcript.",
      "Those receipts are also a corpus. Because memory is append-only, dejavu eval --replay re-runs every recorded retrieval as of the moment it was served — so a change to retrieval is quantified before it ships, and nothing has to be graded by hand first.",
    ],
    term: {
      title: "dejavu assess / eval",
      lines: [
        '<span class="c-prompt">$</span> <span class="c-cmd">dejavu assess 01KYJ1NBR3 useful "saved a repo scan"</span>',
        '<span class="c-out">assessed <span class="c-good">useful</span></span>',
        "",
        '<span class="c-prompt">$</span> <span class="c-cmd">dejavu eval</span>',
        '<span class="c-out">scope:   repo:dejavu:9bea41ad8915</span>',
        '<span class="c-out">traces:  18   <span class="c-good">useful</span> 12  wrong 1  missed 3  n/a 2</span>',
        "",
        '<span class="c-prompt">$</span> <span class="c-cmd">dejavu eval --replay</span>',
        '<span class="c-out">replayed 18 receipt(s) as of when each was served</span>',
        '<span class="c-out">exact        16 <span class="c-good">identical</span>   1 reordered   1 changed</span>',
      ].join("\n"),
    },
  },
];

export const MCP_CONFIG = `{
  "mcpServers": {
    "dejavu": {
      "command": "bunx",
      "args": ["github:sanjayrohith/Dejavu", "mcp"]
    }
  }
}`;

export const INSTALL_CMDS = `bun add github:sanjayrohith/Dejavu
bunx github:sanjayrohith/Dejavu init`;

export const MCP_TOOLS = [
  ["recall", "Scoped, budgeted retrieval plus the active handoff"],
  ["touching", "Reverse lookup: what is known about the files you are about to change"],
  ["remember", "Draft or keep a typed memory; optionally supersede old slips"],
  ["handoff", "Leave one active continuation packet for the next session"],
  ["resolve_handoff", "Complete or abandon a handoff"],
  ["signal", "Mark one slip used, wrong, or forgotten"],
  ["link", "Relate two existing slips"],
  ["assess", "Evaluate a recall receipt"],
];

/**
 * README / LICENSE.md / SECURITY.md — the same "typed, inspectable record"
 * idea the product itself uses (a slip, a receipt) applied to the legal and
 * privacy surface: a manifest you read, not a policy you take on faith.
 */
const link = (label: string, href: string) =>
  `<a class="c-link" href="${href}" target="_blank" rel="noreferrer">${label}</a>`;

export const MANIFEST_HTML = [
  '<span class="c-prompt">$</span> <span class="c-cmd">dejavu manifest --scope=license,docs,privacy</span>',
  "",
  `<span class="c-key">license </span> proprietary, source-available        ${link("LICENSE.md ↗", `${REPO}/blob/main/LICENSE.md`)}`,
  `<span class="c-key">docs    </span> README, roadmap, changelog           ${link("browse docs ↗", `${REPO}#readme`)}`,
  `<span class="c-key">privacy </span> local-only, zero telemetry           ${link("SECURITY.md ↗", `${REPO}/blob/main/SECURITY.md`)}`,
  "",
  '<span class="c-out">manifest: 3 records, 0 hidden clauses</span>',
].join("\n");

export const MANIFEST_COPY = `$ dejavu manifest --scope=license,docs,privacy

license   proprietary, source-available        LICENSE.md
docs      README, roadmap, changelog           browse docs
privacy   local-only, zero telemetry           SECURITY.md

manifest: 3 records, 0 hidden clauses`;

export const RESOURCE_NOTES = [
  {
    id: "license",
    label: "License",
    note: "Read every line, but don't copy, redistribute, resell, or fork it into another project without written permission — Issues and PRs are welcome under Section 3.",
    href: `${REPO}/blob/main/LICENSE.md`,
    linkLabel: "LICENSE.md ↗",
  },
  {
    id: "docs",
    label: "Docs",
    note: "The README carries install, the CLI, and the full agent API; the roadmap and changelog track what shipped versus what's next.",
    href: `${REPO}#readme`,
    linkLabel: "browse docs ↗",
  },
  {
    id: "privacy",
    label: "Privacy",
    note: "No sign-up, no analytics, no background network calls — Dejavu writes plaintext SQLite to your disk and nowhere else. Not a vault: keep secrets out of it.",
    href: `${REPO}/blob/main/SECURITY.md`,
    linkLabel: "SECURITY.md ↗",
  },
] as const;
