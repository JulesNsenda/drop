import {
  Boxes,
  Database,
  Layers,
  Lock,
  RefreshCw,
  Repeat,
  Rocket,
  ScrollText,
  Settings2,
  Sparkles,
} from 'lucide-react';

export interface LandingSectionsProps {
  onEnter: () => void;
  onSignup: () => void;
  authEnabled: boolean;
}

type EnterProps = Pick<LandingSectionsProps, 'onEnter'>;
type HeroProps = LandingSectionsProps;

const GITHUB_URL = 'https://github.com/JulesNsenda/drop';

const AGENTS = ['Claude', 'Claude Code', 'Codex', 'Cursor', 'Cline', 'Windsurf'];

const STATS: { v: string; l: string }[] = [
  { v: '~8s', l: 'median deploy' },
  { v: '0', l: 'config files needed' },
  { v: '4', l: 'runtimes supported' },
  { v: '100%', l: 'self-hosted' },
];

const MCP_TOOLS = ['deploy_files', 'deploy_from_git', 'list_apps', 'app_status', 'app_logs', 'restart_app'];

const RUNTIMES = ['Node.js', 'Python', 'Docker', 'Static', 'Next.js', 'Nuxt', 'Express', 'FastAPI', 'Flask'];

const RT_CHIPS = ['Node.js', 'Python', 'Docker', 'Static'];

const STEPS: { n: string; tag: string; title: string; body: string }[] = [
  {
    n: '01',
    tag: 'DROP',
    title: 'Drop a folder',
    body: 'Point DROP at any project directory. No Dockerfile, no build script, no config file to begin.',
  },
  {
    n: '02',
    tag: 'DETECT',
    title: 'Auto-detect & build',
    body: 'It recognizes the runtime and framework, then installs and builds automatically.',
  },
  {
    n: '03',
    tag: 'DEPLOY',
    title: 'Get a URL',
    body: 'Online at myapp.localhost with a persistent port, PM2 supervision, and automatic HTTPS.',
  },
];

const DASH_NAV: { label: string; active?: boolean }[] = [
  { label: 'Applications', active: true },
  { label: 'Deployments' },
  { label: 'Databases' },
  { label: 'Domains' },
  { label: 'Logs' },
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

const CONFIG_POINTS = [
  'Pin runtime & framework',
  'Custom per-app domains',
  'Inject environment variables',
  'Persistent data dirs (DROP_DATA_DIR)',
];

const CLI_CMDS: { cmd: string; desc: string }[] = [
  { cmd: 'deploy ./app', desc: 'ship it' },
  { cmd: 'logs myapp', desc: 'tail logs' },
  { cmd: 'list', desc: 'list apps' },
  { cmd: 'status myapp', desc: 'app status' },
];

function HeroSection({ onEnter, onSignup, authEnabled }: HeroProps): JSX.Element {
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
            Deploy from Claude, Codex & Cursor via MCP
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
            Drop a folder.<br />
            Get a{' '}
            <span
              style={{
                background: 'linear-gradient(120deg,var(--accent),var(--accent-2))',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                color: 'transparent',
              }}
            >
              URL.
            </span>
          </h1>
          <p style={{ fontSize: 18, color: 'var(--text-2)', maxWidth: 470, marginBottom: 30 }}>
            The lightweight, self-hosted PaaS built for one move: point it at a folder, and it auto-detects, builds,
            provisions a database, and ships. Node, Python, Docker, static — zero config.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 26 }}>
            <button
              type="button"
              onClick={onEnter}
              style={{
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
              }}
            >
              Start deploying →
            </button>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="dl-hover-border"
              style={{
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
              }}
            >
              Documentation
            </a>
          </div>
          {authEnabled && (
            <button
              type="button"
              onClick={onSignup}
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
              Create an account
            </button>
          )}
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
                <span style={{ color: 'var(--accent-2)' }}>→</span> Building… done in <span style={{ color: 'var(--text)' }}>8.2s</span>
              </div>
              <div style={{ color: 'var(--text-2)' }}>
                <span style={{ color: 'var(--accent-2)' }}>→</span> Starting via PM2… <span style={{ color: 'var(--ok)' }}>online ✓</span>
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
                deploy_files <span style={{ color: 'var(--text-3)' }}>via MCP</span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ok)' }}>✔ api.localhost · 8.2s</div>
            </div>
          </div>
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

function McpSection(): JSX.Element {
  return (
    <section id="mcp" style={{ maxWidth: 1200, margin: '0 auto', padding: '64px 28px' }}>
      <div className="dl-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1.02fr', gap: 48, alignItems: 'center' }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 14 }}>
            Model Context Protocol
          </div>
          <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 38, letterSpacing: -1, marginBottom: 16 }}>
            Ship straight from your AI agent.
          </h2>
          <p style={{ fontSize: 16, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 24 }}>
            DROP ships an MCP server, so Claude, Codex, Cursor and any MCP client can deploy, inspect logs, and manage
            apps as native tools. Say &quot;ship this repo&quot; — your agent does the rest.
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
              <span style={{ color: 'var(--ok)' }}>&quot;Bearer drop_sk_live_…&quot;</span>
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
              <div style={{ fontSize: 13.5, color: 'var(--text-2)' }}>On it — deploying with DROP.</div>
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

function RuntimesStrip(): JSX.Element {
  return (
    <section id="runtimes" style={{ maxWidth: 1200, margin: '0 auto', padding: '44px 28px' }}>
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

function HowItWorks(): JSX.Element {
  return (
    <section style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px 32px' }}>
      <div style={{ textAlign: 'center', marginBottom: 44 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 14 }}>
          How it works
        </div>
        <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 38, letterSpacing: -1 }}>
          Three steps. No YAML required.
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

function FeaturesBento(): JSX.Element {
  return (
    <section id="features" style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px' }}>
      <div style={{ marginBottom: 36, maxWidth: 640 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 14 }}>
          Features
        </div>
        <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 38, letterSpacing: -1, marginBottom: 14 }}>
          Everything a deploy needs. Nothing it doesn&apos;t.
        </h2>
        <p style={{ fontSize: 16, color: 'var(--text-2)' }}>
          Detection, build, routing, TLS, databases, processes and logs — handled, so your folder is the only config.
        </p>
      </div>
      <div className="dl-bento" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gridAutoRows: 164, gap: 14 }}>
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
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 20, marginBottom: 8 }}>Zero-config deployment</div>
          <p style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 'auto', maxWidth: 340 }}>
            Auto-detects the app type, builds, and starts it — no Dockerfile, no build script, no setup for most
            projects.
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
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 16, marginBottom: 7 }}>Automatic HTTPS &amp; routing</div>
          <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
            Reach apps at <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>*.localhost</span> via Caddy,
            with Let&apos;s Encrypt certificates provisioned and renewed automatically.
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
            <Database size={16} style={{ color: 'var(--accent)' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14.5, marginBottom: 6 }}>Postgres auto-provisioning</div>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            Each app gets its own DB with <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>DATABASE_URL</span> injected.
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
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14.5, marginBottom: 6 }}>Hot reload</div>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            Edit files and the app rebuilds and restarts on its own.
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
            Multi-runtime + framework detection
          </div>
          <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 14 }}>
            Node, Python, Docker and static sites — with Next.js, Nuxt, Express, FastAPI and Flask recognized
            automatically.
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
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14.5, marginBottom: 6 }}>PM2 process management</div>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            Reliable supervision with auto-restart on failure.
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
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14.5, marginBottom: 6 }}>Auto-capture logging</div>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            stdout/stderr saved to dated files and streamed live.
          </p>
        </div>
      </div>
    </section>
  );
}

function DashboardPreview({ onEnter }: EnterProps): JSX.Element {
  return (
    <section id="dashboard" style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px' }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 20, overflow: 'hidden', background: 'var(--bg-2)', boxShadow: 'var(--elev)' }}>
        <div style={{ padding: '44px 44px 8px', maxWidth: 620 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 14 }}>
            The dashboard
          </div>
          <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 32, letterSpacing: -0.5, marginBottom: 14 }}>
            A real-time UI for every app.
          </h2>
          <p style={{ fontSize: 15, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 22 }}>
            Live process health, streaming logs, per-app metrics, databases, domains and routing — all in one place
            at <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>/dashboard</span>. Everything the
            CLI and MCP do, visually.
          </p>
          <button
            type="button"
            onClick={onEnter}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: 'var(--mono)',
              fontWeight: 600,
              fontSize: 14,
              background: 'linear-gradient(180deg,var(--accent-2),var(--accent))',
              color: 'var(--accent-ink)',
              padding: '12px 20px',
              borderRadius: 11,
              boxShadow: 'var(--btn)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
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

function ConfigSection(): JSX.Element {
  return (
    <section
      id="config"
      className="dl-grid-2"
      style={{ maxWidth: 1200, margin: '0 auto', padding: '52px 28px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48, alignItems: 'center' }}
    >
      <div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 14 }}>
          Escape hatch
        </div>
        <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 32, letterSpacing: -0.5, marginBottom: 16 }}>
          Zero config by default. Full control when you want it.
        </h2>
        <p style={{ fontSize: 15, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 20 }}>
          80% of apps need nothing. For the rest, drop a <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>drop.yaml</span>{' '}
          to pin runtime, custom domains, env, and persistent data that survives upgrades.
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
      <div style={{ border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', background: 'var(--panel)', boxShadow: 'var(--elev)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-2)', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
          drop.yaml
        </div>
        <pre style={{ margin: 0, padding: 22, fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.85, color: 'var(--text-2)', overflow: 'auto' }}>
          <span style={{ color: 'var(--accent-2)' }}>name</span>: <span style={{ color: 'var(--ok)' }}>myapp</span>
          {'\n'}
          <span style={{ color: 'var(--accent-2)' }}>runtime</span>: <span style={{ color: 'var(--ok)' }}>node</span>
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
          <span style={{ color: 'var(--accent-2)' }}>persist</span>:{'\n'}
          {'  - '}
          <span style={{ color: 'var(--ok)' }}>./uploads</span>
          {'\n'}
          {'  - '}
          <span style={{ color: 'var(--ok)' }}>./data</span>
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
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 14 }}>
            Command line + API
          </div>
          <h2 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 30, letterSpacing: -0.5, marginBottom: 16 }}>
            Install once. Deploy anything.
          </h2>
          <p style={{ fontSize: 15, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 22 }}>
            A full-featured CLI plus a REST API secured with JWT and API keys. Manage apps, logs, and domains from
            your terminal, CI, or AI agent.
          </p>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14, color: 'var(--accent)' }}>
            Full CLI &amp; API reference →
          </a>
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

function FinalCta({ onEnter }: EnterProps): JSX.Element {
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
          <p style={{ fontSize: 17, color: 'var(--text-2)', maxWidth: 520, margin: '0 auto 30px' }}>
            Self-host DROP in minutes, then deploy from your terminal, the dashboard, or straight from your AI agent.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={onEnter}
              style={{
                fontFamily: 'var(--mono)',
                fontWeight: 600,
                fontSize: 14,
                background: 'linear-gradient(180deg,var(--accent-2),var(--accent))',
                color: 'var(--accent-ink)',
                padding: '14px 26px',
                borderRadius: 11,
                boxShadow: 'var(--btn)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Get started
            </button>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="dl-hover-border"
              style={{
                fontFamily: 'var(--mono)',
                fontWeight: 500,
                fontSize: 14,
                background: 'var(--bg-3)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                padding: '14px 26px',
                borderRadius: 11,
              }}
            >
              Read the docs
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

export function LandingSections({ onEnter, onSignup, authEnabled }: LandingSectionsProps): JSX.Element {
  return (
    <>
      <HeroSection onEnter={onEnter} onSignup={onSignup} authEnabled={authEnabled} />
      <McpSection />
      <RuntimesStrip />
      <HowItWorks />
      <FeaturesBento />
      <DashboardPreview onEnter={onEnter} />
      <ConfigSection />
      <CliSection />
      <FinalCta onEnter={onEnter} />
    </>
  );
}
