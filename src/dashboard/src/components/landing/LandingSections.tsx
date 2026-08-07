import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Bot,
  Boxes,
  Briefcase,
  Building2,
  Check,
  Cloud,
  Database,
  Layers,
  Lock,
  RefreshCw,
  Repeat,
  Rocket,
  ScrollText,
  Server,
  Settings2,
  Sparkles,
  Users,
} from 'lucide-react';

export interface LandingSectionsProps {
  onEnter: () => void;
}

type EnterProps = Pick<LandingSectionsProps, 'onEnter'>;
type HeroProps = LandingSectionsProps;

// Access to the hosted instance is by invitation — `allowSignup` defaults to
// false (DROP_ALLOW_SIGNUP, platform.ts) and dropkit.sh runs it that way, so
// sending a new visitor to /dashboard/signup funnels them into a page that
// refuses them. Every "get started" CTA points here instead.
//
// This is the one host-specific string on the page. If you are self-hosting
// DROP and have opened signup, change this to '/dashboard/signup' (or drop the
// CTA) — everything else here is deliberately host-neutral.
const REQUEST_ACCESS_URL = 'https://waitlist.dropkit.sh';

// The self-host path. Unlike REQUEST_ACCESS_URL this is NOT host-specific: it
// points at the project's own repository, which is the same for every DROP
// install serving this bundle, so it does not violate the host-neutrality rule
// above. /releases/latest always resolves to the newest stable release, so this
// never needs bumping at release time — which is the whole reason 1.0.0 was cut
// as a stable version rather than an rc (GitHub does not resolve /latest to a
// prerelease).
const RELEASES_URL = 'https://github.com/JulesNsenda/drop/releases/latest';

// Page order is deliberate and audience-driven: a reader meets the *outcome*
// (hero → what you get → who it's for → how it works → how to run it) before
// meeting any mechanism. Everything from `TechnicalDivider` down is the
// technical proof — runtimes, drop.yaml, CLI, MCP — kept intact for the person
// who will actually operate the box, and explicitly signposted so a business
// reader knows they can stop. Rewriting sentences alone did not fix this page;
// the section order was the problem.
//
// Host-neutrality matters here: this same bundle is served at "/" by *every*
// DROP install, not just dropkit.sh. No copy may name a specific host, and the
// "hosted" path must read as "this instance", never "our SaaS".
//
// The landing CTAs point at /docs and /reference, which ship in this same site
// bundle (DROP-070). GitHub still has its links in SiteNav/SiteFooter.

const AGENTS = ['Claude', 'Claude Code', 'Codex', 'Cursor', 'Cline', 'Windsurf'];

// Outcome metrics, not mechanism metrics — "5 runtimes supported" told a
// non-technical reader nothing about what they get.
//
// Every one of these must be something the code actually guarantees. The tile
// this replaced said "~8s from folder to live URL", inherited from an older
// version of the page, and no measurement anywhere in the repo backed it — the
// platform's own `readinessTimeoutMs` budget is 60s (platform.ts), raised under
// DROP-063 precisely because healthy apps were being failed at 20s. Deploy
// speed is also a developer metric: a business reader deploys rarely, so it
// optimised for the thing they experience least. Don't put a number here you
// cannot point at code or a measurement for.
const STATS: { v: string; l: string }[] = [
  { v: '0', l: 'DevOps hires needed' },
  { v: '0', l: 'setup files to write' },
  { v: '1', l: 'server runs every app you build' },
  { v: '24/7', l: 'crashed apps restart themselves' },
];

const MCP_TOOLS = [
  'deploy_files',
  'deploy_from_git',
  'list_apps',
  'app_status',
  'app_logs',
  'get_deploy_logs',
  'restart_app',
];

const RUNTIMES = [
  'Node.js',
  'Python',
  'Go',
  'Docker',
  'Static',
  'Next.js',
  'Nuxt',
  'SvelteKit',
  'Astro',
  'FastAPI',
  'Flask',
];

const RT_CHIPS = ['Node.js', 'Python', 'Go', 'Docker', 'Static'];

const STEPS: { n: string; tag: string; title: string; body: string }[] = [
  {
    n: '01',
    tag: 'DROP',
    title: 'Hand it a folder',
    body: 'Point DROP at the project folder your developer gives you. There is no file to write first and no form to fill in.',
  },
  {
    n: '02',
    tag: 'DETECT',
    title: 'It works out the rest',
    body: 'DROP recognises what the app is built with, installs everything it needs, and builds it the way that project expects to be built.',
  },
  {
    n: '03',
    tag: 'DEPLOY',
    title: 'You get a link',
    body: 'The app is online at its own web address, with a valid HTTPS certificate, and it is restarted automatically if it ever falls over.',
  },
];

// Who it's for, in the reader's own words. Each card names the situation the
// reader is actually in and what DROP takes off the invoice — "what it
// replaces" is the question a business reader is really asking.
const AUDIENCES: {
  key: string;
  icon: JSX.Element;
  who: string;
  body: string;
  replaces: string;
}[] = [
  {
    key: 'founder',
    icon: <Briefcase size={17} style={{ color: 'var(--accent)' }} />,
    who: 'Founders & small business owners',
    body: 'Your developer says the app is finished, then adds: “we just need to sort out hosting.” That sentence is a whole other project. This is that project, already done.',
    replaces: 'paying someone to set up servers',
  },
  {
    key: 'agency',
    icon: <Users size={17} style={{ color: 'var(--accent)' }} />,
    who: 'Agencies & freelance dev shops',
    body: 'Twelve client projects should not mean twelve hosting bills and twelve control panels. Run them all on one server, each with its own domain, database and logs.',
    replaces: 'a separate hosting plan per client',
  },
  {
    key: 'lead',
    icon: <Building2 size={17} style={{ color: 'var(--accent)' }} />,
    who: 'Technical leads at small companies',
    body: 'You need a platform team you are never going to get headcount for. DROP is the part of one that actually earns its keep, without adopting Kubernetes to get there.',
    replaces: 'a platform team, or Kubernetes',
  },
  {
    key: 'agents',
    icon: <Bot size={17} style={{ color: 'var(--accent)' }} />,
    who: 'Anyone building with AI assistants',
    body: 'Claude, Cursor and Codex can deploy to DROP themselves. You describe the change, the assistant ships it and reads the logs back to you when something looks wrong.',
    replaces: 'pasting the assistant’s output into a terminal',
  },
];

const HOSTED_POINTS = [
  'Nothing to install, nothing to maintain',
  'Someone else handles updates and backups',
  'Currently invitation-only',
];

const SELFHOST_POINTS = [
  'Runs on a small Linux VPS',
  'Your code and customer data stay on your machine',
  'MIT licensed, and the source is public',
];

const CONFIG_POINTS = [
  'Pin the app type & build/start commands',
  'Custom per-app domains',
  'Inject environment variables',
  'Declare required secrets (auto-generated or prompted)',
  'Attach Postgres & Redis',
];

const CLI_CMDS: { cmd: string; desc: string }[] = [
  { cmd: 'deploy ./app', desc: 'ship it' },
  { cmd: 'logs myapp', desc: 'tail logs' },
  { cmd: 'list', desc: 'list apps' },
  { cmd: 'status myapp', desc: 'app status' },
];

// Mirrors the real dashboard nav (src/dashboard/src/components/Layout.tsx) —
// a product shot promising sections that do not exist is a support ticket.
const DASH_NAV: { label: string; active?: boolean }[] = [
  { label: 'Apps', active: true },
  { label: 'Deploy' },
  { label: 'Users' },
  { label: 'Settings' },
];

const DASH_STATS: { l: string; v: string }[] = [
  { l: 'Online', v: '5/5' },
  { l: 'Req/min', v: '2.4k' },
  { l: 'Avg CPU', v: '4.2%' },
];

const DASH_ROWS: { name: string; meta: string; cpu: string; dot: string }[] = [
  { name: 'myapp', meta: ':4310 · node', cpu: '0.4%', dot: '#39D98A' },
  { name: 'api-gateway', meta: ':4311 · docker', cpu: '1.2%', dot: '#39D98A' },
  { name: 'analytics', meta: ':4312 · python', cpu: '3.8%', dot: '#FEBC2E' },
  { name: 'docs-site', meta: ':4313 · static', cpu: '0.0%', dot: '#39D98A' },
];

/* ------------------------------------------------------------------ */
/* Shared bits of the design system, so the new sections match the old */
/* ------------------------------------------------------------------ */

const eyebrowStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: 2,
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 14,
};

const primaryBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--mono)',
  fontWeight: 600,
  fontSize: 14,
  background: 'linear-gradient(180deg,var(--accent-2),var(--accent))',
  color: 'var(--accent-ink)',
  padding: '13px 22px',
  borderRadius: 11,
  boxShadow: 'var(--btn)',
  border: 'none',
  cursor: 'pointer',
};

const secondaryBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontFamily: 'var(--mono)',
  fontWeight: 500,
  fontSize: 14,
  background: 'var(--bg-3)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  padding: '13px 22px',
  borderRadius: 11,
};

/** Small mono line under a plain-English claim — the technical proof. */
function ProofLine({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)', marginTop: 10 }}>
      {children}
    </div>
  );
}

function HeroSection({ onEnter }: HeroProps): JSX.Element {
  return (
    <section style={{ position: 'relative', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(58% 55% at 72% 12%,color-mix(in srgb,var(--accent) 20%,transparent),transparent 72%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px)',
          backgroundSize: '54px 54px',
          WebkitMaskImage: 'radial-gradient(75% 60% at 50% 0%,#000,transparent 78%)',
          maskImage: 'radial-gradient(75% 60% at 50% 0%,#000,transparent 78%)',
          pointerEvents: 'none',
        }}
      />
      <div
        className="dl-grid-hero"
        style={{
          position: 'relative',
          maxWidth: 1200,
          margin: '0 auto',
          padding: '84px 28px 76px',
          display: 'grid',
          gridTemplateColumns: '1.05fr 1fr',
          gap: 52,
          alignItems: 'center',
        }}
      >
        <div>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 9,
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--text-2)',
              border: '1px solid var(--border)',
              background: 'var(--bg-3)',
              borderRadius: 999,
              padding: '6px 8px 6px 12px',
              marginBottom: 26,
            }}
          >
            <span style={{ color: 'var(--accent)' }}>New</span>
            <span style={{ width: 1, height: 12, background: 'var(--border)' }} />
            Your AI assistant can deploy for you
            <span style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 999, padding: '2px 8px' }}>
              →
            </span>
          </div>
          <h1
            className="dl-hero-h1"
            style={{
              fontFamily: 'var(--mono)',
              fontWeight: 700,
              fontSize: 60,
              lineHeight: 1,
              letterSpacing: -2,
              marginBottom: 22,
            }}
          >
            Get your app online<br />
            without{' '}
            <span
              style={{
                background: 'linear-gradient(120deg,var(--accent),var(--accent-2))',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                color: 'transparent',
              }}
            >
              hiring anyone
            </span>
            <br />
            to run servers.
          </h1>
          <p style={{ fontSize: 18, color: 'var(--text-2)', maxWidth: 470, marginBottom: 18, lineHeight: 1.6 }}>
            DROP takes a folder of code and puts it on the internet. It arrives with its own web address, a security
            certificate, a database and round-the-clock monitoring. There is no server to configure and no hosting
            console to learn.
          </p>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--text-3)', marginBottom: 28 }}>
            Node · Python · Go · Docker · static. Detected automatically, no Dockerfile required.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 26 }}>
            <a href={REQUEST_ACCESS_URL} target="_blank" rel="noopener noreferrer" style={primaryBtnStyle}>
              Request access →
            </a>
            {/* The second audience this page has always had but never served:
                the reader who wants to run it on their own box. Without this,
                the only route off the hero was an invitation-only waitlist. */}
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="dl-hover-border"
              style={secondaryBtnStyle}
            >
              Download &amp; self-host
            </a>
            {/* Same site bundle (DROP-070) — an in-page anchor, not a
                cross-bundle jump. */}
            <a href="#how-it-works" className="dl-hover-border" style={secondaryBtnStyle}>
              See how it works
            </a>
          </div>
          <button
            type="button"
            onClick={onEnter}
            className="dl-hover-text"
            style={{
              display: 'block',
              fontFamily: 'var(--mono)',
              fontSize: 13,
              color: 'var(--text-2)',
              background: 'none',
              border: 'none',
              padding: 0,
              marginBottom: 20,
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            Already have an account? Sign in
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.5, color: 'var(--text-3)' }}>
              WORKS WITH
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {AGENTS.map((a) => (
                <span
                  key={a}
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    color: 'var(--text-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 7,
                    padding: '4px 10px',
                    background: 'var(--bg-2)',
                  }}
                >
                  {a}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              inset: '-8% -6%',
              background:
                'radial-gradient(50% 50% at 50% 40%,color-mix(in srgb,var(--accent) 26%,transparent),transparent 70%)',
              filter: 'blur(8px)',
              pointerEvents: 'none',
            }}
          />
          {/* Terminal + the overhanging "deployed by an assistant" badge share
              their own positioning context, so the caption below can never be
              what the badge is anchored against. */}
          <div style={{ position: 'relative' }}>
          <div
            style={{
              position: 'relative',
              borderRadius: 15,
              overflow: 'hidden',
              border: '1px solid var(--border)',
              background: 'var(--panel)',
              boxShadow: 'var(--elev)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 16px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg-2)',
              }}
            >
              <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#FF5F57', display: 'inline-block' }} />
              <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#FEBC2E', display: 'inline-block' }} />
              <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#28C840', display: 'inline-block' }} />
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>~/projects — drop</span>
            </div>
            <div style={{ padding: 22, fontFamily: 'var(--mono)', fontSize: 13.5, lineHeight: 1.95 }}>
              <div>
                <span style={{ color: 'var(--accent)' }}>$</span> <span style={{ color: 'var(--text)' }}>drop deploy ./myapp</span>
              </div>
              <div style={{ color: 'var(--text-2)' }}>
                <span style={{ color: 'var(--accent-2)' }}>→</span> Detecting app type…{' '}
                <span style={{ color: 'var(--text)' }}>Next.js 15</span> <span style={{ color: 'var(--ok)' }}>✓</span>
              </div>
              <div style={{ color: 'var(--text-2)' }}>
                <span style={{ color: 'var(--accent-2)' }}>→</span> Provisioning PostgreSQL…{' '}
                <span style={{ color: 'var(--text)' }}>DATABASE_URL</span> <span style={{ color: 'var(--ok)' }}>✓</span>
              </div>
              <div style={{ color: 'var(--text-2)' }}>
                {/* A plausible figure for a Next.js install+build, not a
                    flattering one. The old 8.2s matched the "~8s median
                    deploy" stat that nothing in the repo measured. */}
                <span style={{ color: 'var(--accent-2)' }}>→</span> Building… done in <span style={{ color: 'var(--text)' }}>41.6s</span>
              </div>
              <div style={{ color: 'var(--text-2)' }}>
                <span style={{ color: 'var(--accent-2)' }}>→</span> Starting… <span style={{ color: 'var(--ok)' }}>online ✓</span>
              </div>
              <div style={{ marginTop: 8, color: 'var(--ok)' }}>
                ✔ Deployed →{' '}
                <button
                  type="button"
                  onClick={onEnter}
                  style={{
                    color: 'var(--accent)',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    margin: 0,
                    font: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  https://myapp.localhost
                </button>
                <span
                  className="dl-cursor"
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 15,
                    background: 'var(--accent)',
                    marginLeft: 6,
                    verticalAlign: -2,
                  }}
                />
              </div>
            </div>
          </div>
          <div
            className="dl-hide-sm"
            style={{
              position: 'absolute',
              bottom: -37,
              left: -22,
              display: 'flex',
              alignItems: 'center',
              gap: 11,
              padding: '12px 15px',
              border: '1px solid var(--border)',
              borderRadius: 12,
              background: 'var(--panel)',
              boxShadow: 'var(--elev)',
            }}
          >
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 30,
                height: 30,
                borderRadius: 9,
                background: 'linear-gradient(135deg,var(--accent),var(--accent-2))',
                color: 'var(--accent-ink)',
              }}
            >
              <Boxes size={16} style={{ color: 'var(--accent-ink)' }} />
            </span>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)' }}>
                deployed by an assistant
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ok)' }}>✔ api.localhost · deployed</div>
            </div>
          </div>
          </div>
          {/* Clearance for the badge's overhang, carrying the same dl-hide-sm
              as the badge — so when the badge is hidden below 960px the gap
              disappears with it instead of leaving dead space. */}
          <div className="dl-hide-sm" style={{ height: 30 }} />
          {/* Plain-English caption so the terminal is not an opaque black box
              to a non-technical reader. */}
          <p style={{ marginTop: 22, fontSize: 13, color: 'var(--text-3)', textAlign: 'center' }}>
            That is the entire deployment. One command, and the app is online.
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 28px 24px' }}>
        <div
          className="dl-grid-4"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4,1fr)',
            border: '1px solid var(--border)',
            borderRadius: 14,
            background: 'var(--bg-2)',
            overflow: 'hidden',
          }}
        >
          {STATS.map((s) => (
            <div key={s.l} style={{ padding: '20px 22px', borderRight: '1px solid var(--border)' }}>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 24, letterSpacing: -0.5, color: 'var(--text)' }}>
                {s.v}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-3)', marginTop: 3 }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * "What you get" — the old FeaturesBento, re-led in plain English with the
 * mechanism kept underneath as a `ProofLine`. Keeps `id="features"` because
 * SiteNav and SiteFooter both anchor to it.
 */
function WhatYouGet(): JSX.Element {
  return (
    <section id="features" style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px' }}>
      <div style={{ marginBottom: 36, maxWidth: 660 }}>
        <div style={eyebrowStyle}>What you get</div>
        <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 38, letterSpacing: -1, marginBottom: 14 }}>
          Everything a live app needs, already switched on.
        </h2>
        <p style={{ fontSize: 16, color: 'var(--text-2)', lineHeight: 1.7 }}>
          This is not a list of things to set up. It is a list of things nobody on your side has to think about
          again.
        </p>
      </div>
      {/* `minmax(164px,auto)`, not a flat 164px: the plain-English copy is
          longer than the jargon it replaced and none of these cards clip, so a
          fixed row height spills text through the rounded border on desktop.
          (Below 960px landing.css already forces grid-auto-rows:auto.) */}
      <div className="dl-bento" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gridAutoRows: 'minmax(164px, auto)', gap: 14 }}>
        <div
          style={{
            gridColumn: 'span 2',
            gridRow: 'span 2',
            border: '1px solid var(--border)',
            borderRadius: 16,
            padding: 26,
            background: 'var(--bg-2)',
            boxShadow: 'var(--elev)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'linear-gradient(135deg,var(--accent),var(--accent-2))',
              color: 'var(--accent-ink)',
              marginBottom: 16,
            }}
          >
            <Rocket size={20} style={{ color: 'var(--accent-ink)' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 20, marginBottom: 8 }}>
            It goes live, and you configured nothing
          </div>
          <p style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 'auto', maxWidth: 340 }}>
            Point DROP at a folder. It works out what the app is, installs what it needs, builds it and starts it.
            No setup wizard, no checklist, no Dockerfile to write.
          </p>
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel)', padding: '13px 15px', fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--text-2)', marginTop: 18 }}>
            <span style={{ color: 'var(--accent)' }}>$</span> drop deploy ./app
            <br />
            <span style={{ color: 'var(--ok)' }}>✔ https://app.localhost</span>
          </div>
        </div>

        <div style={{ gridColumn: 'span 2', border: '1px solid var(--border)', borderRadius: 16, padding: 24, background: 'var(--bg-2)', boxShadow: 'var(--elev)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 34,
              height: 34,
              borderRadius: 9,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              marginBottom: 14,
            }}
          >
            <Lock size={18} style={{ color: 'var(--accent)' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 16, marginBottom: 7 }}>
            A real web address, with the padlock
          </div>
          <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
            Every app gets its own address and a valid HTTPS certificate, issued and renewed for it. Point your own
            domain name at it whenever you are ready.
          </p>
          <ProofLine>Caddy reverse proxy · Let&apos;s Encrypt · auto-renewed</ProofLine>
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 16, padding: 22, background: 'var(--bg-2)', boxShadow: 'var(--elev)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 9,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              marginBottom: 12,
            }}
          >
            <Database size={16} style={{ color: 'var(--accent)' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14.5, marginBottom: 6 }}>
            A database, already plugged in
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            Each app gets its own, connected before it starts. Nobody copies a password around.
          </p>
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 16, padding: 22, background: 'var(--bg-2)', boxShadow: 'var(--elev)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 9,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              marginBottom: 12,
            }}
          >
            <RefreshCw size={16} style={{ color: 'var(--accent)' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14.5, marginBottom: 6 }}>
            Change the code, it redeploys
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            Edit the files and DROP rebuilds and restarts the app on its own.
          </p>
        </div>

        <div
          style={{
            gridColumn: 'span 2',
            border: '1px solid var(--border)',
            borderRadius: 16,
            padding: 24,
            background: 'var(--bg-2)',
            boxShadow: 'var(--elev)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 34,
              height: 34,
              borderRadius: 9,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              marginBottom: 14,
            }}
          >
            <Layers size={18} style={{ color: 'var(--accent)' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 16, marginBottom: 7 }}>
            It runs whatever your developer built
          </div>
          <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 14 }}>
            Node, Python, Go, Docker and plain websites. It also recognises Next.js, Nuxt, SvelteKit, Astro, FastAPI
            and Flask without being told which one it is looking at.
          </p>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 'auto' }}>
            {RT_CHIPS.map((c) => (
              <span key={c} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 9px', background: 'var(--panel)' }}>
                {c}
              </span>
            ))}
          </div>
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 16, padding: 22, background: 'var(--bg-2)', boxShadow: 'var(--elev)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 9,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              marginBottom: 12,
            }}
          >
            <Repeat size={16} style={{ color: 'var(--accent)' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14.5, marginBottom: 6 }}>
            It picks itself back up
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            If an app crashes it is restarted automatically, day or night.
          </p>
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 16, padding: 22, background: 'var(--bg-2)', boxShadow: 'var(--elev)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 9,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              marginBottom: 12,
            }}
          >
            <ScrollText size={16} style={{ color: 'var(--accent)' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14.5, marginBottom: 6 }}>
            You can see what happened
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            Everything an app prints is kept and searchable, so a problem has an answer.
          </p>
        </div>
      </div>
    </section>
  );
}

/** Who it's for + what it replaces — the section a business reader looks for and never found. */
function WhoItsFor(): JSX.Element {
  return (
    <section id="who" style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px' }}>
      <div style={{ marginBottom: 36, maxWidth: 660 }}>
        <div style={eyebrowStyle}>Who it&apos;s for</div>
        <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 38, letterSpacing: -1, marginBottom: 14 }}>
          If one of these is you, this is the missing piece.
        </h2>
        <p style={{ fontSize: 16, color: 'var(--text-2)', lineHeight: 1.7 }}>
          DROP replaces the step between “the app is built” and “the app is online”, the one that usually needs a
          specialist.
        </p>
      </div>
      <div className="dl-grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {AUDIENCES.map((a) => (
          <div
            key={a.key}
            style={{
              display: 'flex',
              flexDirection: 'column',
              border: '1px solid var(--border)',
              borderRadius: 16,
              padding: 24,
              background: 'var(--bg-2)',
              boxShadow: 'var(--elev)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                borderRadius: 9,
                background: 'var(--accent-soft)',
                marginBottom: 14,
              }}
            >
              {a.icon}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 15, marginBottom: 10, lineHeight: 1.35 }}>
              {a.who}
            </div>
            <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.65, marginBottom: 18 }}>{a.body}</p>
            <div
              style={{
                marginTop: 'auto',
                paddingTop: 14,
                borderTop: '1px solid var(--border)',
              }}
            >
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 5 }}>
                Replaces
              </div>
              <div style={{ fontSize: 13, color: 'var(--text)' }}>{a.replaces}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorks(): JSX.Element {
  return (
    <section id="how-it-works" style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px 32px' }}>
      <div style={{ textAlign: 'center', marginBottom: 44 }}>
        <div style={eyebrowStyle}>How it works</div>
        <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 38, letterSpacing: -1 }}>
          Three steps. Nothing to fill in.
        </h2>
      </div>
      <div className="dl-grid-3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18 }}>
        {STEPS.map((s) => (
          <div key={s.n} style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 16, padding: 28, background: 'var(--bg-2)', boxShadow: 'var(--elev)' }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                borderRadius: 9,
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
                fontFamily: 'var(--mono)',
                fontWeight: 700,
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {s.n}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 1, color: 'var(--text-3)', marginBottom: 8 }}>
              {s.tag}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 19, marginBottom: 10 }}>{s.title}</div>
            <p style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.65 }}>{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Hosted vs self-hosted, side by side. Deliberately host-neutral: this bundle
 * is served by every DROP install, so the hosted column says "this instance",
 * never a specific domain.
 */
function TwoWaysToRun({ onEnter }: EnterProps): JSX.Element {
  const bullet = (text: string): JSX.Element => (
    <div key={text} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 14, color: 'var(--text-2)', lineHeight: 1.55 }}>
      <Check size={15} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 3 }} />
      {text}
    </div>
  );

  return (
    <section id="run" style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px' }}>
      <div style={{ marginBottom: 36, maxWidth: 660 }}>
        <div style={eyebrowStyle}>Two ways to run it</div>
        <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 38, letterSpacing: -1, marginBottom: 14 }}>
          Use someone else&apos;s DROP, or run your own.
        </h2>
        <p style={{ fontSize: 16, color: 'var(--text-2)', lineHeight: 1.7 }}>
          Same platform either way. The only question is who keeps the server running. You can start on one and
          move to the other.
        </p>
      </div>
      <div className="dl-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid var(--border)',
            borderRadius: 18,
            padding: 32,
            background: 'var(--bg-2)',
            boxShadow: 'var(--elev)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'var(--accent-soft)',
              marginBottom: 16,
            }}
          >
            <Cloud size={19} style={{ color: 'var(--accent)' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 21, marginBottom: 10 }}>
            Use a hosted DROP
          </div>
          <p style={{ fontSize: 14.5, color: 'var(--text-2)', lineHeight: 1.65, marginBottom: 20 }}>
            Deploy onto a DROP someone already runs: this one, or your company&apos;s. You never touch a server.
            Access here is by invitation while the platform is in beta; ask for one and we&apos;ll be in touch.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 26 }}>
            {HOSTED_POINTS.map(bullet)}
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
            <a href={REQUEST_ACCESS_URL} target="_blank" rel="noopener noreferrer" style={primaryBtnStyle}>
              Request access →
            </a>
            <button
              type="button"
              onClick={onEnter}
              className="dl-hover-text"
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 13,
                color: 'var(--text-2)',
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              Already have an account? Sign in
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid var(--border)',
            borderRadius: 18,
            padding: 32,
            background: 'var(--bg-2)',
            boxShadow: 'var(--elev)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'var(--accent-soft)',
              marginBottom: 16,
            }}
          >
            <Server size={19} style={{ color: 'var(--accent)' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 21, marginBottom: 10 }}>
            Run it on your own server
          </div>
          <p style={{ fontSize: 14.5, color: 'var(--text-2)', lineHeight: 1.65, marginBottom: 20 }}>
            One install script on any Linux machine. A small VPS is plenty for a portfolio of apps. Nothing leaves
            hardware you control, and there is no per-app fee because there is no bill but the server.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 26 }}>
            {SELFHOST_POINTS.map(bullet)}
          </div>
          <Link
            to="/docs#installation"
            className="dl-hover-border"
            style={{ ...secondaryBtnStyle, marginTop: 'auto', alignSelf: 'flex-start' }}
          >
            Installation guide →
          </Link>
        </div>
      </div>
    </section>
  );
}

function DashboardPreview({ onEnter }: EnterProps): JSX.Element {
  return (
    <section id="dashboard" style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px' }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 20, overflow: 'hidden', background: 'var(--bg-2)', boxShadow: 'var(--elev)' }}>
        <div style={{ padding: '44px 44px 8px', maxWidth: 640 }}>
          <div style={eyebrowStyle}>The dashboard</div>
          <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 32, letterSpacing: -0.5, marginBottom: 14 }}>
            One screen that answers &ldquo;is everything OK?&rdquo;
          </h2>
          <p style={{ fontSize: 15, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 22 }}>
            Which apps are up, how hard they are working, what they last printed, what changed and when, plus
            domains, passwords and databases. If you would rather click than type, everything the command line does
            is here too.
          </p>
          <button type="button" onClick={onEnter} style={{ ...primaryBtnStyle, padding: '12px 20px' }}>
            Open the dashboard →
          </button>
        </div>
        <div style={{ padding: '32px 44px 0' }}>
          <div
            style={{
              border: '1px solid var(--border)',
              borderTopLeftRadius: 14,
              borderTopRightRadius: 14,
              borderBottom: 0,
              background: 'var(--panel)',
              overflow: 'hidden',
              boxShadow: '0 -8px 40px rgba(0,0,0,.12)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 15px', borderBottom: '1px solid var(--border)', background: 'var(--bg-3)', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#FF5F57', display: 'inline-block' }} />
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#FEBC2E', display: 'inline-block' }} />
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#28C840', display: 'inline-block' }} />
              <span style={{ marginLeft: 8 }}>myapp.localhost/dashboard</span>
            </div>
            <div className="dl-grid-sidebar" style={{ display: 'grid', gridTemplateColumns: '180px 1fr', minHeight: 280 }}>
              <div style={{ borderRight: '1px solid var(--border)', padding: '16px 12px', background: 'var(--bg-2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, letterSpacing: 2 }}>
                  <span style={{ width: 13, height: 13, background: 'var(--accent)', borderRadius: '50% 50% 50% 2px', transform: 'rotate(45deg)' }} />
                  DROP
                </div>
                {DASH_NAV.map((n) => (
                  <div
                    key={n.label}
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      padding: '7px 10px',
                      borderRadius: 7,
                      marginBottom: 2,
                      color: n.active ? 'var(--text)' : 'var(--text-2)',
                      background: n.active ? 'var(--accent-soft)' : 'transparent',
                    }}
                  >
                    {n.label}
                  </div>
                ))}
              </div>
              <div style={{ padding: 18 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 16 }}>
                  {DASH_STATS.map((s) => (
                    <div key={s.l} style={{ border: '1px solid var(--border)', borderRadius: 9, padding: '12px 14px', background: 'var(--bg-2)' }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-3)' }}>
                        {s.l}
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 20, marginTop: 4 }}>{s.v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {DASH_ROWS.map((r) => (
                    <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px', border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg-2)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.dot, boxShadow: `0 0 8px ${r.dot}` }} />
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--text)', flex: 1 }}>{r.name}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>{r.meta}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)' }}>{r.cpu}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Explicit hand-off between the two audiences. A business reader is told they
 * can stop; a technical reader is told the proof starts here. Without this the
 * jargon below reads as the page failing rather than as an appendix.
 */
function TechnicalDivider(): JSX.Element {
  return (
    <section style={{ maxWidth: 1200, margin: '0 auto', padding: '64px 28px 8px' }}>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 44, maxWidth: 660 }}>
        <div style={eyebrowStyle}>For whoever will run it</div>
        <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 34, letterSpacing: -1, marginBottom: 14 }}>
          The technical part.
        </h2>
        <p style={{ fontSize: 16, color: 'var(--text-2)', lineHeight: 1.7 }}>
          If you were deciding whether DROP is for you, you already have what you need. Everything below is for the
          person who will actually operate it: what it detects, how to override it, and how to drive it from a
          terminal or an AI assistant.
        </p>
      </div>
    </section>
  );
}

function RuntimesStrip(): JSX.Element {
  return (
    <section id="runtimes" style={{ maxWidth: 1200, margin: '0 auto', padding: '36px 28px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 22,
          flexWrap: 'wrap',
          justifyContent: 'center',
          padding: '20px 28px',
          border: '1px solid var(--border)',
          borderRadius: 14,
          background: 'var(--bg-2)',
        }}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-3)' }}>
          Detects &amp; runs
        </span>
        {RUNTIMES.map((r) => (
          <span key={r} style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 500, color: 'var(--text-2)' }}>
            {r}
          </span>
        ))}
      </div>
    </section>
  );
}

function ConfigSection(): JSX.Element {
  return (
    <section
      id="config"
      className="dl-grid-2"
      style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48, alignItems: 'center' }}
    >
      <div>
        <div style={eyebrowStyle}>Escape hatch</div>
        <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 32, letterSpacing: -0.5, marginBottom: 16 }}>
          Zero config by default. Full control when you want it.
        </h2>
        <p style={{ fontSize: 15, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 20 }}>
          Most apps need nothing at all. For the rest, drop a <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>drop.yaml</span>{' '}
          in the folder to pin the app type, claim domains, set env, declare the secrets it can&apos;t start without,
          and attach a database. Unknown keys are rejected, so a typo fails loudly instead of doing nothing.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {CONFIG_POINTS.map((c) => (
            <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: 'var(--text-2)' }}>
              <span style={{ color: 'var(--accent)' }}>▸</span>
              {c}
            </div>
          ))}
        </div>
      </div>
      {/* This sample is pinned byte-for-byte by
          src/core/detector/documented-samples.test.ts ('landing: escape-hatch
          drop.yaml') — a published sample the parser rejects has shipped
          before. Change it there in the same commit or not at all. */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', background: 'var(--panel)', boxShadow: 'var(--elev)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-2)', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
          drop.yaml
        </div>
        <pre style={{ margin: 0, padding: 22, fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.85, color: 'var(--text-2)', overflow: 'auto' }}>
          <span style={{ color: 'var(--accent-2)' }}>name</span>: <span style={{ color: 'var(--ok)' }}>myapp</span>
          {'\n'}
          <span style={{ color: 'var(--accent-2)' }}>type</span>: <span style={{ color: 'var(--ok)' }}>nodejs</span>
          {'\n'}
          <span style={{ color: 'var(--accent-2)' }}>domains</span>:{'\n'}
          {'  - '}
          <span style={{ color: 'var(--ok)' }}>app.example.com</span>
          {'\n'}
          <span style={{ color: 'var(--accent-2)' }}>database</span>: <span style={{ color: 'var(--ok)' }}>postgres</span>
          {'\n'}
          <span style={{ color: 'var(--accent-2)' }}>env</span>:{'\n'}
          {'  '}
          <span style={{ color: 'var(--accent-2)' }}>NODE_ENV</span>: <span style={{ color: 'var(--ok)' }}>production</span>
          {'\n'}
          <span style={{ color: 'var(--accent-2)' }}>secrets</span>:{'\n'}
          {'  '}
          <span style={{ color: 'var(--accent-2)' }}>JWT_SECRET</span>: <span style={{ color: 'var(--ok)' }}>generate</span>
        </pre>
      </div>
    </section>
  );
}

function CliSection(): JSX.Element {
  return (
    <section id="cli" style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px' }}>
      <div
        className="dl-grid-2"
        style={{ border: '1px solid var(--border)', borderRadius: 18, background: 'var(--bg-2)', boxShadow: 'var(--elev)', padding: 44, display: 'grid', gridTemplateColumns: '1fr 1.1fr', gap: 48, alignItems: 'center' }}
      >
        <div>
          <div style={eyebrowStyle}>Command line + API</div>
          <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 30, letterSpacing: -0.5, marginBottom: 16 }}>
            Install once. Deploy anything.
          </h2>
          <p style={{ fontSize: 15, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 22 }}>
            A full-featured CLI plus a REST API secured with JWT and API keys. Manage apps, logs, and domains from
            your terminal, your CI pipeline, or an AI agent.
          </p>
          <Link to="/reference" style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14, color: 'var(--accent)' }}>
            Full CLI &amp; API reference →
          </Link>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {CLI_CMDS.map((c) => (
            <div key={c.cmd} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel)', fontFamily: 'var(--mono)', fontSize: 13.5 }}>
              <span style={{ color: 'var(--accent)' }}>$</span>
              <span style={{ color: 'var(--text)', flex: 1 }}>
                <span style={{ color: 'var(--accent)' }}>drop</span> {c.cmd}
              </span>
              <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{c.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function McpSection(): JSX.Element {
  return (
    <section id="mcp" style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px' }}>
      <div className="dl-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1.02fr', gap: 48, alignItems: 'center' }}>
        <div>
          <div style={eyebrowStyle}>Deploy from an AI assistant</div>
          <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 38, letterSpacing: -1, marginBottom: 16 }}>
            Let the assistant do the deploy.
          </h2>
          <p style={{ fontSize: 16, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 16 }}>
            Say &ldquo;ship this folder&rdquo; to Claude, Codex or Cursor and it does, then reads the logs back to
            you if something went wrong. Nobody copies commands out of a chat window into a terminal.
          </p>
          <p style={{ fontSize: 14.5, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 24 }}>
            The technical version: DROP ships an MCP (Model Context Protocol) server, so any MCP client gets deploy,
            log and status calls as native tools. Header auth for clients that support it, and OAuth for the
            claude.ai connector, so nobody pastes an API key into a browser.
          </p>
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 12,
              overflow: 'hidden',
              background: 'var(--panel)',
              boxShadow: 'var(--elev)',
              marginBottom: 22,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 15px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg-2)',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--text-3)',
              }}
            >
              ~/.config/mcp.json<span style={{ flex: 1 }} /><span>copy</span>
            </div>
            <pre style={{ margin: 0, padding: '16px 18px', fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.75, color: 'var(--text-2)', overflow: 'auto' }}>
              {'{'}
              {'\n'}
              {'  '}
              <span style={{ color: 'var(--accent-2)' }}>&quot;mcpServers&quot;</span>: {'{'}
              {'\n'}
              {'    '}
              <span style={{ color: 'var(--accent-2)' }}>&quot;drop&quot;</span>: {'{'}
              {'\n'}
              {'      '}
              <span style={{ color: 'var(--accent-2)' }}>&quot;url&quot;</span>:{' '}
              <span style={{ color: 'var(--ok)' }}>&quot;https://your-host/api/v1/mcp&quot;</span>,{'\n'}
              {'      '}
              <span style={{ color: 'var(--accent-2)' }}>&quot;headers&quot;</span>: {'{ '}
              <span style={{ color: 'var(--accent-2)' }}>&quot;Authorization&quot;</span>:{' '}
              <span style={{ color: 'var(--ok)' }}>&quot;Bearer drop_&lt;your-api-key&gt;&quot;</span>
              {' }'}
              {'\n'}
              {'    '}
              {'}'}
              {'\n'}
              {'  '}
              {'}'}
              {'\n'}
              {'}'}
            </pre>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {MCP_TOOLS.map((t) => (
              <span
                key={t}
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  color: 'var(--text-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 7,
                  padding: '5px 10px',
                  background: 'var(--bg-2)',
                }}
              >
                <span style={{ color: 'var(--accent)' }}>›</span> {t}
              </span>
            ))}
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              inset: '-6%',
              background: 'radial-gradient(50% 50% at 60% 30%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 70%)',
              filter: 'blur(6px)',
              pointerEvents: 'none',
            }}
          />
          <div style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', boxShadow: 'var(--elev)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)', background: 'var(--bg-2)' }}>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  borderRadius: 8,
                  background: 'linear-gradient(135deg,var(--accent),var(--accent-2))',
                }}
              >
                <Sparkles size={15} style={{ color: 'var(--accent-ink)' }} />
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)' }}>Assistant</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 7px' }}>
                drop · mcp
              </span>
            </div>
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div
                style={{
                  alignSelf: 'flex-end',
                  maxWidth: '80%',
                  background: 'var(--accent-soft)',
                  border: '1px solid var(--border)',
                  borderRadius: '12px 12px 4px 12px',
                  padding: '11px 14px',
                  fontSize: 13.5,
                  color: 'var(--text)',
                }}
              >
                Deploy the <span style={{ fontFamily: 'var(--mono)' }}>./api</span> folder and attach a database.
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--text-2)' }}>On it. Deploying with DROP.</div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-2)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 13px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)' }}>
                  <Settings2 size={14} style={{ color: 'var(--accent)' }} /> called <span style={{ color: 'var(--accent)' }}>deploy_files</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: 'var(--ok)' }}>done</span>
                </div>
                <pre style={{ margin: 0, padding: '11px 13px', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.7, color: 'var(--text-3)' }}>
                  {'{ "path": "./api", "database": "postgres" }'}
                </pre>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  padding: '12px 14px',
                  border: '1px solid var(--border)',
                  borderLeft: '3px solid var(--ok)',
                  borderRadius: 10,
                  background: 'var(--bg-2)',
                }}
              >
                <span style={{ color: 'var(--ok)', fontFamily: 'var(--mono)' }}>✔</span>
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--text)' }}>https://api.localhost</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
                    FastAPI · Postgres · DATABASE_URL injected
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
                Your FastAPI service is live at <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>api.localhost</span>{' '}
                with a Postgres database attached and logs streaming to the dashboard.
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FinalCta(): JSX.Element {
  return (
    <section style={{ maxWidth: 1200, margin: '0 auto', padding: '56px 28px 88px' }}>
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          border: '1px solid var(--border)',
          borderRadius: 22,
          background: 'var(--bg-2)',
          boxShadow: 'var(--elev)',
          textAlign: 'center',
          padding: '76px 28px',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(55% 80% at 50% 0%,color-mix(in srgb,var(--accent) 22%,transparent),transparent 70%)',
            pointerEvents: 'none',
          }}
        />
        <div style={{ position: 'relative' }}>
          <span
            style={{
              display: 'inline-block',
              width: 30,
              height: 30,
              background: 'linear-gradient(135deg,var(--accent),var(--accent-2))',
              borderRadius: '50% 50% 50% 4px',
              transform: 'rotate(45deg)',
              boxShadow: '0 0 30px var(--accent)',
              marginBottom: 28,
            }}
          />
          <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 42, letterSpacing: -1.5, marginBottom: 16 }}>
            Drop a folder. Get a URL.
          </h2>
          <p style={{ fontSize: 17, color: 'var(--text-2)', maxWidth: 520, margin: '0 auto 30px', lineHeight: 1.6 }}>
            Ask for access to the hosted platform, or put DROP on your own server in an afternoon.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a
              href={REQUEST_ACCESS_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...primaryBtnStyle, padding: '14px 26px' }}
            >
              Request access
            </a>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="dl-hover-border"
              style={{ ...secondaryBtnStyle, padding: '14px 26px' }}
            >
              Download the latest release
            </a>
            <Link to="/docs#installation" className="dl-hover-border" style={{ ...secondaryBtnStyle, padding: '14px 26px' }}>
              Run it on your own server
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function LandingSections({ onEnter }: LandingSectionsProps): JSX.Element {
  return (
    <>
      <HeroSection onEnter={onEnter} />
      <WhatYouGet />
      <WhoItsFor />
      <HowItWorks />
      <TwoWaysToRun onEnter={onEnter} />
      <DashboardPreview onEnter={onEnter} />
      <TechnicalDivider />
      <RuntimesStrip />
      <ConfigSection />
      <CliSection />
      <McpSection />
      <FinalCta />
    </>
  );
}
