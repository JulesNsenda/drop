import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Layers, Plug, Rocket, Settings2 } from 'lucide-react';

/**
 * Docs content model (PRD-043).
 *
 * The docs page is a single long scrollable document, grouped into three
 * categories (mirrors `Docs.dc.html`: Getting started / Configuration /
 * Platform). `DOC_GROUPS` drives both the left section TOC and the right
 * "on this page" rail; `DocsBody` renders the actual prose.
 *
 * Copy is sourced from README.md, CLAUDE.md and docs/AGENT-DEPLOY.md so the
 * page doesn't drift from real platform behavior — no invented features.
 */

export interface DocItem {
  id: string;
  title: string;
}

export interface DocGroup {
  id: string;
  title: string;
  icon: ReactNode;
  items: DocItem[];
}

export const DOC_GROUPS: DocGroup[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    icon: <Rocket size={13} />,
    items: [
      { id: 'introduction', title: 'Introduction' },
      { id: 'installation', title: 'Installation' },
      { id: 'first-deploy', title: 'Your first deploy' },
    ],
  },
  {
    id: 'configuration',
    title: 'Configuration',
    icon: <Settings2 size={13} />,
    items: [
      { id: 'drop-yaml', title: 'drop.yaml' },
      { id: 'environment-variables', title: 'Environment variables' },
      { id: 'persistent-data', title: 'Persistent data' },
    ],
  },
  {
    id: 'platform',
    title: 'Platform',
    icon: <Layers size={13} />,
    items: [
      { id: 'runtimes', title: 'Runtimes & detection' },
      { id: 'routing-https', title: 'Routing & HTTPS' },
      { id: 'databases', title: 'Databases' },
      { id: 'logs', title: 'Logs' },
    ],
  },
  {
    id: 'integrations',
    title: 'Integrations',
    icon: <Plug size={13} />,
    items: [
      { id: 'claude-web', title: 'Connect Claude (web)' },
      { id: 'mcp-clients', title: 'Claude Code, Cursor & agents' },
    ],
  },
];

/** Flat, stable-reference list of every anchorable section id (used for scroll-spy). */
export const DOC_ITEM_IDS: string[] = DOC_GROUPS.flatMap(g => g.items.map(i => i.id));

const FLAT_ITEMS: DocItem[] = DOC_GROUPS.flatMap(g => g.items);

/* ------------------------------------------------------------------------ */
/* Shared prose styles                                                       */
/* ------------------------------------------------------------------------ */

const kickerStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: 1.5,
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 10,
};

const h2Style: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontWeight: 700,
  fontSize: 26,
  letterSpacing: -0.5,
  marginBottom: 14,
  color: 'var(--text)',
};

const h3Style: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontWeight: 600,
  fontSize: 15.5,
  marginTop: 24,
  marginBottom: 10,
  color: 'var(--text)',
};

const pStyle: CSSProperties = {
  fontSize: 15,
  color: 'var(--text-2)',
  lineHeight: 1.75,
  marginBottom: 14,
};

const ulStyle: CSSProperties = {
  margin: '0 0 16px',
  paddingLeft: 20,
  color: 'var(--text-2)',
  fontSize: 14.5,
  lineHeight: 1.85,
};

const olStyle: CSSProperties = {
  margin: '0 0 16px',
  paddingLeft: 20,
  color: 'var(--text-2)',
  fontSize: 14.5,
  lineHeight: 1.85,
};

const sectionStyle: CSSProperties = {
  paddingBottom: 48,
  marginBottom: 48,
  borderBottom: '1px solid var(--border)',
};

const linkStyle: CSSProperties = { fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--accent)' };

/* ------------------------------------------------------------------------ */
/* Small building blocks                                                     */
/* ------------------------------------------------------------------------ */

function CodeBlock({ label, code }: { label: string; code: string }): JSX.Element {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
        background: 'var(--panel)',
        margin: '18px 0',
      }}
    >
      <div
        style={{
          padding: '10px 15px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-2)',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--text-3)',
        }}
      >
        {label}
      </div>
      <pre
        style={{
          margin: 0,
          padding: '16px 18px',
          fontFamily: 'var(--mono)',
          fontSize: 13,
          lineHeight: 1.75,
          color: 'var(--text-2)',
          overflow: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {code}
      </pre>
    </div>
  );
}

function DocTable({ headers, rows }: { headers: string[]; rows: string[][] }): JSX.Element {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', margin: '16px 0' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
        <thead>
          <tr>
            {headers.map(h => (
              <th
                key={h}
                style={{
                  textAlign: 'left',
                  padding: '10px 14px',
                  background: 'var(--bg-2)',
                  borderBottom: '1px solid var(--border)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  color: 'var(--text-3)',
                  whiteSpace: 'nowrap',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row[0]}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: '10px 14px',
                    borderTop: '1px solid var(--border)',
                    color: j === 0 ? 'var(--text)' : 'var(--text-2)',
                    fontFamily: j === 0 ? 'var(--mono)' : 'inherit',
                    fontSize: j === 0 ? 12.5 : 13.5,
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }): JSX.Element {
  const color = tone === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '12px 15px',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 10,
        background: 'var(--bg-2)',
        fontSize: 13.5,
        color: 'var(--text-2)',
        lineHeight: 1.7,
        margin: '16px 0',
      }}
    >
      <span style={{ color, fontFamily: 'var(--mono)' }}>{tone === 'warn' ? '!' : 'i'}</span>
      <div>{children}</div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }): JSX.Element {
  return (
    <section id={id} style={sectionStyle}>
      <h2 style={h2Style}>{title}</h2>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* Left TOC + right "on this page" rail                                      */
/* ------------------------------------------------------------------------ */

export interface DocsNavProps {
  activeId: string;
  onNavigate: (id: string) => void;
}

export function DocsToc({ activeId, onNavigate }: DocsNavProps): JSX.Element {
  return (
    <nav aria-label="Documentation sections" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {DOC_GROUPS.map(group => (
        <div key={group.id}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              marginBottom: 8,
            }}
          >
            <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>{group.icon}</span>
            {group.title}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {group.items.map(item => {
              const active = item.id === activeId;
              return (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  onClick={e => {
                    e.preventDefault();
                    onNavigate(item.id);
                  }}
                  style={{
                    fontSize: 13,
                    padding: '6px 10px',
                    borderRadius: 7,
                    borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
                    color: active ? 'var(--text)' : 'var(--text-2)',
                    background: active ? 'var(--accent-soft)' : 'transparent',
                  }}
                >
                  {item.title}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

export function DocsRail({ activeId, onNavigate }: DocsNavProps): JSX.Element {
  return (
    <nav aria-label="On this page" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          letterSpacing: 1,
          textTransform: 'uppercase',
          color: 'var(--text-3)',
          marginBottom: 8,
        }}
      >
        On this page
      </div>
      {FLAT_ITEMS.map(item => {
        const active = item.id === activeId;
        return (
          <a
            key={item.id}
            href={`#${item.id}`}
            onClick={e => {
              e.preventDefault();
              onNavigate(item.id);
            }}
            style={{
              fontSize: 12.5,
              padding: '5px 0 5px 12px',
              borderLeft: active ? '2px solid var(--accent)' : '2px solid var(--border)',
              color: active ? 'var(--text)' : 'var(--text-3)',
            }}
          >
            {item.title}
          </a>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------------ */
/* Body content                                                              */
/* ------------------------------------------------------------------------ */

export function DocsBody(): JSX.Element {
  return (
    <article>
      <Section id="introduction" title="Introduction">
        <p style={pStyle}>
          <strong style={{ color: 'var(--text)' }}>DROP</strong> (Deploy, Run, Operate, Publish) is a lightweight,
          self-hosted Platform-as-a-Service built for one move: point it at a folder, and it detects the app type,
          installs dependencies, builds, provisions a database if the app needs one, and starts it. No Dockerfile,
          no build script, no config file for most projects.
        </p>
        <p style={pStyle}>
          <em>Drop a folder, get a URL. Zero configuration for 80% of use cases.</em>
        </p>
        <ul style={ulStyle}>
          <li>Zero-config deployment for Node.js, Python, Go, static sites, SPAs, and Docker</li>
          <li>
            Hostname routing (<code>myapp.localhost</code>) and automatic HTTPS via Caddy + Let&apos;s Encrypt
          </li>
          <li>Hot reload: edit files, DROP rebuilds and restarts on the same port</li>
          <li>
            PostgreSQL auto-provisioning with <code>DATABASE_URL</code> injected
          </li>
          <li>PM2-backed process management, a REST API, and a web dashboard</li>
          <li>Auto-captured logs, persistent per-app data directories, and custom domains</li>
          <li>Runs on Windows, Linux, and macOS</li>
        </ul>
        <p style={pStyle}>
          The rest of this page walks through installing DROP, deploying your first app, the optional{' '}
          <code>drop.yaml</code> config, and how the platform's runtimes, routing, databases, and logging work. For
          every CLI command and API endpoint, see the{' '}
          <Link to="/reference" style={linkStyle}>
            CLI &amp; API reference
          </Link>
          .
        </p>
      </Section>

      <Section id="installation" title="Installation">
        <p style={pStyle}>
          Requirements: <strong style={{ color: 'var(--text)' }}>Node.js 20+</strong>,{' '}
          <strong style={{ color: 'var(--text)' }}>npm 9+</strong>, and optionally{' '}
          <strong style={{ color: 'var(--text)' }}>Caddy 2.0+</strong> for hostname routing and automatic HTTPS.
        </p>
        <h3 style={h3Style}>Development / manual install</h3>
        <CodeBlock
          label="shell"
          code={`git clone https://github.com/JulesNsenda/drop.git
cd drop
npm install
# The dashboard is a separate package. Install its deps once:
(cd src/dashboard && npm install)
npm run build        # compiles the server AND builds the dashboard
npm link             # makes the 'drop' command available globally`}
        />
        <p style={pStyle}>
          If you only changed backend code, <code>npm run build:server</code> skips the dashboard build.
        </p>
        <Callout>
          On first start, DROP prints a one-time random admin password to the console. Change it immediately.
        </Callout>
        <h3 style={h3Style}>Production bootstrap</h3>
        <p style={pStyle}>
          For a real server, <code>install.sh --bootstrap</code> installs Node.js 20, PostgreSQL, Caddy, and a C
          toolchain, creates a dedicated system user, and registers a systemd service.{' '}
          <strong style={{ color: 'var(--text)' }}>without</strong> fetching or starting any application code. Wire
          it to a CI pipeline (or an scp'd build) to ship the actual code on every push.
        </p>
      </Section>

      <Section id="first-deploy" title="Your first deploy">
        <p style={pStyle}>
          Start the platform. DROP scaffolds its runtime directory on first launch and begins watching the apps
          folder:
        </p>
        <CodeBlock
          label="shell"
          code={`$ drop serve
[DROP] Starting DROP platform...
[DROP]   Apps directory: C:\\drop\\data\\webapps
[DROP] DROP platform started successfully`}
        />
        <p style={pStyle}>
          The root directory is <code>C:\drop</code> on Windows or <code>/var/drop</code> on Linux/macOS
          (overridable with <code>DROP_ROOT</code>). Apps live under <code>data/webapps/</code>. Copy any project
          folder in there:
        </p>
        <CodeBlock
          label="shell"
          code={`# Windows
xcopy my-app C:\\drop\\data\\webapps\\my-app\\ /E /I

# Linux/macOS
cp -r my-app /var/drop/data/webapps/`}
        />
        <p style={pStyle}>DROP automatically:</p>
        <ol style={olStyle}>
          <li>Detects the app type (Node.js, Python, static, Docker, …)</li>
          <li>Installs dependencies</li>
          <li>Builds the app</li>
          <li>Provisions a PostgreSQL database, if the app needs one</li>
          <li>Starts it on an assigned port</li>
        </ol>
        <p style={pStyle}>
          Reach it directly at <code>http://localhost:&lt;port&gt;</code>, or, with Caddy installed, at{' '}
          <code>http://my-app.localhost</code>. Edit any file in the app afterward and DROP detects the change,
          rebuilds, and restarts it on the same port automatically.
        </p>
        <p style={pStyle}>
          Everything here also works from the{' '}
          {/* The dashboard lives in a separate bundle at /dashboard/apps
              (DROP-070) — a react-router Link here would resolve within this
              site's own router (no /apps route, no basename) instead of
              crossing bundles, so this is a plain cross-origin-looking href. */}
          <a href="/dashboard/apps" style={linkStyle}>
            dashboard
          </a>{' '}
          or the CLI. See the{' '}
          <Link to="/reference" style={linkStyle}>
            CLI &amp; API reference
          </Link>{' '}
          for the full command list.
        </p>
      </Section>

      <Section id="drop-yaml" title="drop.yaml">
        <p style={pStyle}>
          Zero config covers most apps. For the rest, drop a <code>drop.yaml</code> in the app's root. DROP rejects
          any field that isn't in the schema below, so typos fail loudly instead of silently doing nothing.
        </p>
        <CodeBlock
          label="drop.yaml"
          code={`name: my-app
domains:
  - app.example.com
database: postgres
redis: true
env:
  NODE_ENV: production
build_env:
  VITE_API_BASE: /api
secrets:
  JWT_SECRET: generate
  STRIPE_KEY:
    required: true
    description: Live secret key from the Stripe dashboard
depends_on:
  - name: api
    env: API_URL
port: 4001
build: npm run build
start: node dist/server.js
healthCheck: /healthz
maxBodySize: 100MB
timeout: 30`}
        />
        <DocTable
          headers={['Field', 'Description']}
          rows={[
            ['name', 'Override the app name'],
            ['type', 'Skip detection and pin the app type (e.g. nodejs, static)'],
            ['domains', 'Custom hostnames routed to this app'],
            ['tls.certFile / tls.keyFile / tls.disabled', 'Bring your own certificate, or disable HTTPS for this app'],
            ['database', 'Provision a database for this app (e.g. postgres) and inject DATABASE_URL'],
            ['redis', 'Provision managed Redis: a per-app logical DB, injected as REDIS_URL'],
            ['env', 'Static environment variables, available at build and run time (string, number, or boolean)'],
            ['build_env', "Build-only variables, merged into the build and never into the running app. For values a bundler inlines (Vite's VITE_*) that shouldn't linger in the runtime env"],
            ['secrets', 'Declare the secrets this app cannot start without (see below)'],
            ['depends_on', "Inject another app's URL into an env var: { name, env, path? }"],
            ['port', 'Pin a specific port instead of auto-assignment'],
            ['build / start', 'Override the detected build/start command'],
            ['healthCheck', 'Path used for readiness checks'],
            ['maxBodySize', 'Max request body size for this app (e.g. 100MB)'],
            ['timeout', 'Request timeout in seconds'],
            ['group / services', 'Deploy several services from one repo (see Monorepos below)'],
            ['route', 'Mount this app under a path prefix on a shared group hostname: { path, strip? }'],
            ['mcp', 'Declare this app an MCP server: { path, auth } (see below)'],
          ]}
        />
        <p style={pStyle}>
          Unknown top-level or <code>tls</code> keys are rejected outright, and <code>drop.yaml</code> values never
          reach container run arguments or mount specs directly. It is config, not a code-execution surface.
        </p>

        <h3 style={h3Style}>Required secrets</h3>
        <p style={pStyle}>
          A missing <code>JWT_SECRET</code> normally shows up as a crash loop. Declare it under <code>secrets</code>{' '}
          and DROP resolves it <em>before</em> the app starts instead:
        </p>
        <DocTable
          headers={['Declaration', 'Behavior']}
          rows={[
            ['KEY: generate', 'DROP fills a strong random value if the secret is unset'],
            ['KEY: true (or "required")', 'Required, supplied by you'],
            ['KEY: { required, generate, description }', 'Long form; the description is shown in the dashboard prompt'],
          ]}
        />
        <p style={pStyle}>
          If a required secret has no value and cannot be generated, the app is parked in a{' '}
          <code>needs-config</code> status rather than started, and it appears that way in the dashboard, the API, and
          MCP tool results, naming the keys it is waiting for. Set them (dashboard, or{' '}
          <code>PUT /api/v1/secrets/:name</code>) and restart.
        </p>

        <h3 style={h3Style}>Monorepos</h3>
        <p style={pStyle}>
          A repo holding a backend and a frontend deploys as one unit. The root <code>drop.yaml</code> names a{' '}
          <code>group</code> and lists <code>services</code>; each service becomes its own app, and they share one
          hostname, so the frontend can call the backend same-origin at <code>/api</code>, with no CORS:
        </p>
        <CodeBlock
          label="drop.yaml"
          code={`group: ezsign
services:
  frontend:
    path: frontend
    build: npm run build
    route:
      path: /
  backend:
    path: backend
    database: postgres
    route:
      path: /api
      strip: false`}
        />
        <p style={pStyle}>
          Both are then reachable under <code>ezsign.&lt;your-domain&gt;</code>. Each service entry accepts most of
          the per-app fields above: <code>type</code>, <code>build</code>, <code>start</code>, <code>env</code>,{' '}
          <code>build_env</code>, <code>secrets</code>, <code>database</code>, <code>redis</code>,{' '}
          <code>healthCheck</code>, <code>domains</code>, and <code>depends_on</code>.
        </p>

        <h3 style={h3Style}>Apps that are MCP servers</h3>
        <p style={pStyle}>
          If your app speaks MCP, declare it and DROP surfaces its endpoint in the dashboard:
        </p>
        <CodeBlock label="drop.yaml" code={`mcp:\n  path: /mcp      # default\n  auth: drop      # or 'none' (the default)`} />
        <p style={pStyle}>
          <code>auth: none</code> means DROP does not guard the endpoint, so it is public unless your app authenticates
          callers itself, and the dashboard says so plainly. <code>auth: drop</code> puts DROP's OAuth in front of it:
          callers present a token audienced at <em>that</em> app, and only DROP users who can access the app get
          through. Opting in is your decision; DROP never infers it.
        </p>
      </Section>

      <Section id="environment-variables" title="Environment variables">
        <h3 style={h3Style}>Platform variables</h3>
        <DocTable
          headers={['Variable', 'Default', 'Description']}
          rows={[
            ['DROP_ROOT', 'C:\\drop or /var/drop', 'Base directory for all platform state'],
            ['DROP_APPS_DIR', '{root}/data/webapps', 'Apps directory watched for deploys'],
            ['DROP_API_PORT', '3000', 'Port for the REST API and dashboard'],
            ['DROP_LOG_LEVEL', 'info', 'Log level: debug, info, warn, error'],
            ['DROP_PUBLIC_URL', '(unset)', 'The public HTTPS origin of this DROP. Required for the claude.ai connector, since every OAuth endpoint fails closed without it, rather than trusting the Host header'],
            ['DROP_DISABLE_AUTH', 'false', 'Turn API auth off entirely (single-operator boxes). Auth is on by default'],
            ['DROP_ISOLATION', 'none', 'Runtime isolation mode: none runs apps under PM2, docker runs each in a container'],
            ['DROP_ENABLE_REDIS', 'true', 'Run the bundled managed Redis'],
            ['DROP_MAX_APPS_PER_USER', '5', 'Default per-user app quota; a per-user override wins, and admins are unlimited. Companion limits exist for disk, memory, CPU, and databases'],
          ]}
        />
        <h3 style={h3Style}>Injected into every app</h3>
        <DocTable
          headers={['Variable', 'Description']}
          rows={[
            ['PORT', 'The port assigned to the app. Bind to this, not a hardcoded port'],
            ['DROP_DATA_DIR', 'Persistent data directory that survives redeploys (see below)'],
            ['DATABASE_URL', 'PostgreSQL connection string, only if a database was provisioned'],
            ['REDIS_URL', "Managed Redis connection string, only if the app's drop.yaml asked for redis: true"],
            ['DROP_API_URL', "Base URL for DROP's own REST API: http://drop-host:<apiPort> under docker isolation, http://127.0.0.1:<apiPort> otherwise"],
            ['DROP_API_KEY', "Least-privilege, scoped API key for calling DROP's own API, injected only for apps an admin has granted capabilities (never a full admin key)"],
          ]}
        />
        <p style={pStyle}>
          On top of those, DROP injects any per-app secrets set via the secrets API/dashboard, static values from{' '}
          <code>drop.yaml</code>'s <code>env</code> block, and <code>depends_on</code>-resolved URLs from other apps.
          Values in <code>build_env</code> are the exception: they reach the build and stop there.
        </p>
      </Section>

      <Section id="persistent-data" title="Persistent data">
        <p style={pStyle}>
          Every app gets a persistent data directory that survives source-code upgrades and redeploys, at{' '}
          <code>data/appdata/&lt;app&gt;/</code>. Its path is injected as <code>DROP_DATA_DIR</code>:
        </p>
        <CodeBlock
          label="app.js"
          code={`const dataDir = process.env.DROP_DATA_DIR;
const uploadsPath = path.join(dataDir, 'uploads', filename);`}
        />
        <p style={pStyle}>
          Typical layout: <code>uploads/</code> for user-uploaded files, <code>logs/</code> for custom app logs, and{' '}
          <code>cache/</code> for anything disposable. Anything written outside <code>DROP_DATA_DIR</code>, inside
          the app's own source folder, is not guaranteed to survive a redeploy.
        </p>
      </Section>

      <Section id="runtimes" title="Runtimes &amp; framework detection">
        <p style={pStyle}>
          On every deploy, DROP runs a detector chain in priority order (manifest override → Node.js → Python → Go →
          Docker → static) and takes the best match. Static sits last on purpose: it's the fallback, so a project
          that is also something else is never mistaken for one.
        </p>
        <DocTable
          headers={['Type', 'Detected by', 'What DROP does']}
          rows={[
            ['Node.js', 'package.json', 'npm install + runs the start script'],
            ['Next.js', 'next.config.*', 'npm install + npm run build + starts'],
            ['Express / Fastify / Hono', 'Dependencies in package.json', 'npm install + runs the start script'],
            ['Python', 'requirements.txt, pyproject.toml, setup.py, or Pipfile', 'Creates a venv, installs, and runs the entry point (app.py, main.py, wsgi.py, manage.py, …)'],
            ['FastAPI / Flask / Django', 'Declared dependencies', 'Installed and started with the right server for the framework'],
            ['Go', 'go.mod', 'go build + runs the binary; gin, fiber, echo, chi, gorilla and others are recognised'],
            ['Docker', 'Dockerfile', 'docker build + docker run'],
            ['Static site', 'index.html (root or a build output dir)', 'Served with the built-in static server'],
            ['SPA', 'index.html + a framework', 'Served with SPA fallback routing'],
          ]}
        />
        <p style={pStyle}>
          Each app type has a dedicated build strategy for install/build, so framework-specific quirks (Next.js
          builds, FastAPI/Flask entry points, etc.) are handled without any config from you.
        </p>
      </Section>

      <Section id="routing-https" title="Routing &amp; HTTPS">
        <p style={pStyle}>
          When Caddy is installed, DROP configures hostname-based routing automatically, and each deployed app gets a{' '}
          <code>.localhost</code> hostname that modern browsers resolve without editing <code>/etc/hosts</code>:
        </p>
        <CodeBlock
          label="routing"
          code={`my-app.localhost  →  localhost:3001
api.localhost     →  localhost:3002`}
        />
        <DocTable
          headers={['Scenario', 'Behavior']}
          rows={[
            ['Caddy installed', 'Apps accessible at myapp.localhost'],
            ['Caddy not installed', 'Apps still accessible at localhost:PORT'],
            ['Port 80 in use', 'Warning logged; direct port access still works'],
          ]}
        />
        <h3 style={h3Style}>Automatic HTTPS</h3>
        <p style={pStyle}>DROP provisions and renews Let's Encrypt certificates with zero extra configuration:</p>
        <CodeBlock label="shell" code={`drop serve --domain example.com --https --acme-email admin@example.com`} />
        <p style={pStyle}>
          For wildcard certificates (<code>*.example.com</code>), use a DNS-01 challenge. Supported providers:{' '}
          <code>cloudflare</code>, <code>route53</code>, <code>digitalocean</code>, <code>godaddy</code>.
        </p>
        <CodeBlock
          label="shell"
          code={`export CF_API_TOKEN=your-cloudflare-token
drop serve --domain example.com --https --wildcard --dns-provider cloudflare`}
        />
        <p style={pStyle}>
          Individual apps can also claim their own hostnames via <code>domains</code> in <code>drop.yaml</code> (see{' '}
          <a href="#drop-yaml" style={linkStyle}>
            drop.yaml
          </a>
          ).
        </p>
      </Section>

      <Section id="databases" title="Databases">
        <p style={pStyle}>
          DROP bundles its own PostgreSQL, but it is a runtime service <em>for your deployed apps</em>, not where
          the platform stores its own state (that lives in flat files under <code>data/drop-svc/</code>). When an app
          needs a database, DROP provisions a dedicated one and injects <code>DATABASE_URL</code>:
        </p>
        <DocTable
          headers={['DROP provisions when…', 'Details']}
          rows={[
            ['drop.yaml says database: postgres', 'The explicit form. Always wins, and the only way to ask for one from a non-Node app'],
            ['A Postgres client or ORM is in package.json', 'pg, pg-promise, postgres, slonik, @prisma/client, prisma, drizzle-orm, knex, sequelize, typeorm, objection, @mikro-orm/postgresql, in dependencies or devDependencies'],
            ['An ORM config file is present', 'prisma/schema.prisma, drizzle.config.*, knexfile.*, ormconfig.json, typeorm.config.ts, sequelize.config.js, .sequelizerc'],
          ]}
        />
        <Callout tone="warn">
          A <strong style={{ color: 'var(--text)' }}>MySQL, MongoDB or SQLite</strong> driver does not trigger
          provisioning. DROP only runs PostgreSQL, and a <code>postgres://</code> URL an app cannot use would be
          worse than none. Those apps bring their own database. Detection also reads{' '}
          <code>package.json</code> only, so a Python or Go app asks with <code>database: postgres</code> in{' '}
          <code>drop.yaml</code>. (<code>database: sqlite</code> is accepted, but provisions PostgreSQL and logs a
          warning, since DROP has no SQLite provisioner.)
        </Callout>
        <p style={pStyle}>
          Provisioning happens when an app is <em>deployed</em>, not on a plain restart, so an app that only just
          became database-shaped needs a redeploy, not a <code>restart</code>. And if your per-user database quota
          is already full, the app still starts, but without a <code>DATABASE_URL</code>: check the platform log for
          a quota warning if one goes missing.
        </p>
        <p style={pStyle}>
          Set your own <code>DATABASE_URL</code> secret and DROP steps aside: an app already pointed at a database
          is never given a second one behind its back. An explicit <code>database: postgres</code> in{' '}
          <code>drop.yaml</code> still wins, since that is asking for a DROP database in as many words.
        </p>
        <CodeBlock
          label="app.js"
          code={`const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });`}
        />
        <p style={pStyle}>
          The bundled server is locked to <code>scram-sha-256</code> authentication with its unix socket restricted
          to peer auth. Snapshot everything, file stores and every provisioned database, with{' '}
          <code>drop backup</code>; see the{' '}
          <Link to="/reference" style={linkStyle}>
            CLI reference
          </Link>{' '}
          for restore.
        </p>
        <h3 style={h3Style}>Redis</h3>
        <p style={pStyle}>
          DROP also bundles a managed Redis. Unlike Postgres it is opt-in: ask for it with <code>redis: true</code>{' '}
          in <code>drop.yaml</code> and the app gets its own logical database with <code>REDIS_URL</code> injected:
        </p>
        <CodeBlock
          label="app.js"
          code={`const redis = createClient({ url: process.env.REDIS_URL });`}
        />
        <p style={pStyle}>
          It is a convenience, not a hard dependency: on a platform where Redis is disabled (
          <code>DROP_ENABLE_REDIS=false</code>) apps simply start without <code>REDIS_URL</code>, the same way they
          do when Postgres is unavailable, so an app that can fall back should check for the variable.
        </p>
      </Section>

      <Section id="logs" title="Logs">
        <p style={pStyle}>
          DROP automatically captures every app's stdout/stderr to dated log files, with no setup required:
        </p>
        <CodeBlock
          label="data/logs/webapps/my-app/"
          code={`my-app-2026-01-18-out.log    # stdout
my-app-2026-01-18-err.log    # stderr`}
        />
        <p style={pStyle}>View them from the CLI, or in the dashboard's live log viewer:</p>
        <CodeBlock
          label="shell"
          code={`drop logs my-app          # recent logs
drop logs my-app -n 100   # last 100 lines`}
        />
        <p style={pStyle}>
          For your own structured logging, write into <code>DROP_DATA_DIR</code> so it survives redeploys:
        </p>
        <CodeBlock
          label="app.js"
          code={`const logDir = process.env.DROP_DATA_DIR || './data';
fs.appendFileSync(\`\${logDir}/logs/app.json\`, JSON.stringify(logEntry) + '\\n');`}
        />
      </Section>

      <Section id="claude-web" title="Connect Claude (web)">
        <p style={pStyle}>
          DROP runs a hosted <strong style={{ color: 'var(--text)' }}>MCP server</strong> at{' '}
          <code>/api/v1/mcp</code>. Connect <strong style={{ color: 'var(--text)' }}>claude.ai</strong> to it as a
          custom connector and Claude can deploy and manage your apps in plain language, through the tools{' '}
          <code>deploy_files</code>, <code>deploy_from_git</code>, <code>list_apps</code>, <code>app_status</code>,{' '}
          <code>app_logs</code>, <code>get_deploy_logs</code>, and <code>restart_app</code>. The web connector
          authenticates with OAuth, so you sign into your own DROP account and approve access. There are no API keys to paste.
        </p>
        <Callout tone="warn">
          The web connector needs a DROP reachable over public HTTPS, with <code>DROP_PUBLIC_URL</code> set to that
          origin (e.g. <code>https://drop.example.com</code>). Every OAuth endpoint fails closed until it is set, and
          claude.ai cannot reach a <code>localhost</code> DROP. For a local box, use Claude Code or Cursor (below).
        </Callout>

        <h3 style={h3Style}>1. Get your connector details</h3>
        <p style={pStyle}>
          In the DROP dashboard, open{' '}
          <strong style={{ color: 'var(--text)' }}>Settings → Claude (MCP)</strong>. Admin and user accounts see
          this tab (a read-only account does not). It shows the{' '}
          <strong style={{ color: 'var(--text)' }}>MCP Server URL</strong> and{' '}
          <strong style={{ color: 'var(--text)' }}>OAuth Client ID</strong> with copy buttons, and confirms the Client
          Secret stays blank. The Client ID is the same for the whole server and is not a secret, so hand it to anyone
          who should connect.
        </p>
        <p style={pStyle}>
          If the tab says connector setup isn't available, an administrator has either turned it off or hasn't
          finished the one-time setup yet. Ask them to check Settings → Claude (MCP) on their own account.
        </p>
        <p style={pStyle}>Prefer a script? The same values come from the API:</p>
        <CodeBlock
          label="shell"
          code={`curl https://drop.example.com/api/v1/oauth/connector-info \\
  -H "Authorization: Bearer <api-key>"

# → { "success": true, "data": {
#       "client_id": "a1b2c3…",
#       "client_secret": null,
#       "redirect_uri": "https://claude.ai/api/mcp/auth_callback",
#       "mcp_url": "https://drop.example.com/api/v1/mcp" } }`}
        />
        <p style={pStyle}>
          That call reads an already-minted client_id, so on a fresh install where no one has opened the tab yet, it
          404s. An admin mints it once (opening the tab does this automatically, or run it directly):
        </p>
        <CodeBlock
          label="shell"
          code={`curl -X POST https://drop.example.com/api/v1/oauth/client \\
  -H "Authorization: Bearer <admin-api-key>"   # one-time, admin`}
        />

        <h3 style={h3Style}>2. Add the connector in claude.ai</h3>
        <p style={pStyle}>
          In claude.ai, open{' '}
          <strong style={{ color: 'var(--text)' }}>Settings → Connectors → Add custom connector</strong> and fill in:
        </p>
        <DocTable
          headers={['Field', 'Value']}
          rows={[
            ['Remote MCP server URL', 'https://drop.example.com/api/v1/mcp'],
            ['OAuth Client ID', 'the client_id from step 1'],
            ['OAuth Client Secret', 'leave blank; DROP uses PKCE, no client secret'],
          ]}
        />

        <h3 style={h3Style}>3. Connect and consent</h3>
        <p style={pStyle}>
          Click <strong style={{ color: 'var(--text)' }}>Connect</strong>. claude.ai sends you to your DROP sign-in;
          approve the <em>&ldquo;Deploy and manage your apps&rdquo;</em> request and you are returned to claude.ai with
          the connector live.
        </p>
        <Callout>
          The connection is scoped to your DROP user, so Claude only sees and touches{' '}
          <strong style={{ color: 'var(--text)' }}>your</strong> apps, exactly like a <code>user</code>-role API key
          (whose role is itself a ceiling capped by its owner's account role, never a fixed grant). There is no{' '}
          <code>set_secrets</code> or <code>remove_app</code> tool, so a connected agent can never read secrets or
          delete apps through MCP.
        </Callout>

        <h3 style={h3Style}>4. Use it</h3>
        <p style={pStyle}>
          Start a chat with the connector enabled and ask, for example, <em>&ldquo;list my DROP apps&rdquo;</em> or{' '}
          <em>&ldquo;deploy this as a new app called demo&rdquo;</em>. Revoke access anytime from claude.ai&apos;s
          connector settings, or server-side via the DROP API.
        </p>
      </Section>

      <Section id="mcp-clients" title="Claude Code, Cursor &amp; agents">
        <p style={pStyle}>
          MCP clients that support request headers, such as <strong style={{ color: 'var(--text)' }}>Claude Code</strong>,{' '}
          <strong style={{ color: 'var(--text)' }}>Claude Desktop</strong>, and{' '}
          <strong style={{ color: 'var(--text)' }}>Cursor</strong>, skip OAuth and authenticate with a DROP API key.
          Mint a <code>user</code>-role key in the dashboard (never an admin key; a <code>user</code> key is
          automatically scoped to the apps it creates). A key's role is a ceiling capped by its owner's own account
          role, not a fixed grant.
        </p>
        <CodeBlock
          label="Claude Code"
          code={`claude mcp add --transport http dropkit \\
  https://drop.example.com/api/v1/mcp \\
  --header "Authorization: Bearer <user-api-key>"`}
        />
        <CodeBlock
          label="Cursor · .cursor/mcp.json"
          code={`{
  "mcpServers": {
    "dropkit": {
      "url": "https://drop.example.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer <user-api-key>" }
    }
  }
}`}
        />
        <h3 style={h3Style}>Tools</h3>
        <DocTable
          headers={['Tool', 'What it does']}
          rows={[
            ['deploy_files', 'Deploy from inline file contents, for small/AI-generated apps (≤48 files, 1.5 MB text)'],
            ['deploy_from_git', 'Deploy a new app by cloning a GitHub repo (optional branch)'],
            ['list_apps', 'List the apps you can see'],
            ['app_status', "An app's status, type, port, and URL"],
            ['app_logs', 'Recent runtime stdout/stderr (returned as untrusted data)'],
            ['get_deploy_logs', 'Build or runtime output for a specific deploy. The one to use after a failure, since app_logs only sees a running app'],
            ['restart_app', 'Stop and restart an app on its existing port'],
          ]}
        />
        <Callout>
          <code>deploy_files</code> can also create an <strong style={{ color: 'var(--text)' }}>ephemeral</strong> app:
          pass <code>ephemeral: true</code> (with an optional <code>ttlMinutes</code>, default 60) and DROP hands back
          a randomly-named throwaway that deletes itself, database included, when its lifetime runs out. Good for a
          scratch test an agent runs and forgets; never for anything you want to keep.
        </Callout>
        <p style={pStyle}>
          The same key drives the shell-only tarball-upload recipe (no MCP client needed). See the{' '}
          <Link to="/reference" style={linkStyle}>
            reference
          </Link>{' '}
          for the REST endpoints.
        </p>
      </Section>

      <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
        <div style={kickerStyle}>Next</div>
        <h2 style={{ ...h2Style, fontSize: 22 }}>Look up a command or endpoint</h2>
        <p style={{ ...pStyle, maxWidth: 480, margin: '0 auto 20px' }}>
          Every CLI command, REST endpoint, and MCP tool is catalogued in the reference.
        </p>
        <Link
          to="/reference"
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
          }}
        >
          CLI &amp; API reference →
        </Link>
      </div>
    </article>
  );
}
