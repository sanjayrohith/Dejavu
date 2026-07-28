import Header from "@/components/Header";
import Hyperspeed from "@/components/Hyperspeed";
import Waypoints from "@/components/Waypoints";
import Reveal from "@/components/Reveal";
import Terminal from "@/components/Terminal";
import Laps from "@/components/Laps";
import SectionLink from "@/components/SectionLink";
import {
  BOUNDARIES,
  INSTALL_CMDS,
  LOSSES,
  MCP_CONFIG,
  MCP_TOOLS,
  REPO,
  SHARED_PROVES,
} from "@/lib/content";

/* Module scope, not an inline literal: <Hyperspeed> keys its whole WebGL scene
   off the identity of this object, so a fresh one each render would tear down
   and rebuild the scene. Colours are the site tokens — amber outbound, cool
   inbound — rather than the component's default synthwave purple. */
const BACKDROP_EFFECT_OPTIONS = {
  distortion: "turbulentDistortion",
  length: 400,
  roadWidth: 10,
  islandWidth: 2,
  lanesPerRoad: 3,
  fov: 90,
  fovSpeedUp: 150,
  speedUp: 2,
  carLightsFade: 0.4,
  totalSideLightSticks: 20,
  lightPairsPerRoadWay: 40,
  shoulderLinesWidthPercentage: 0.05,
  brokenLinesWidthPercentage: 0.1,
  brokenLinesLengthPercentage: 0.5,
  lightStickWidth: [0.12, 0.5],
  lightStickHeight: [1.3, 1.7],
  movingAwaySpeed: [60, 80],
  movingCloserSpeed: [-120, -160],
  carLightsLength: [12, 80],
  carLightsRadius: [0.05, 0.14],
  carWidthPercentage: [0.3, 0.5],
  carShiftX: [-0.8, 0.8],
  carFloorSeparation: [0, 5],
  colors: {
    roadColor: 0x0a0b0e,
    islandColor: 0x0e1015,
    background: 0x08090c,
    shoulderLines: 0x3a3f4a,
    brokenLines: 0x3a3f4a,
    leftCars: [0xffb020, 0xffc75e, 0xff8c1a],
    rightCars: [0x56d9e8, 0x2f9fb2, 0x1c6a7d],
    sticks: 0xffb020,
  },
};

export default function Page() {
  return (
    <>
      {/* fixed behind the whole page — the road keeps running for the full
          scroll, and scrolling is what drives its speed */}
      <div className="backdrop" aria-hidden="true">
        <Hyperspeed effectOptions={BACKDROP_EFFECT_OPTIONS} />
      </div>

      {/* the seven slip kinds as waypoints down the road — scrolling the hero
          flies past them in turn, then the run fades out */}
      <Waypoints />

      <Header />

      <main id="top">
        {/* ---------------- hero ---------------- */}
        <section className="hero">
          <div className="hero__scrim" />

          <div className="wrap hero__content">
            <div className="hero__text">
              <p className="eyebrow">v0.1.0 — local-first agent memory</p>
              <h1>
                Memory that lets coding agents <span>continue</span> instead of
                start over.
              </h1>
              <p className="hero__sub">
                Dejavu gives an agent a fast, repository-scoped memory between
                sessions — decisions, preferences, procedures, pitfalls, facts
                and work in progress, in one inspectable SQLite file. Recall is
                local, bounded, cited, and honest about uncertainty.
              </p>
              <div className="hero__cta">
                <a className="btn btn--primary" href="#install">
                  Get started
                </a>
                <a className="btn" href={REPO} target="_blank" rel="noreferrer">
                  View on GitHub ↗
                </a>
              </div>
              <div className="hero__meta">
                <span>No account</span>
                <span>No daemon</span>
                <span>No embeddings required</span>
                <span>No transcript dump</span>
              </div>
            </div>
          </div>
        </section>

        <SectionLink label="01 — the problem" />

        {/* ---------------- problem ---------------- */}
        <section className="section" id="problem">
          <div className="wrap">
            <Reveal>
              <p className="eyebrow">The problem</p>
              <h2>Agents lose the expensive part of the work.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Every new session, the same context evaporates — and the next
                agent pays to rediscover it.
              </p>
            </Reveal>

            <Reveal className="alerts" stagger>
              {LOSSES.map((l, i) => (
                <div className="alert" key={i}>
                  <span className="alert__idx">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="alert__txt">
                    <b>{l.lead}</b> {l.rest}
                  </span>
                </div>
              ))}
            </Reveal>

            <Reveal delay={140}>
              <p className="note-line">
                A notes database is not enough. Memory must appear in the right
                repository, fit inside a context budget, distinguish relevance
                from trust, stop surfacing completed work, and expose evidence
                when it fails. Those constraints shape Dejavu.
              </p>
            </Reveal>
          </div>
        </section>

        <SectionLink label="02 — how it works" />

        {/* ---------------- how it works: four laps ---------------- */}
        <Laps />

        <SectionLink label="03 — boundaries" />

        {/* ---------------- boundaries ---------------- */}
        <section className="section" id="boundaries">
          <div className="wrap">
            <Reveal>
              <p className="eyebrow">Design boundaries</p>
              <h2>Deliberately narrow, and honest about it.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Every one of these is a trade-off Dejavu chose on purpose — not
                a feature still on the roadmap.
              </p>
            </Reveal>

            <Reveal className="bounds" stagger>
              {BOUNDARIES.map((b) => (
                <div className="bound" key={b.is}>
                  <div className="bound__is">Is</div>
                  <div className="bound__t">{b.is}</div>
                  <div className="bound__not">{b.not}</div>
                </div>
              ))}
            </Reveal>

            <Reveal delay={130}>
              <p className="notlist">
                Dejavu is <b>not</b> a secrets manager, a generic RAG platform, a
                team ACL product, or a replacement for source control. Local
                SQLite is plaintext — don&rsquo;t store credentials, customer
                data, or secrets in it.
              </p>
            </Reveal>
          </div>
        </section>

        <SectionLink label="04 — the interface" />

        {/* ---------------- MCP surface ---------------- */}
        <section className="section section--tight" id="mcp">
          <div className="wrap">
            <Reveal>
              <p className="eyebrow">The interface</p>
              <h2>Seven tools. The descriptions are the contract.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Dejavu does not require a <span className="mono">SKILL.md</span>,
                an <span className="mono">AGENTS.md</span>, or a memory paragraph
                copied into every system prompt. Wire the MCP server in and the
                tool descriptions carry the operating contract.
              </p>
            </Reveal>

            <Reveal className="alerts" stagger>
              {MCP_TOOLS.map(([name, purpose]) => (
                <div className="alert" key={name}>
                  <span
                    className="alert__idx mono"
                    style={{ minWidth: 132, color: "var(--accent)" }}
                  >
                    {name}
                  </span>
                  <span className="alert__txt">{purpose}</span>
                </div>
              ))}
            </Reveal>
          </div>
        </section>

        <SectionLink label="05 — shared mode" />

        {/* ---------------- shared mode preview ---------------- */}
        <section className="section" id="shared">
          <div className="wrap">
            <Reveal>
              <div className="preview">
                <span className="badge">Preview — not production</span>
                <h2 style={{ marginTop: 20 }}>Shared mode</h2>
                <p className="lede" style={{ marginTop: 16 }}>
                  A Cloudflare Worker with one Durable Object SQL database per
                  memory space, numbered committed changes over SSE, and
                  rebuildable local SQLite/FTS mirrors.
                </p>

                <Reveal as="ul" className="proves" stagger>
                  {SHARED_PROVES.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </Reveal>

                <div className="warnbox">
                  <b>Do not deploy it yet.</b> Bearer-token dogfood is not a
                  production identity system. Multi-user use still requires
                  verified identity, revocation, content policy, audit and
                  retention decisions, and an encryption story. The blocking
                  review is documented in the repository.
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        <SectionLink label="06 — get started" />

        {/* ---------------- install ---------------- */}
        <section className="section" id="install">
          <div className="wrap">
            <Reveal>
              <p className="eyebrow">Get started</p>
              <h2>Sixty seconds to a remembering agent.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Dejavu currently requires{" "}
                <a
                  className="accent"
                  href="https://bun.sh"
                  target="_blank"
                  rel="noreferrer"
                >
                  Bun
                </a>
                . <span className="mono">init</span> creates{" "}
                <span className="mono">~/.dejavu/dejavu.db</span> and prints the
                MCP configuration.
              </p>
            </Reveal>

            <div className="install__grid">
              <Reveal>
                <div className="step">
                  <b>01</b> Install
                </div>
                <Terminal
                  title="shell"
                  copy={INSTALL_CMDS}
                  html={[
                    '<span class="c-prompt">$</span> <span class="c-cmd">bun add github:sanjayrohith/Dejavu</span>',
                    '<span class="c-prompt">$</span> <span class="c-cmd">bunx github:sanjayrohith/Dejavu init</span>',
                    '<span class="c-out">dejavu: db ready at ~/.dejavu/dejavu.db</span>',
                  ].join("\n")}
                />
              </Reveal>

              <Reveal delay={110}>
                <div className="step">
                  <b>02</b> Wire it into your agent
                </div>
                <Terminal
                  title="mcp.json"
                  copy={MCP_CONFIG}
                  html={MCP_CONFIG.replace(
                    /"(dejavu|mcpServers|command|args)"/g,
                    '<span class="c-key">"$1"</span>',
                  )}
                />
              </Reveal>
            </div>

            <Reveal delay={150}>
              <p className="note-line" style={{ marginTop: 42 }}>
                At the beginning of work an agent calls{" "}
                <span className="mono accent">recall(&quot;&quot;)</span>. At the
                end it calls{" "}
                <span className="mono accent">handoff(&#123; summary, next &#125;)</span>
                . That is the whole loop.
              </p>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="ftr">
        <div className="wrap ftr__in">
          <span>
            Dejavu — MIT licensed. Local SQLite is plaintext; keep secrets out.
          </span>
          <nav className="ftr__links">
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={`${REPO}/blob/main/docs/ROADMAP.md`} target="_blank" rel="noreferrer">
              Roadmap
            </a>
            <a href={`${REPO}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">
              Security
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
