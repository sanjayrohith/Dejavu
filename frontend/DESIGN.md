# Dejavu Landing Page — Design Plan

Status: **built**. Next.js 15 App Router, single static route.
Run it with `npm run dev` from `frontend/` (port 3000 by default).

Resolved decisions — the three open questions in §7 were answered during the build:

| Question | Decision | Why |
|---|---|---|
| Accent colour | **Amber `#ffb020`** with cyan `#56d9e8` for graph edges only | Reads as cockpit/HUD; racing red was rejected as F1 cosplay |
| Lap scroll behaviour | **Scroll-reveal** via `IntersectionObserver`, sticky HUD | Cheaper, no jank on mobile, no hijacked scrolling |
| Install ordering | **MCP-first** (install → wire into agent) | Matches the README and the actual activation moment |

Implementation notes worth keeping:

- The hero graph is hand-placed SVG (`components/MemoryGraph.tsx`), not force-directed —
  deterministic composition beat physics here, and no layout library was needed.
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

F1 driver sites orbit one physical object (the car, the number, the helmet) rendered with motion and repeated at every scale. Dejavu doesn't have a physical object — it has a **memory graph**: typed nodes (`decision`, `pitfall`, `procedure`, `preference`, `fact`, `wip`, `note`) connected by real relationships (`supersedes`, `contradicts`, `related`).

That graph is the "car." It appears in the hero as a live animation, then recurs — smaller, quieter — as the connective visual language for every section below. One motif, reused at decreasing intensity, is what makes a page feel designed rather than assembled.

Secondary metaphor, used structurally rather than decoratively: **scroll = lap**. The product's own story already has four beats — store, recall, handoff, verify — which map cleanly onto a "4 laps" scroll structure without forcing a racing theme where it doesn't belong. No checkered flags, no tire textures, no red-bull-cans aesthetic — that's costume, not craft. What's borrowed from racing sites is the *structure* (HUD, telemetry-style stats, lap progression), not the *iconography*.

## 3. Page structure (section by section)

### 3.1 Hero
- Full-viewport section. The graph is **full-bleed** — absolutely positioned across
  the entire hero, not a column beside the text. Its `viewBox` is measured from the
  container and mapped 1:1 to CSS pixels, so it fills any space with no cropping and
  no distortion (a fixed viewBox with `preserveAspectRatio="slice"` would clip nodes
  at some aspect ratios).
- Node positions are stored **normalised (0..1) in two layouts**. Scroll progress
  through the hero lerps between them (eased `easeInOutCubic`), so the constellation
  visibly consolidates toward the hub as you scroll — what recall does to memory —
  and the whole graph fades to 45% as the hero leaves.
- Layout A deliberately keeps every node in the right ~60% and the text column is
  capped at 545px. Earlier revisions had nodes buried under the headline scrim,
  reading as dead grey dots with invisible labels. **Check node/headline collision
  whenever layout A changes.**
- Foreground: the real product line, verbatim from the README — **"Memory that lets
  coding agents continue instead of start over."** — plus one supporting sentence, a
  primary CTA ("Get started") and a secondary CTA (GitHub), over a directional scrim
  that keeps the copy legible. On <940px the graph drops to 45% opacity and the scrim
  goes vertical, so it reads as atmosphere behind the copy.
- No stock photography, no illustration of "a robot." The graph *is* the hero image.

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

- **Palette**: near-black base (`#0a0a0c`-ish), single saturated accent color for the graph/HUD elements. Avoid racing red as the accent specifically because it reads as "F1 cosplay" rather than "this product is precise" — lean toward an amber, cyan, or violet accent instead; final pick should get validated for dark/light contrast, not just picked by eye.
- **Type**: monospace (e.g. JetBrains Mono / IBM Plex Mono) for anything that is literally data — CLI output, slip IDs, timestamps, trust levels. Clean sans (e.g. Inter) for narrative copy. This mirrors a real distinction in the product (typed, inspectable data vs. human-written text) rather than being an arbitrary style choice.
- **Motif**: thin glowing connective lines / circuit-trace style borders, reused from the hero graph into card borders, section dividers, and the HUD strip — this is what makes the page feel like one system instead of a hero section bolted onto a generic body.
- **Motion budget**: every effect has to carry product meaning, not just move. The
  graph runs a single `requestAnimationFrame` loop (`components/MemoryGraph.tsx`)
  driving four layers that compose into one "living memory" system:

  1. **Idle drift** — each node travels its own slow sine orbit (independent
     amplitude, speed and phase, so nothing moves in lockstep). Edge paths are
     recomputed every frame from live node positions, so the lattice flexes as one
     body instead of nodes sliding under fixed lines.
  2. **Recall sweep** — every 7.5s a ring leaves the hub and lights each node as it
     reaches it, ordered by distance. This is the one that *means* something: it is
     literally a scoped recall radiating through the graph.
  2b. **Scroll morph** — nodes travel between layout A and layout B as the hero
     scrolls (see §3.1). Edge draw-in and the travelling pulses are computed in the
     same loop rather than by CSS keyframes, because path lengths change as the
     layout morphs and CSS dash animations would drift out of sync.
  3. **Pointer parallax** — nodes carry a `depth` and swing toward the cursor
     proportionally (hub least, outer nodes most), eased with a lerp so it glides.
     Gives the constellation dimensionality without a 3D library.
  4. **Hover** — the signature interaction: connected edges light cyan and a card
     shows that kind's real README definition plus a real example call.

  Plus two ambient CSS loops: a dashed scanner ring rotating on the hub (24s) and a
  breathing hub glow (6.5s), and the original edge draw-in and travelling pulses.

- **Two constraints learned while building this**, both worth preserving:
  - CSS declarations beat SVG presentation attributes, so anything the rAF loop
    writes must not also be styled in CSS. The sweep flash uses its own dedicated
    circle rather than sharing the hover halo's `opacity`.
  - The node entrance animation (`scale`) and the drift transform (`translate`)
    cannot live on the same element — CSS animation wins. Hence the outer drift
    `<g>` wrapping the inner `.gnode`.

- **The motif runs page-wide**, not just in the hero — three layers carry it down
  the page at decreasing intensity:

  1. **Ambient constellation** (`components/AmbientField.tsx`) — a fixed full-viewport
     canvas behind every section. Points drift and link to near neighbours within
     132px; scrolling imparts damped momentum, so the field reacts to the reader.
     Density scales with viewport area (capped at 64 points), it pauses on
     `visibilitychange`, and points fade near the edges so wrap-around never pops a
     link on screen.
  2. **Section spine nodes** (`components/SectionLink.tsx`) — each section junction is
     a labelled node whose trace draws outward from the centre and pings once as it
     enters view. Replaces the old plain `<hr>`, so the page itself reads as a chain
     of linked slips.
  3. **Scroll progress** — a thin amber-to-cyan bar under the header, keeping the
     HUD/telemetry language consistent with the lap counter.

- Scroll-triggered reveals use `IntersectionObserver` (one-shot, not re-triggering,
  not scroll-jacked). Lists and grids stagger their children via `:nth-child`
  delays rather than appearing as one block.

- **Reveals must use `animation`, not `transition`.** A CSS transition needs a
  previously *painted* start value; an element first revealed while off-screen may
  never have painted one, so it snaps to the end state instead of easing. This was
  a real, measured bug — every reveal on the page was jumping. Keyframes with
  `both` fill hold the from-state through the delay and always play.
- Respect `prefers-reduced-motion`: the graph should still render (static, fully drawn) with reveals appearing instantly rather than animating, for accessibility and to avoid the page being unusable for motion-sensitive visitors.

## 5. Technical approach (Next.js specifics)

- **App Router**, single route (`/`) for v1 — no need for multi-page complexity on a landing page.
- Hero graph: implement as an SVG component if node/edge count stays small (~20 nodes) — SVG gives crisp text labels and easy hover targets on nodes for free, versus canvas which would need manual hit-testing. Fall back to canvas only if performance profiling shows SVG struggling.
- Client components only where needed (the graph, scroll-reveal wrappers, copy-button) — everything else (static copy sections) should stay as server components to keep the page lightweight.
- No animation library dependency required for v1 — CSS transitions/keyframes + `IntersectionObserver` + native SVG animation (`stroke-dashoffset`) cover everything described above without adding bundle weight. If node-graph physics (force-directed layout) turns out to need more than a fixed/hand-placed layout, that's the one place a small library (e.g. `d3-force` for layout math only, not rendering) might be justified — decide after seeing whether a static/curated layout looks good enough.
- Fonts via `next/font` (self-hosted, no external request) for the monospace/sans pairing.
- Images/GIFs: avoid raster GIFs for the graph animation specifically (file size, no crispness at different DPIs) — everything in the hero should be vector/code-driven so it stays sharp and small. Raster assets (if any — e.g. a subtle background texture) should be `next/image` optimized and used sparingly, not as the primary visual.

## 6. Content accuracy checklist

Before shipping, every claim on the page should trace back to `README.md`, `docs/ROADMAP.md`, or `docs/shared-security-review.md` — no invented metrics, no "10x faster," no fabricated testimonials or logos. Specifically avoid:
- Claiming vector/embedding search anywhere (Dejavu is explicitly lexical/deterministic by default).
- Implying shared mode is production-ready.
- Inventing usage numbers, user counts, or benchmark results not present in `docs/bench/claims.md`.

## 7. Open questions for you

- Accent color: amber/cyan/violet, or a color you already have in mind?
- Do you want the four-lap section to scroll-jack (locked, driven by scroll position precisely) or scroll-reveal (normal scroll, sections just animate in as they arrive)? Scroll-reveal is far cheaper to build and less likely to feel janky; scroll-jacking is closer to true racer-site feel but riskier on mobile.
- Should the install section target the agent operator (MCP config first) or the contributor (git clone first) as the primary path? README leans MCP-first; page CTA order should probably match.
