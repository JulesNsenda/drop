/**
 * DROP beta waitlist — a zero-dependency app that runs ON DROP.
 *
 * Drop this folder into DROP's webapps directory (or git-deploy it) and it
 * serves a public join form, an admin view, and — when you approve someone —
 * creates a real DROP account via DROP's admin API and emails them their login.
 *
 * Node 18+ only (built-in http/fs/crypto + global fetch). No npm install.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// ── config (all via env; DROP injects PORT + DROP_DATA_DIR + per-app secrets) ─
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DROP_DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'waitlist.json');

const ADMIN_TOKEN = process.env.WAITLIST_ADMIN_TOKEN || '';
const INVITES_ENABLED = process.env.WAITLIST_INVITES_ENABLED === 'true';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'DROP <onboarding@resend.dev>';

const DROP_API_URL = (process.env.DROP_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const DROP_ADMIN_API_KEY = process.env.DROP_ADMIN_API_KEY || '';
const DASHBOARD_URL = (process.env.DASHBOARD_URL || DROP_API_URL).replace(/\/$/, '') + '/dashboard';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── storage (atomic JSON, writes serialized through a promise chain) ──────────
let store = { entries: [] };
let writeChain = Promise.resolve();

async function loadStore() {
  try {
    const raw = await fsp.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) store = parsed;
  } catch {
    store = { entries: [] };
  }
}

function save() {
  // Serialize writes; each runs after the previous settles.
  writeChain = writeChain.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.waitlist.${process.pid}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2));
    await fsp.rename(tmp, STORE_PATH);
  }, () => {});
  return writeChain;
}

const normEmail = (e) => String(e || '').trim().toLowerCase();

// ── email (Resend over fetch; no-op when unconfigured) ────────────────────────
async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) return { sent: false, error: 'email not configured (RESEND_API_KEY unset)' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { sent: false, error: `provider ${res.status}: ${detail.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : 'send failed' };
  }
}

function welcomeEmailHtml(username, tempPassword) {
  return `
  <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111">
    <h2>You're in the DROP beta 🎉</h2>
    <p>Your account is ready. Sign in and you'll be prompted to set your own password.</p>
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:4px 12px 4px 0;color:#666">Username</td><td><b>${escapeHtml(username)}</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Temp password</td><td><code>${escapeHtml(tempPassword)}</code></td></tr>
    </table>
    <p><a href="${DASHBOARD_URL}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">Open the dashboard →</a></p>
    <p style="color:#999;font-size:12px">If you didn't request this, you can ignore the email.</p>
  </div>`;
}

// ── DROP admin API: create a beta user ────────────────────────────────────────
async function createDropUser(username, password) {
  const res = await fetch(`${DROP_API_URL}/api/v1/auth/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DROP_ADMIN_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password, role: 'user' }),
  });
  return res;
}

function deriveUsername(email) {
  let base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (base.length < 3) base = `user${base}`;
  return base.slice(0, 24);
}

// Create the account, retrying with a numeric suffix on username conflict.
async function provisionAccount(email) {
  const base = deriveUsername(email);
  const password = crypto.randomBytes(12).toString('base64url');
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const res = await createDropUser(username, password);
    if (res.ok) return { ok: true, username, password };
    if (res.status === 409) continue; // username taken — try next
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `DROP API ${res.status}: ${detail.slice(0, 200)}` };
  }
  return { ok: false, error: 'could not find an available username' };
}

// ── http helpers ──────────────────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers });
  res.end(data);
}

function sendJson(res, status, obj) {
  send(res, status, obj, {});
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false; // fail closed when unset
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-admin-token'] || '');
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── routes ────────────────────────────────────────────────────────────────────
async function handleJoin(req, res) {
  const body = await readJsonBody(req);
  if (!body || !EMAIL_RE.test(String(body.email || ''))) {
    return sendJson(res, 400, { ok: false, error: 'A valid email is required.' });
  }
  const email = normEmail(body.email);
  const name = body.name ? String(body.name).trim().slice(0, 120) : undefined;
  const now = new Date().toISOString();

  const existing = store.entries.find((e) => e.email === email);
  if (existing) {
    if (name && !existing.name) { existing.name = name; existing.updatedAt = now; await save(); }
  } else {
    store.entries.unshift({
      id: `wl_${crypto.randomBytes(8).toString('hex')}`,
      email, name, status: 'pending', createdAt: now, updatedAt: now,
    });
    await save();
  }
  // Generic response — don't leak whether the email was already on the list.
  return sendJson(res, 200, { ok: true });
}

function listEntries(res) {
  const safe = store.entries.map((e) => ({
    id: e.id, email: e.email, name: e.name || null, status: e.status,
    createdAt: e.createdAt, invitedAt: e.invitedAt || null, username: e.username || null,
  }));
  return sendJson(res, 200, { ok: true, invitesEnabled: INVITES_ENABLED, entries: safe });
}

async function handleApprove(req, res) {
  const body = await readJsonBody(req);
  const entry = body && body.id ? store.entries.find((e) => e.id === body.id) : null;
  if (!entry) return sendJson(res, 404, { ok: false, error: 'Entry not found.' });
  if (entry.status === 'invited') return sendJson(res, 409, { ok: false, error: 'Already invited.' });

  // Safety gate: don't mint deploy-capable accounts until invites are enabled
  // (i.e. until DROP runs Docker isolation). Just mark approved for now.
  if (!INVITES_ENABLED) {
    entry.status = 'approved';
    entry.updatedAt = new Date().toISOString();
    await save();
    return sendJson(res, 200, {
      ok: true, created: false,
      message: 'Marked approved. Invites are disabled (set WAITLIST_INVITES_ENABLED=true once Docker isolation is on).',
    });
  }

  if (!DROP_ADMIN_API_KEY) {
    return sendJson(res, 500, { ok: false, error: 'DROP_ADMIN_API_KEY not configured.' });
  }

  const result = await provisionAccount(entry.email);
  if (!result.ok) return sendJson(res, 502, { ok: false, error: result.error });

  const email = await sendEmail({
    to: entry.email,
    subject: "You're in the DROP beta",
    html: welcomeEmailHtml(result.username, result.password),
  });

  entry.status = 'invited';
  entry.username = result.username;
  entry.invitedAt = new Date().toISOString();
  entry.updatedAt = entry.invitedAt;
  await save();

  return sendJson(res, 200, {
    ok: true, created: true, username: result.username,
    emailSent: email.sent, emailError: email.error || null,
    // Returned so you can send credentials manually if email isn't configured.
    tempPassword: email.sent ? undefined : result.password,
  });
}

// ── server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });
    if (req.method === 'GET' && (p === '/' || p === '')) return send(res, 200, LANDING_HTML);
    if (req.method === 'GET' && p === '/admin') return send(res, 200, ADMIN_HTML);
    if (req.method === 'POST' && p === '/api/join') return handleJoin(req, res);

    // Admin endpoints
    if (p === '/api/admin/entries' && req.method === 'GET') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return listEntries(res);
    }
    if (p === '/api/admin/approve' && req.method === 'POST') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return handleApprove(req, res);
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    console.error('[waitlist] error', err);
    return sendJson(res, 500, { ok: false, error: 'Internal error' });
  }
});

loadStore().then(() => {
  server.listen(PORT, () => {
    console.log(`[waitlist] listening on :${PORT}  (data: ${STORE_PATH}, invites: ${INVITES_ENABLED ? 'on' : 'off'})`);
  });
});

// ── inline HTML (no build step) ───────────────────────────────────────────────
const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DROP — join the beta</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0a0a0f;color:#e5e7eb;
    min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
  .glow{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:600px;height:600px;
    background:rgba(79,70,229,.06);border-radius:50%;filter:blur(80px);pointer-events:none}
  .wrap{position:relative;z-index:1;max-width:460px;width:100%}
  .logo{width:48px;height:48px;background:#4f46e5;border-radius:12px;margin:0 auto 32px;
    display:flex;align-items:center;justify-content:center;font-size:24px}
  .kicker{color:#6b7280;font-size:13px;letter-spacing:.3em;text-transform:uppercase;margin:0 0 16px}
  h1{font-size:44px;line-height:1.05;margin:0 0 16px;font-weight:800;letter-spacing:-.02em}
  h1 span{color:#6366f1}
  .sub{color:#6b7280;font-size:14px;margin:0 0 32px}
  form{display:flex;gap:8px;flex-direction:column}
  input{padding:12px 16px;border-radius:10px;border:1px solid #1f2937;background:#111118;color:#fff;font-size:15px;outline:none}
  input:focus{border-color:#4f46e5}
  button{padding:12px 16px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#6366f1}
  button:disabled{opacity:.5;cursor:default}
  .msg{margin-top:16px;font-size:14px;min-height:20px}
  .ok{color:#34d399}.err{color:#f87171}
  .foot{position:fixed;bottom:24px;left:0;right:0;color:#374151;font-size:11px;letter-spacing:.2em;text-transform:uppercase}
</style></head>
<body>
<div class="glow"></div>
<div class="wrap">
  <div class="logo">◧</div>
  <p class="kicker">What if deploying was just</p>
  <h1>dropping<br>a folder<span>?</span></h1>
  <p class="sub">DROP is a self-hosted PaaS. No config. No pipelines. No YAML.<br>Join the private beta.</p>
  <form id="f">
    <input id="email" type="email" placeholder="you@example.com" required autocomplete="email">
    <input id="name" type="text" placeholder="Name (optional)" autocomplete="name">
    <button id="b" type="submit">Join the beta</button>
  </form>
  <div class="msg" id="m"></div>
</div>
<div class="foot">DROP · Self-hosted PaaS</div>
<script>
  const f=document.getElementById('f'),m=document.getElementById('m'),b=document.getElementById('b');
  f.addEventListener('submit',async(e)=>{
    e.preventDefault();m.textContent='';b.disabled=true;
    try{
      const r=await fetch('/api/join',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email:document.getElementById('email').value,name:document.getElementById('name').value})});
      const j=await r.json();
      if(j.ok){m.className='msg ok';m.textContent="You're on the list — we'll be in touch.";f.reset();}
      else{m.className='msg err';m.textContent=j.error||'Something went wrong.';}
    }catch{m.className='msg err';m.textContent='Could not reach the server.';}
    b.disabled=false;
  });
</script>
</body></html>`;

const ADMIN_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DROP waitlist — admin</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,sans-serif;background:#0a0a0f;color:#e5e7eb;padding:24px}
  .bar{display:flex;gap:8px;align-items:center;margin-bottom:20px;flex-wrap:wrap}
  h1{font-size:20px;margin:0 16px 0 0}
  input{padding:8px 12px;border-radius:8px;border:1px solid #1f2937;background:#111118;color:#fff;outline:none}
  button{padding:8px 14px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer}
  button:hover{background:#6366f1}button:disabled{opacity:.5}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #1a1a22}
  th{color:#6b7280;font-weight:500;font-size:12px}
  .pill{font-size:11px;padding:2px 8px;border-radius:999px}
  .pending{background:#1f2937;color:#9ca3af}.approved{background:#3730a3;color:#c7d2fe}.invited{background:#064e3b;color:#6ee7b7}
  .note{color:#f59e0b;font-size:12px;margin-bottom:12px}
  .msg{font-size:13px;margin-left:8px}
</style></head>
<body>
<div class="bar">
  <h1>Waitlist admin</h1>
  <input id="tok" type="password" placeholder="Admin token" style="flex:1;min-width:200px">
  <button id="load">Load</button>
  <span class="msg" id="msg"></span>
</div>
<div class="note" id="gate"></div>
<table><thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Joined</th><th></th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
  const tok=document.getElementById('tok'),rows=document.getElementById('rows'),msg=document.getElementById('msg'),gate=document.getElementById('gate');
  function hdr(){return{'Authorization':'Bearer '+tok.value}}
  async function load(){
    msg.textContent='';
    try{
      const r=await fetch('/api/admin/entries',{headers:hdr()});
      if(r.status===403){msg.textContent='Forbidden — check token.';return;}
      const j=await r.json();
      gate.textContent=j.invitesEnabled?'':'Invites are DISABLED — approving only marks entries; no accounts are created until WAITLIST_INVITES_ENABLED=true.';
      rows.innerHTML='';
      for(const e of j.entries){
        const tr=document.createElement('tr');
        tr.innerHTML='<td>'+esc(e.email)+'</td><td>'+esc(e.name||'')+'</td>'+
          '<td><span class="pill '+e.status+'">'+e.status+'</span>'+(e.username?' '+esc(e.username):'')+'</td>'+
          '<td>'+new Date(e.createdAt).toLocaleDateString()+'</td><td></td>';
        const td=tr.lastChild;
        if(e.status!=='invited'){
          const btn=document.createElement('button');btn.textContent='Approve & invite';
          btn.onclick=()=>approve(e.id,btn);td.appendChild(btn);
        }
        rows.appendChild(tr);
      }
    }catch{msg.textContent='Failed to load.';}
  }
  async function approve(id,btn){
    btn.disabled=true;btn.textContent='...';
    try{
      const r=await fetch('/api/admin/approve',{method:'POST',headers:{...hdr(),'Content-Type':'application/json'},body:JSON.stringify({id})});
      const j=await r.json();
      if(!j.ok){alert(j.error||'Failed');btn.disabled=false;btn.textContent='Approve & invite';return;}
      if(j.created&&!j.emailSent){alert('Account created ('+j.username+') but email not sent.\\nTemp password: '+j.tempPassword);}
      else if(j.created){alert('Invited '+j.username+' — welcome email sent.');}
      else{alert(j.message||'Marked approved.');}
      load();
    }catch{alert('Request failed');btn.disabled=false;}
  }
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  document.getElementById('load').onclick=load;
  tok.addEventListener('keydown',e=>{if(e.key==='Enter')load()});
</script>
</body></html>`;
