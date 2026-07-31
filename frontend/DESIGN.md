# Dejavu Landing Page — Design Plan

Status: **built**. Next.js 15 App Router, single static route.
Run it with `npm run dev` from `frontend/` (port 3000 by default).

Resolved decisions — the three open questions in §7 were answered during the build:

| Question | Decision | Why |
|---|---|---|
| Accent colour | **Amber `#ffb020`** primary, cyan `#56d9e8` as a secondary accent (progress bar, links, borders) | Reads as cockpit/HUD; racing red was rejected as F1 cosplay |
| Lap scroll behaviour | **Scroll-reveal** via `IntersectionObserver`, sticky HUD | Cheaper, no jank on mobile, no hijacked scrolling |
| Install ordering | **MCP-first** (install → wire into agent) | Matches the README and the actual activation moment |

Implementation notes worth keeping:

- The hero and every section backdrop are one canvas-painted image sequence
  (`components/Film.tsx`), scrubbed by scroll position — not the SVG memory-graph
  hero originally planned in §2/§3.1 below. `components/MemoryGraph.tsx` was built
  but never wired into the page and has since been removed; `AmbientField.tsx`,
  referenced in an earlier draft of §4, was never built. See the "Current design"
  notes inline in §2–§4 for what actually shipped.
- Grid items carry `min-width: 0`; without it the terminal `<pre>` stretched its track
  and produced 164px of horizontal page overflow at 390px wide.
- Verified at 390 / 768 / 1440 px with zero horizontal body overflow. Wide terminal
  content scrolls inside its own panel, as intended.
- Zero runtime dependencies beyond React/Next — no animation library.

## 1. Goal

One page that does two jobs at once, in order of priority:

1. Make a visitor understand **what Dejavu is and why it exists** in under 30 seconds, accurately — no metaphor should out-run the truth of the product.
2. Feel distinctive and alive on first scroll — the "Lando Norris landing page" bar: one strong kinetic idea, not a grid of feature cards with fade-ins.

Everything below is designed to serve #1 first. The motion system exists to carry real product content, not to decorate an otherwise generic SaaS page.

## 2. The central metaphor

F1 driver sites orbit one physical object (the car, the number, the helmet) rendered with motion and repeated at every scale. The original plan for Dejavu was a **memory graph** filling that role: typed nodes (`decision`, `pitfall`, `procedure`, `preference`, `fact`, `wip`, `note`) connected by real relationships (`supersedes`, `contradicts`, `related`), live in the hero and recurring, smaller and quieter, down the page.

**Current design:** that graph was never wired in. What ships instead is a single continuous camera move — a 150-frame image sequence (`components/Film.tsx`, frames in `lib/film.ts`) crossing a lantern-lit bridge at dawn, arriving at a gate, and settling inside a candlelit hall — pinned behind the whole page and scrubbed by scroll position via `data-film-cue` markers (`components/Cue.tsx`). That journey is the throughline now: the four chapter cards (`components/Beat.tsx`) narrate it explicitly — "the walk back," "a door, not a dump," "cross the threshold," "what you are left holding" — as the reader moves from outside the gate to inside the archive.

Secondary metaphor, used structurally rather than decoratively: **scroll = lap**. This one did ship as designed. The product's own story already has four beats — remember, recall, handoff, verify — which map onto a "4 laps" scroll structure (`components/Laps.tsx`, a sticky HUD counting "Lap 01–04") without forcing a racing theme where it doesn't belong. No checkered flags, no tire textures, no red-bull-cans aesthetic — that's costume, not craft. What's borrowed from racing sites is the *structure* (HUD, telemetry-style stats, lap progression), not the *iconography*.

## 3. Page structure (section by section)

### 3.1 Hero
- Full-viewport section. The plan below (full-bleed SVG graph, two normalised
  layouts lerped by scroll progress) was never built. **Current design:** the hero
  background is the opening act of the `Film` image sequence — full-bleed canvas,
  `object-fit: cover` framing — with a directional veil/vignette (`lib/film.ts`
  `veilAt`) keeping the copy legible instead of a graph-specific scrim.
- Foreground: the real product line, verbatim from the README — **"Memory that lets
  coding agents continue instead of start over."** — plus one supporting sentence, a
  primary CTA ("Get started") and a secondary CTA (GitHub).
- No stock photography, no illustration of "a robot." No memory-graph diagram either,
  in the shipped version — the film sequence is the hero image.

### 3.2 The problem
- Short, high-contrast section, dark background continues.
- The five bullets from the README's "Why Dejavu" section (decision-and-why, the command that worked, the failure mode, the next step after compaction, the user's preference), each rendered as a HUD-style alert line that types/reveals in on scroll via `IntersectionObserver` — not scroll-jacked, just triggered once when it enters view.
- This section's entire content is real README content, reworded minimally. No invented pain points.

### 3.3 How it works — the four laps
This is the structural core of the page and must be accurate to the actual system, not a simplified marketing version:

- **Lap 1 — Remember**: explain slips are typed and immutable (`decision`, `preference`, `procedure`, `pitfall`, `fact`, `wip`, `note`). Show one real CLI line: `dejavu remember "Use Vitest" --kind=decision`.
- **Lap 2 — Recall**: explain bounded, budgeted, cited retrieval (BM25/FTS5, not embeddings, not vector search). Show the trust-vs-relevance distinction (`low` / `medium` / `high`) — this is one of the most differentiated ideas in the product and deserves real visual space, e.g. a small three-state indicator, not just a sentence.
- **Lap 3 — Handoff**: explain the active-continuation-packet concept, and that resolved/abandoned handoffs stop surfacing. Show the stale-after-three-days behavior as a small detail — it's the kind of honest, non-marketing detail that builds credibility.
- **Lap 4 — Verify / Evidence loop**: explain `assessRecall` (`useful` / `wrong` / `missed` / `no_memory_needed`) and `dejavu eval`. This is what makes Dejavu "honest about uncertainty" rather than a black box — say that explicitly.

Each lap: a persistent thin HUD strip (fixed position, top or side) advances "LAP 1/4 → 4/4" as the user scrolls through this section only — contained motion, not a full-page scroll-jack.

Each lap should pair copy with a **real terminal snippet** (actual CLI output style, monospace, styled like a cockpit readout: dark panel, thin glowing border, subtle scanline or glow — not a generic gray `<pre>` block). Use verbatim or near-verbatim output from the README/CLI, not invented data.

### 3.4 Trust & design boundaries
- A compact section stating what Dejavu deliberately is and is not, taken directly from the README's "Design boundaries":
  - local-first, not remote-only
  - lexical and deterministic by default, not vector-first
  - repository-scoped, not one global memory soup
  - append-only and auditable
  - budgeted, not a transcript injector
  - honest about stale state
  - **not** a secrets manager, generic RAG platform, team ACL product, or source-control replacement
- This section matters more than it looks — it's what separates Dejavu from "yet another AI memory startup" positioning and should read as confident, not defensive.

### 3.5 Shared mode (preview, not production)
- Smaller section, visually quieter than the rest (signals "not the main story yet").
- States clearly: Cloudflare Worker + Durable Object per memory space, SSE live updates, rebuildable local mirrors — and just as clearly that it is **not deployed for multi-user use** pending a security review. Do not soften or omit this caveat — it's load-bearing for trust with a technical audience.

### 3.6 Install / get started
- Terminal-panel component (same visual system as the CLI snippets in 3.3) showing the real two install paths from the README:
  ```
  bun add github:sanjayrohith/Dejavu
  bunx github:sanjayrohith/Dejavu init
  ```
  and the clone path. Copy-to-clipboard button on the code block.
- Directly under it, the 60-second MCP config snippet (`mcpServers` JSON block) — this is the actual activation moment for the target user (an agent operator), so it should be one scroll away from the CTA, not buried in docs.

### 3.7 Footer
- Minimal: GitHub link, license (MIT), links to `docs/ROADMAP.md` and `SECURITY.md` if useful. No newsletter form, no fake social proof, no logos row — none of that exists for this project and inventing it would misrepresent it.

## 4. Visual language

- **Palette**: near-black base (`#0a0a0c`-ish), single saturated accent color for HUD/telemetry elements (badges, the lap counter, the scroll-progress bar). Avoid racing red as the accent specifically because it reads as "F1 cosplay" rather than "this product is precise" — lean toward an amber, cyan, or violet accent instead; final pick should get validated for dark/light contrast, not just picked by eye.
- **Type**: monospace (e.g. JetBrains Mono / IBM Plex Mono) for anything that is literally data — CLI output, slip IDs, timestamps, trust levels. Clean sans (e.g. Inter) for narrative copy. This mirrors a real distinction in the product (typed, inspectable data vs. human-written text) rather than being an arbitrary style choice.
- **Motif**: the plan below (glowing connective lines reused from a hero graph into
  card borders and the HUD strip) assumed the graph shipped. **Current design:** the
  connective language instead comes from the film sequence itself (the continuous
  camera move is the throughline) plus the two motifs that did ship, below.
- **Motion budget** (as shipped): every effect has to carry product meaning, not
  just move.
  1. **Film** (`components/Film.tsx`) — the 150-frame sequence is painted to a
     canvas and scrubbed by scroll position. Frame targets ease between
     `data-film-cue` markers (smoothstep, not linear tracking) so the camera lands
     on each cue instead of sliding past it, and settle to a whole decoded frame at
     rest instead of holding a fractional dissolve. A directional veil/vignette/grain
     sit over the plate; `prefers-reduced-motion` snaps straight to the nearest cue
     with no chase.
  2. **Beat cards** (`components/Beat.tsx`) — the four chapter cards rise in, hold
     at full strength across the middle third of their scroll crossing, and sink
     out, driven by scroll position written straight to `style` on the rAF tick
     rather than through React state.
  3. **Section spine nodes** (`components/SectionLink.tsx`) — each section junction
     is a labelled node whose trace draws outward from the centre and pings once as
     it enters view via `IntersectionObserver`. Replaces a plain `<hr>`.
  4. **Scroll progress** — a thin bar under the header (`components/Header.tsx`),
     keeping the HUD/telemetry language consistent with the lap counter.

  The **memory graph** (idle drift, a recall sweep radiating from the hub, hover
  cards) was designed and built as `components/MemoryGraph.tsx` but never wired
  into the page, and has since been deleted as dead code. `components/AmbientField.tsx`
  (a page-wide ambient particle canvas) was planned but never built. If either is
  revisited, treat it as new work, not a restore.

- Scroll-triggered reveals use `IntersectionObserver` (one-shot, not re-triggering,
  not scroll-jacked). Lists and grids stagger their children via `:nth-child`
  delays rather than appearing as one block.

- **Reveals must use `animation`, not `transition`.** A CSS transition needs a
  previously *painted* start value; an element first revealed while off-screen may
  never have painted one, so it snaps to the end state instead of easing. This was
  a real, measured bug — every reveal on the page was jumping. Keyframes with
  `both` fill hold the from-state through the delay and always play.
- Respect `prefers-reduced-motion`: the film sequence still renders (snapped to the
  nearest cue, no chase) with reveals appearing instantly rather than animating, for
  accessibility and to avoid the page being unusable for motion-sensitive visitors.

## 5. Technical approach (Next.js specifics)

- **App Router**, single route (`/`) for v1 — no need for multi-page complexity on a landing page.
- Client components only where needed (`Film`, `Header`, `Beat`, `Laps`, `SectionLink`, `Reveal`, `Terminal`, `Cue`) — everything else (static copy sections in `app/page.tsx`) stays a server component to keep the page lightweight.
- No animation library dependency required — CSS keyframes + `IntersectionObserver` + a couple of small `requestAnimationFrame` loops (`Film`, `Beat`, `lib/raf.ts`) cover everything described above without adding bundle weight.
- Fonts via `next/font` (self-hosted, no external request) for the monospace/sans pairing.
- The hero and every section backdrop is a raster WebP frame sequence (`public/frames/{hd,sm}`, built by `scripts/build-frames.sh`), not vector/code-driven — the opposite of the original plan's "avoid raster for the hero" guidance. Two sets (`hd` 1920×1080 every frame, `sm` 1280×720 every other frame) keep phones from pulling the desktop sequence; see `lib/film.ts` for the fetch-order and blend strategy that keeps this smooth without a graph or canvas particle system.

## 6. Content accuracy checklist

Before shipping, every claim on the page should trace back to `README.md`, `docs/ROADMAP.md`, or `docs/shared-security-review.md` — no invented metrics, no "10x faster," no fabricated testimonials or logos. Specifically avoid:
- Claiming vector/embedding search anywhere (Dejavu is explicitly lexical/deterministic by default).
- Implying shared mode is production-ready.
- Inventing usage numbers, user counts, or benchmark results not present in `docs/bench/claims.md`.

## 7. Open questions for you

- Accent color: amber/cyan/violet, or a color you already have in mind?
- Do you want the four-lap section to scroll-jack (locked, driven by scroll position precisely) or scroll-reveal (normal scroll, sections just animate in as they arrive)? Scroll-reveal is far cheaper to build and less likely to feel janky; scroll-jacking is closer to true racer-site feel but riskier on mobile.
- Should the install section target the agent operator (MCP config first) or the contributor (git clone first) as the primary path? README leans MCP-first; page CTA order should probably match.
