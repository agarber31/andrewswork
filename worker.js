// Andrew's Work v4 — Cloudflare Worker
// UI redesign: modern PM tool aesthetic (Linear / Height / Notion feel).
// - Tasks section now a 3-column kanban on the public page: Todo / In Progress / Completed
// - Activity section moved BELOW tasks and rebuilt as a work session log:
//   each entry has startedAt, endedAt, and duration (minutes)
// - Data shape extended (backward compatible with old activity rows that only had `date`)
// Storage: one KV namespace binding SITE_DATA, single key "site-data"
// Admin auth: env.ADMIN_PASSCODE (Secret) + per-device tokens stored in KV

const DEFAULT_DATA = {
  activity: [], // {id, text, startedAt, endedAt, duration}  (legacy: {id,text,date})
  tasks: [],
  timeLogs: [],
  activeTimer: null,
  notepad: "",
  adminTokens: [],
};

function uid() { return crypto.randomUUID().slice(0, 8); }

async function getData(env) {
  const raw = await env.SITE_DATA.get("site-data");
  if (!raw) return structuredClone(DEFAULT_DATA);
  return { ...structuredClone(DEFAULT_DATA), ...JSON.parse(raw) };
}
async function saveData(env, data) { await env.SITE_DATA.put("site-data", JSON.stringify(data)); }
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }); }
function isAdmin(request, data) {
  const token = request.headers.get("X-Admin-Token");
  return !!token && data.adminTokens.includes(token);
}
async function requireAdmin(request, data) {
  if (!isAdmin(request, data)) return json({ error: "Not authorized." }, 401);
  return null;
}
function taskFor(data, id) { return data.tasks.find((t) => t.id === id); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(HTML, { headers: { "content-type": "text/html;charset=UTF-8" } });
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url.pathname);
    return new Response("Not found", { status: 404 });
  },
};

async function handleApi(request, env, pathname) {
  const data = await getData(env);
  const method = request.method;
  const admin = isAdmin(request, data);

  if (pathname === "/api/data" && method === "GET") {
    const pub = {
      activity: data.activity,
      tasks: data.tasks.map((t) => ({ ...t, subtasks: t.subtasks, comments: t.comments })),
      notepad: data.notepad,
      isAdmin: admin,
    };
    if (admin) { pub.timeLogs = data.timeLogs; pub.activeTimer = data.activeTimer; }
    return json(pub);
  }

  if (pathname === "/api/admin/login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSCODE) return json({ error: "Server missing ADMIN_PASSCODE secret." }, 500);
    if (body.passcode !== env.ADMIN_PASSCODE) return json({ error: "Wrong passcode." }, 401);
    const token = crypto.randomUUID();
    data.adminTokens.push(token);
    if (data.adminTokens.length > 20) data.adminTokens.shift();
    await saveData(env, data);
    return json({ token });
  }

  // ---- Activity (admin write) — now with start/end/duration ----
  if (pathname === "/api/activity" && method === "POST") {
    const denied = await requireAdmin(request, data); if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    if (!body.text?.trim()) return json({ error: "Text required." }, 400);
    const startedAt = body.startedAt || new Date().toISOString();
    const endedAt = body.endedAt || new Date().toISOString();
    let duration = Number.isFinite(body.duration) ? body.duration
      : Math.max(1, Math.round((new Date(endedAt) - new Date(startedAt)) / 60000));
    data.activity.unshift({
      id: uid(),
      text: body.text.trim(),
      startedAt,
      endedAt,
      duration,
      date: startedAt, // keep legacy field for anything that still reads it
    });
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname.match(/^\/api\/activity\/[^/]+$/) && method === "DELETE") {
    const denied = await requireAdmin(request, data); if (denied) return denied;
    data.activity = data.activity.filter((a) => a.id !== pathname.split("/").pop());
    await saveData(env, data);
    return json({ ok: true });
  }

  if (pathname === "/api/tasks" && method === "POST") {
    const denied = await requireAdmin(request, data); if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    if (!body.text?.trim()) return json({ error: "Text required." }, 400);
    data.tasks.unshift({ id: uid(), text: body.text.trim(), status: "todo", createdAt: new Date().toISOString(), subtasks: [], comments: [] });
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname.match(/^\/api\/tasks\/[^/]+$/) && (method === "PUT" || method === "DELETE")) {
    const denied = await requireAdmin(request, data); if (denied) return denied;
    const id = pathname.split("/").pop();
    if (method === "DELETE") {
      data.tasks = data.tasks.filter((t) => t.id !== id);
      data.timeLogs = data.timeLogs.filter((l) => l.taskId !== id);
      if (data.activeTimer?.taskId === id) data.activeTimer = null;
      await saveData(env, data);
      return json({ ok: true });
    }
    const task = taskFor(data, id);
    if (!task) return json({ error: "Not found." }, 404);
    const body = await request.json().catch(() => ({}));
    if (typeof body.text === "string" && body.text.trim()) task.text = body.text.trim();
    if (["todo", "inprogress", "completed"].includes(body.status)) task.status = body.status;
    await saveData(env, data);
    return json({ ok: true });
  }

  if (pathname.match(/^\/api\/tasks\/[^/]+\/subtasks$/) && method === "POST") {
    const denied = await requireAdmin(request, data); if (denied) return denied;
    const taskId = pathname.split("/")[3];
    const task = taskFor(data, taskId);
    if (!task) return json({ error: "Not found." }, 404);
    const body = await request.json().catch(() => ({}));
    if (!body.text?.trim()) return json({ error: "Text required." }, 400);
    task.subtasks.push({ id: uid(), text: body.text.trim(), done: false });
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname.match(/^\/api\/tasks\/[^/]+\/subtasks\/[^/]+$/) && (method === "PUT" || method === "DELETE")) {
    const denied = await requireAdmin(request, data); if (denied) return denied;
    const parts = pathname.split("/");
    const task = taskFor(data, parts[3]);
    if (!task) return json({ error: "Not found." }, 404);
    if (method === "DELETE") {
      task.subtasks = task.subtasks.filter((s) => s.id !== parts[5]);
      await saveData(env, data);
      return json({ ok: true });
    }
    const sub = task.subtasks.find((s) => s.id === parts[5]);
    if (!sub) return json({ error: "Not found." }, 404);
    const body = await request.json().catch(() => ({}));
    if (typeof body.done === "boolean") sub.done = body.done;
    if (typeof body.text === "string" && body.text.trim()) sub.text = body.text.trim();
    await saveData(env, data);
    return json({ ok: true });
  }

  if (pathname.match(/^\/api\/tasks\/[^/]+\/comments$/) && method === "POST") {
    const task = taskFor(data, pathname.split("/")[3]);
    if (!task) return json({ error: "Not found." }, 404);
    const body = await request.json().catch(() => ({}));
    if (!body.name?.trim() || !body.text?.trim()) return json({ error: "Name and comment required." }, 400);
    task.comments.push({ id: uid(), name: body.name.trim().slice(0, 40), text: body.text.trim().slice(0, 500), ts: new Date().toISOString() });
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname.match(/^\/api\/tasks\/[^/]+\/comments\/[^/]+$/) && method === "DELETE") {
    const denied = await requireAdmin(request, data); if (denied) return denied;
    const parts = pathname.split("/");
    const task = taskFor(data, parts[3]);
    if (!task) return json({ error: "Not found." }, 404);
    task.comments = task.comments.filter((c) => c.id !== parts[5]);
    await saveData(env, data);
    return json({ ok: true });
  }

  if (pathname === "/api/timer/start" && method === "POST") {
    const denied = await requireAdmin(request, data); if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    if (!body.taskId || !taskFor(data, body.taskId)) return json({ error: "Valid taskId required." }, 400);
    if (data.activeTimer) return json({ error: "A timer is already running." }, 400);
    data.activeTimer = { taskId: body.taskId, start: new Date().toISOString() };
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname === "/api/timer/stop" && method === "POST") {
    const denied = await requireAdmin(request, data); if (denied) return denied;
    if (!data.activeTimer) return json({ error: "No timer running." }, 400);
    const body = await request.json().catch(() => ({}));
    const start = new Date(data.activeTimer.start);
    const end = new Date();
    const minutes = Math.max(1, Math.round((end - start) / 60000));
    data.timeLogs.unshift({ id: uid(), taskId: data.activeTimer.taskId, start: data.activeTimer.start, end: end.toISOString(), minutes, note: (body.note || "").trim().slice(0, 300) });
    data.activeTimer = null;
    await saveData(env, data);
    return json({ ok: true });
  }

  if (pathname === "/api/notepad" && method === "PUT") {
    const body = await request.json().catch(() => ({}));
    data.notepad = (body.content || "").slice(0, 10000);
    await saveData(env, data);
    return json({ ok: true });
  }

  return json({ error: "Not found." }, 404);
}

const HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<title>Andrew's Work</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
${BODY}
<script>${JS}</script>
</body>
</html>`;

const CSS = `
/* ─────────────────────────────────────────────────────────────
   Andrew's Work — v4 · Modern PM tool aesthetic
   Neutrals + single indigo/violet accent · Linear/Height feel
   ───────────────────────────────────────────────────────────── */
:root{
  --bg:#fafafa;
  --surface:#ffffff;
  --surface-2:#f5f5f7;
  --surface-3:#eeeef1;
  --border:#e6e6ea;
  --border-strong:#d4d4da;
  --ink:#0a0a0f;
  --ink-2:#3f3f46;
  --ink-3:#71717a;
  --ink-4:#a1a1aa;
  --accent:#5b5bd6;
  --accent-hover:#4a4ac4;
  --accent-soft:#eef0fe;
  --accent-ink:#3d3dae;
  --todo:#71717a;
  --todo-bg:#f4f4f5;
  --progress:#d97706;
  --progress-bg:#fef3c7;
  --done:#16a34a;
  --done-bg:#dcfce7;
  --danger:#dc2626;
  --sans: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  --shadow-sm: 0 1px 2px rgba(10,10,15,0.04);
  --shadow-md: 0 2px 8px rgba(10,10,15,0.06), 0 1px 2px rgba(10,10,15,0.04);
  --shadow-lg: 0 12px 32px rgba(10,10,15,0.12), 0 2px 8px rgba(10,10,15,0.06);
  --radius: 8px;
  --radius-lg: 12px;
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{
  background:var(--bg); color:var(--ink);
  font-family:var(--sans); font-size:14px; line-height:1.5;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  font-feature-settings:'cv02','cv03','cv04','cv11';
}
.hidden{display:none !important;}
::selection{background:var(--accent); color:#fff;}
::-webkit-scrollbar{width:8px; height:8px;}
::-webkit-scrollbar-thumb{background:var(--border-strong); border-radius:4px;}
::-webkit-scrollbar-thumb:hover{background:var(--ink-4);}

/* ── Top navigation ────────────────────────────────────────── */
.topnav{
  position:sticky; top:0; z-index:20;
  height:52px;
  background: rgba(255,255,255,0.85);
  backdrop-filter: saturate(180%) blur(12px);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  border-bottom:1px solid var(--border);
  display:flex; align-items:center;
  padding: 0 24px;
  gap: 20px;
}
.topnav .brand{
  display:flex; align-items:center; gap:10px;
  font-weight:600; font-size:14px; color:var(--ink);
  letter-spacing:-0.01em;
}
.topnav .brand .mark{
  width:24px; height:24px; border-radius:6px;
  background: linear-gradient(135deg, var(--accent), #7c3aed);
  display:flex; align-items:center; justify-content:center;
  color:#fff; font-weight:700; font-size:12px;
  box-shadow: 0 1px 2px rgba(91,91,214,0.35), inset 0 1px 0 rgba(255,255,255,0.2);
}
.topnav .brand .sub{color:var(--ink-3); font-weight:400; margin-left:4px;}
.topnav .breadcrumb{
  color:var(--ink-3); font-size:13px;
  display:flex; align-items:center; gap:8px;
}
.topnav .breadcrumb .sep{color:var(--ink-4);}
.topnav .spacer{flex:1;}
.topnav .status-chip{
  display:inline-flex; align-items:center; gap:6px;
  padding:4px 10px; border-radius:100px;
  background: color-mix(in oklab, var(--done) 8%, transparent);
  color:var(--done); font-size:12px; font-weight:500;
}
.topnav .status-chip .dot{
  width:6px; height:6px; border-radius:50%; background:var(--done);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--done) 20%, transparent);
  animation: pulse 2.4s infinite;
}
@keyframes pulse{
  0%,100%{opacity:1;}
  50%{opacity:0.5;}
}
.topnav .clock{
  font-family:var(--mono); font-size:12px; color:var(--ink-3);
  font-variant-numeric: tabular-nums;
  padding:4px 10px; background:var(--surface-2);
  border-radius:6px; border:1px solid var(--border);
}
.topnav .kbd{
  display:inline-flex; gap:3px; align-items:center;
  font-family:var(--mono); font-size:11px; color:var(--ink-3);
}
.topnav .kbd kbd{
  background:var(--surface); border:1px solid var(--border-strong);
  border-bottom-width:2px;
  padding:2px 6px; border-radius:4px; font-family:var(--mono);
  font-size:10.5px; color:var(--ink-2);
}

/* ── Page shell ────────────────────────────────────────────── */
.shell{max-width:1400px; margin:0 auto; padding: 32px 24px 80px;}
.page-header{
  display:flex; align-items:end; justify-content:space-between;
  gap:24px; margin-bottom:28px;
}
.page-header .title-block h1{
  font-size:28px; font-weight:600; letter-spacing:-0.02em;
  margin:0 0 6px; color:var(--ink);
}
.page-header .title-block p{
  font-size:14px; color:var(--ink-3); margin:0;
}
.page-header .stats{
  display:flex; gap:8px; flex-wrap:wrap;
}
.stat-pill{
  display:inline-flex; align-items:center; gap:8px;
  padding: 8px 12px;
  background: var(--surface);
  border:1px solid var(--border);
  border-radius: var(--radius);
  font-size:12.5px; color:var(--ink-2);
  box-shadow: var(--shadow-sm);
}
.stat-pill .num{
  font-weight:600; color:var(--ink);
  font-variant-numeric: tabular-nums;
}
.stat-pill .swatch{
  width:8px; height:8px; border-radius:2px;
}

/* ── Section headers ───────────────────────────────────────── */
.section{margin-bottom:40px;}
.section-header{
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:16px; gap:16px;
}
.section-header .heading{
  display:flex; align-items:center; gap:10px;
}
.section-header h2{
  font-size:18px; font-weight:600; letter-spacing:-0.01em;
  margin:0; color:var(--ink);
}
.section-header .count{
  font-family:var(--mono); font-size:11.5px;
  padding:2px 8px; background:var(--surface-2);
  border:1px solid var(--border); border-radius:100px;
  color:var(--ink-3); font-variant-numeric: tabular-nums;
}
.section-header .actions{display:flex; gap:8px;}

/* ═════════════════════════════════════════════════════════════
   KANBAN — public read-only
   ═════════════════════════════════════════════════════════════ */
.kanban{
  display:grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap:16px;
}
@media (max-width: 900px){
  .kanban{grid-template-columns: 1fr;}
}
.col{
  background: var(--surface-2);
  border:1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 12px;
  display:flex; flex-direction:column;
  min-height: 180px;
}
.col-header{
  display:flex; align-items:center; justify-content:space-between;
  padding: 4px 6px 12px;
  margin-bottom: 4px;
}
.col-header .title-row{display:flex; align-items:center; gap:8px;}
.col-header .swatch{
  width:8px; height:8px; border-radius:2px;
}
.col[data-status="todo"] .swatch{background:var(--todo);}
.col[data-status="inprogress"] .swatch{background:var(--progress);}
.col[data-status="completed"] .swatch{background:var(--done);}
.col-header .name{
  font-size:13px; font-weight:600; color:var(--ink);
  letter-spacing:0;
}
.col-header .count-chip{
  font-family:var(--mono); font-size:11px;
  color:var(--ink-3); font-variant-numeric: tabular-nums;
  padding:1px 7px; border-radius:100px;
  background:var(--surface); border:1px solid var(--border);
}
.col-body{
  display:flex; flex-direction:column; gap:8px;
  flex:1;
}
.col-empty{
  padding: 32px 12px;
  text-align:center; color:var(--ink-4);
  font-size:12.5px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: color-mix(in oklab, var(--surface) 40%, transparent);
}

.tcard{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 12px 10px;
  box-shadow: var(--shadow-sm);
  transition: box-shadow .12s ease, transform .08s ease, border-color .12s ease;
  cursor: default;
}
.tcard:hover{
  box-shadow: var(--shadow-md);
  border-color: var(--border-strong);
}
.tcard .tcard-head{
  display:flex; align-items:start; justify-content:space-between;
  gap:8px; margin-bottom:6px;
}
.tcard .tcard-id{
  font-family:var(--mono); font-size:10.5px;
  color:var(--ink-4); letter-spacing:0.02em;
}
.tcard .tcard-title{
  font-size:13.5px; font-weight:500; line-height:1.4;
  color:var(--ink); text-wrap:pretty;
  margin:0;
}
.tcard[data-status="completed"] .tcard-title{
  color:var(--ink-3);
}
.tcard .tcard-meta{
  display:flex; gap:10px; flex-wrap:wrap; align-items:center;
  margin-top:8px; padding-top:8px;
  border-top:1px solid var(--surface-3);
  font-size:11.5px; color:var(--ink-3);
}
.tcard .tcard-meta .item{display:inline-flex; align-items:center; gap:5px;}
.tcard .tcard-meta .item svg{width:12px; height:12px; opacity:0.7;}
.tcard .progress-mini{
  display:inline-flex; align-items:center; gap:6px;
}
.tcard .progress-mini .bar{
  width:60px; height:4px; background:var(--surface-3); border-radius:2px; overflow:hidden;
}
.tcard .progress-mini .bar span{display:block; height:100%; background:var(--accent); border-radius:2px;}
.tcard .tcard-meta .comments-btn{
  background:none; border:none; padding:0; margin:0;
  font: inherit; color:var(--accent-ink); cursor:pointer;
  display:inline-flex; align-items:center; gap:5px;
}
.tcard .tcard-meta .comments-btn:hover{color:var(--accent);}

.tcard .comments-panel{
  margin: 10px -12px -10px;
  padding: 10px 12px;
  border-top: 1px solid var(--surface-3);
  background: var(--surface-2);
  border-radius: 0 0 var(--radius) var(--radius);
}
.comment{
  padding: 6px 0; font-size: 12.5px; line-height:1.45;
  border-bottom: 1px dashed var(--border);
}
.comment:last-of-type{border-bottom:none;}
.comment .head{
  display:flex; justify-content:space-between; align-items:baseline;
  margin-bottom: 2px;
}
.comment .who{
  font-weight:600; color:var(--ink); font-size:12px;
}
.comment .when{
  font-family:var(--mono); font-size:10.5px; color:var(--ink-4);
}
.comment .body{color:var(--ink-2);}
.comment-form{
  display:grid; grid-template-columns: 1fr; gap:6px;
  margin-top: 10px; padding-top: 10px;
  border-top: 1px solid var(--border);
}
.comment-form .row{display:grid; grid-template-columns: 110px 1fr auto; gap:6px;}
@media (max-width:500px){ .comment-form .row{grid-template-columns:1fr;} }
.comments-empty{
  font-size: 12px; color: var(--ink-4);
  font-style: italic; padding: 4px 0;
}

/* ═════════════════════════════════════════════════════════════
   ACTIVITY — work session log (below tasks)
   ═════════════════════════════════════════════════════════════ */
.activity-table{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow:hidden;
  box-shadow: var(--shadow-sm);
}
.activity-head, .activity-row{
  display:grid;
  grid-template-columns: 140px 140px 84px 1fr 90px;
  gap:16px; align-items:center;
  padding: 10px 20px;
}
.activity-head{
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  font-family: var(--mono);
  font-size: 10.5px; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--ink-3);
  font-weight: 500;
}
.activity-row{
  border-bottom: 1px solid var(--surface-3);
  transition: background .1s ease;
  font-size:13px;
}
.activity-row:last-child{border-bottom:none;}
.activity-row:hover{background: var(--surface-2);}
.activity-row .time{
  font-family:var(--mono); font-size:12px;
  color:var(--ink-2); font-variant-numeric: tabular-nums;
  display:flex; flex-direction:column; gap:1px;
}
.activity-row .time .day{
  font-size:10.5px; color:var(--ink-4); text-transform:uppercase; letter-spacing:0.03em;
}
.activity-row .duration{
  font-family:var(--mono); font-size:12px;
  color:var(--ink); font-weight:500;
  font-variant-numeric: tabular-nums;
  padding: 3px 8px; background: var(--accent-soft);
  color: var(--accent-ink);
  border-radius:5px; text-align:center; justify-self:start;
}
.activity-row .what{
  color:var(--ink); font-size:13px; line-height:1.4;
  text-wrap:pretty;
}
.activity-row .rel{
  font-family:var(--mono); font-size:11px;
  color:var(--ink-4); text-align:right;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 780px){
  .activity-head{display:none;}
  .activity-row{
    grid-template-columns: 1fr;
    gap:6px; padding:14px 16px;
    border-bottom:1px solid var(--border);
  }
  .activity-row .rel{text-align:left;}
  .activity-row .duration{justify-self:start;}
  .activity-row .time{flex-direction:row; gap:10px; flex-wrap:wrap;}
}
.activity-empty{
  padding: 40px 20px; text-align:center;
  color:var(--ink-4); font-size:13px;
}

/* ═════════════════════════════════════════════════════════════
   NOTEPAD
   ═════════════════════════════════════════════════════════════ */
.notepad-card{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow:hidden;
  box-shadow: var(--shadow-sm);
}
textarea#notepad{
  width:100%; min-height:160px;
  border:none; outline:none; resize:vertical;
  padding: 16px 20px; font-family:var(--sans);
  font-size:14px; line-height:1.6; color:var(--ink);
  background:transparent; display:block;
}
.notepad-foot{
  display:flex; justify-content:space-between; align-items:center;
  padding: 10px 16px;
  border-top:1px solid var(--border);
  background: var(--surface-2);
  font-size: 12px; color: var(--ink-3);
}
.notepad-foot .save-state{display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px;}
.notepad-foot .save-state .dot{
  width:6px; height:6px; border-radius:50%; background:var(--done);
}
.notepad-foot .save-state.saving .dot{background:var(--progress); animation: pulse 1s infinite;}

/* ═════════════════════════════════════════════════════════════
   INPUTS / BUTTONS
   ═════════════════════════════════════════════════════════════ */
input[type=text], input[type=password], input:not([type]), textarea, select{
  font-family:var(--sans); font-size:13px;
  background:var(--surface); color:var(--ink);
  border:1px solid var(--border-strong);
  border-radius:6px; padding: 7px 10px;
  transition: border-color .12s ease, box-shadow .12s ease;
  outline:none;
}
input:focus, textarea:focus, select:focus{
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 18%, transparent);
}
input::placeholder, textarea::placeholder{color:var(--ink-4);}

button{font-family:var(--sans); cursor:pointer; border:none;}
.btn{
  display:inline-flex; align-items:center; gap:6px;
  padding: 7px 12px; border-radius:6px;
  font-size:13px; font-weight:500;
  background: var(--ink); color:#fff;
  transition: background .12s ease, transform .06s ease, box-shadow .12s ease;
  box-shadow: var(--shadow-sm);
}
.btn:hover{background:#000;}
.btn:active{transform: translateY(1px);}
.btn.primary{background: var(--accent);}
.btn.primary:hover{background: var(--accent-hover);}
.btn.ghost{
  background: var(--surface); color: var(--ink);
  border:1px solid var(--border-strong);
}
.btn.ghost:hover{background: var(--surface-2);}
.btn.subtle{
  background: transparent; color:var(--ink-2);
  padding: 5px 8px;
}
.btn.subtle:hover{background: var(--surface-2); color:var(--ink);}
.btn.danger{
  background: transparent; color:var(--danger);
  border:1px solid var(--border-strong);
}
.btn.danger:hover{background:var(--danger); color:#fff; border-color:var(--danger);}
.btn.sm{padding: 5px 9px; font-size:12px;}
.btn.xs{padding: 3px 7px; font-size:11.5px; font-family:var(--mono);}
.link-btn{
  background:none; border:none; padding:0; font: inherit;
  color:var(--accent-ink); cursor:pointer; text-decoration:none;
}
.link-btn:hover{color:var(--accent); text-decoration:underline;}

/* ═════════════════════════════════════════════════════════════
   UNLOCK MODAL
   ═════════════════════════════════════════════════════════════ */
.unlock-overlay{
  position:fixed; inset:0; z-index:60;
  background: rgba(10,10,15,0.45);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  display:flex; align-items:center; justify-content:center;
  animation: fadein .15s ease;
}
@keyframes fadein{from{opacity:0;}to{opacity:1;}}
.unlock-box{
  background:var(--surface);
  border-radius: var(--radius-lg);
  padding: 24px;
  width: 360px;
  box-shadow: var(--shadow-lg);
  border:1px solid var(--border);
}
.unlock-box .icon{
  width:36px; height:36px; border-radius:8px;
  background: var(--accent-soft); color: var(--accent);
  display:flex; align-items:center; justify-content:center;
  margin-bottom: 14px;
}
.unlock-box h3{
  font-size:17px; font-weight:600; letter-spacing:-0.01em;
  margin: 0 0 4px;
}
.unlock-box p{
  font-size:13px; color:var(--ink-3); margin: 0 0 16px;
  line-height:1.5;
}
.unlock-box input{width:100%; margin-bottom:12px; padding: 9px 12px; font-size:14px;}
.unlock-box .actions{display:flex; gap:8px; justify-content:flex-end;}

/* ═════════════════════════════════════════════════════════════
   DASHBOARD (admin)
   ═════════════════════════════════════════════════════════════ */
#dashboard{
  position:fixed; inset:0; z-index:40;
  background:var(--bg); overflow-y:auto;
}
.dash-nav{
  position:sticky; top:0; z-index:5;
  height:52px;
  display:flex; align-items:center; gap:20px;
  padding: 0 24px;
  background: rgba(255,255,255,0.85);
  backdrop-filter: saturate(180%) blur(12px);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  border-bottom:1px solid var(--border);
}
.dash-nav .brand{
  display:flex; align-items:center; gap:10px;
  font-weight:600; font-size:14px;
}
.dash-nav .brand .mark{
  width:24px; height:24px; border-radius:6px;
  background: linear-gradient(135deg, var(--accent), #7c3aed);
  display:flex; align-items:center; justify-content:center;
  color:#fff; font-weight:700; font-size:12px;
}
.dash-nav .brand .sub{
  color:var(--ink-3); font-weight:400;
  padding: 2px 8px; background:var(--surface-2); border-radius:5px;
  font-size:11.5px; font-family:var(--mono);
  border:1px solid var(--border);
  margin-left: 4px;
}
.dash-nav .spacer{flex:1;}
.dash-nav .clock{
  font-family:var(--mono); font-size:12px; color:var(--ink-3);
  font-variant-numeric: tabular-nums;
}

.dash-shell{max-width:1400px; margin:0 auto; padding: 24px 24px 100px;}

/* Timer hero */
.timer-hero{
  background: linear-gradient(135deg, #0a0a0f 0%, #1c1c25 100%);
  color:#fff;
  border-radius: var(--radius-lg);
  padding: 24px;
  margin-bottom: 24px;
  display:grid; grid-template-columns: 1fr auto; gap: 24px;
  align-items:center;
  position:relative; overflow:hidden;
  box-shadow: 0 8px 24px rgba(10,10,15,0.16);
}
.timer-hero::before{
  content:''; position:absolute; inset:0;
  background: radial-gradient(600px 200px at 100% 0%, rgba(91,91,214,0.25), transparent 60%);
  pointer-events:none;
}
.timer-hero .label{
  font-family:var(--mono); font-size:11px; letter-spacing:0.08em;
  text-transform:uppercase; color: rgba(255,255,255,0.55);
  display:flex; align-items:center; gap:8px;
  margin-bottom:8px;
}
.timer-hero .label .live-dot{
  width:6px; height:6px; border-radius:50%; background:#22c55e;
  box-shadow: 0 0 0 3px rgba(34,197,94,0.25);
  animation: pulse 1.5s infinite;
}
.timer-hero .display{
  font-family:var(--mono); font-weight:500;
  font-size: clamp(40px, 6vw, 60px);
  line-height:1; letter-spacing:-0.02em;
  font-variant-numeric: tabular-nums;
}
.timer-hero .display.idle{color: rgba(255,255,255,0.35);}
.timer-hero .task-name{
  margin-top:10px; font-size:14px; color: rgba(255,255,255,0.85);
  font-weight:500;
}
.timer-hero .task-name.idle{color: rgba(255,255,255,0.4);}
.timer-hero .controls{
  display:flex; gap:8px; align-items:center; flex-wrap:wrap;
  z-index:1;
}
.timer-hero select{
  background: rgba(255,255,255,0.08); color:#fff;
  border-color: rgba(255,255,255,0.15);
}
.timer-hero select option{background:#1c1c25; color:#fff;}
.timer-hero .btn.stop{background:#fff; color:var(--ink);}
.timer-hero .btn.stop:hover{background:#f0f0f0;}

/* Quick add row */
.quick-add{
  display:grid; grid-template-columns: 1fr auto; gap:8px;
  padding: 12px; background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 20px;
  box-shadow: var(--shadow-sm);
}

/* Admin kanban (dashboard variant — has editable controls) */
.admin-kanban .col{background: var(--surface-2);}
.admin-kanban .tcard .card-actions{
  display:flex; justify-content:space-between; gap:6px;
  margin-top:10px; padding-top:8px;
  border-top:1px solid var(--surface-3);
}
.admin-kanban .tcard .card-actions .left{display:flex; gap:4px;}
.subtasks{margin:8px 0 0; display:flex; flex-direction:column; gap:2px;}
.subtask{
  display:flex; align-items:center; gap:8px;
  padding:3px 0; font-size:12.5px; color:var(--ink-2);
}
.subtask input[type=checkbox]{
  appearance:none; -webkit-appearance:none;
  width:14px; height:14px; border:1.5px solid var(--border-strong);
  border-radius:3px; background:transparent; cursor:pointer;
  display:inline-grid; place-content:center;
  transition: all .1s ease;
  padding:0;
}
.subtask input[type=checkbox]:checked{
  background:var(--accent); border-color:var(--accent);
}
.subtask input[type=checkbox]:checked::after{
  content:''; width:7px; height:3px;
  border-left:1.5px solid #fff; border-bottom:1.5px solid #fff;
  transform: rotate(-45deg) translate(1px,-1px);
}
.subtask.done span{text-decoration:line-through; color:var(--ink-4);}
.add-subtask{
  display:flex; gap:4px; margin-top:8px;
  padding-top:8px; border-top:1px dashed var(--border);
}
.add-subtask input{
  flex:1; font-size:12px; padding:5px 8px;
  border-color: var(--border);
}

/* Time log panels */
.log-grid{
  display:grid; grid-template-columns: 1.3fr 1fr; gap:16px;
  margin-top: 8px;
}
@media(max-width:900px){.log-grid{grid-template-columns:1fr;}}
.panel{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 20px;
  box-shadow: var(--shadow-sm);
}
.panel .panel-head{
  display:flex; justify-content:space-between; align-items:baseline;
  margin-bottom: 16px;
}
.panel .panel-head h3{
  font-size:14px; font-weight:600; margin:0;
  letter-spacing:-0.005em;
}
.panel .panel-head .meta{
  font-family:var(--mono); font-size:11px; color:var(--ink-3);
}
.chart{
  display:grid; grid-template-columns: repeat(7,1fr);
  gap:12px; align-items:end;
  height:160px; padding: 8px 0 24px;
  position:relative;
  border-bottom:1px solid var(--border);
}
.chart::before, .chart::after{
  content:''; position:absolute; left:0; right:0; height:1px;
  background: var(--surface-3);
}
.chart::before{top:33%;}
.chart::after{top:66%;}
.chart .bar{
  height:100%; display:flex; flex-direction:column;
  align-items:center; justify-content:end;
  position:relative;
}
.chart .bar .fill{
  width:100%; max-width:36px; min-height:2px;
  background: var(--accent);
  border-radius: 4px 4px 0 0;
  transition: height .3s ease;
}
.chart .bar.today .fill{background: var(--ink);}
.chart .bar .val{
  position:absolute; top:-16px;
  font-family:var(--mono); font-size:10px;
  color:var(--ink-3); font-variant-numeric: tabular-nums;
}
.chart .bar .day{
  position:absolute; bottom:-20px;
  font-family:var(--mono); font-size:10px;
  color:var(--ink-4); text-transform:uppercase;
}
.chart .bar.today .day{color:var(--ink); font-weight:600;}

.log-list{max-height: 480px; overflow-y:auto;}
.log-row{
  display:grid; grid-template-columns: 56px 1fr auto; gap:12px;
  padding: 10px 0; align-items:start;
  border-bottom: 1px dashed var(--border);
}
.log-row:last-child{border-bottom:none;}
.log-row .dur-chip{
  font-family:var(--mono); font-size:12px; font-weight:600;
  color:var(--accent-ink); background:var(--accent-soft);
  padding: 4px 8px; border-radius:5px; text-align:center;
  font-variant-numeric: tabular-nums;
}
.log-row .body .task{font-size:13px; color:var(--ink); font-weight:500;}
.log-row .body .note{font-size:12px; color:var(--ink-3); margin-top:2px;}
.log-row .when{
  font-family:var(--mono); font-size:10.5px; color:var(--ink-4);
  text-align:right; font-variant-numeric: tabular-nums;
}
.panel-empty{
  padding: 24px 8px; text-align:center;
  color: var(--ink-4); font-size:12.5px;
}

/* ─ Toast ─────────────────────────────────────────── */
#toast{
  position:fixed; bottom:24px; left:50%;
  transform: translateX(-50%) translateY(20px);
  background: var(--ink); color: #fff;
  padding: 10px 14px; border-radius: 8px;
  font-size:13px; font-weight:500;
  opacity:0; pointer-events:none; z-index:100;
  transition: opacity .18s ease, transform .18s ease;
  box-shadow: var(--shadow-lg);
}
#toast.show{opacity:1; transform: translateX(-50%) translateY(0);}
`;

const BODY = `
<!-- ─────────── Public site ─────────── -->
<div id="public-view">

  <nav class="topnav">
    <div class="brand">
      <div class="mark">A</div>
      Andrew's Work <span class="sub">/ Quilling Card</span>
    </div>
    <div class="breadcrumb">
      <span class="sep">›</span>
      <span>Workspace</span>
    </div>
    <div class="spacer"></div>
    <span class="status-chip"><span class="dot"></span>Live</span>
    <span class="clock" id="local-clock">--:--:--</span>
    <span class="kbd" title="Admin reveal"><kbd>Space</kbd>×<kbd>3</kbd></span>
  </nav>

  <main class="shell">

    <header class="page-header">
      <div class="title-block">
        <h1>What I'm working on</h1>
        <p>A live view of tasks, activity, and shared notes.</p>
      </div>
      <div class="stats" id="header-stats"></div>
    </header>

    <!-- 1. TASKS (kanban) -->
    <section class="section">
      <div class="section-header">
        <div class="heading">
          <h2>Tasks</h2>
          <span class="count" id="tasks-count">0</span>
        </div>
      </div>
      <div class="kanban" id="kanban"></div>
    </section>

    <!-- 2. ACTIVITY (work sessions with start/end/duration) -->
    <section class="section">
      <div class="section-header">
        <div class="heading">
          <h2>Activity</h2>
          <span class="count" id="activity-count">0</span>
        </div>
      </div>
      <div class="activity-table">
        <div class="activity-head">
          <div>Start</div>
          <div>End</div>
          <div>Duration</div>
          <div>What</div>
          <div style="text-align:right;">When</div>
        </div>
        <div id="activity-list"></div>
      </div>
    </section>

    <!-- 3. NOTEPAD -->
    <section class="section">
      <div class="section-header">
        <div class="heading">
          <h2>Shared notepad</h2>
        </div>
        <span style="font-size:12px;color:var(--ink-3);">Anyone can edit · autosaves</span>
      </div>
      <div class="notepad-card">
        <textarea id="notepad" spellcheck="false" placeholder="Drop a note, a link, an idea…"></textarea>
        <div class="notepad-foot">
          <span>Public · rate-limited</span>
          <span class="save-state" id="notepad-status"><span class="dot"></span><span class="label">Saved</span></span>
        </div>
      </div>
    </section>

  </main>
</div>

<!-- ─────────── Unlock modal ─────────── -->
<div class="unlock-overlay hidden" id="unlock-overlay">
  <form class="unlock-box" onsubmit="event.preventDefault(); login();">
    <div class="icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    </div>
    <h3>Unlock dashboard</h3>
    <p>Enter your admin passcode. This device will be remembered until you log out.</p>
    <input id="passcode" type="password" placeholder="Passcode" autocomplete="off" />
    <div class="actions">
      <button type="button" class="btn ghost" onclick="closeUnlock()">Cancel</button>
      <button type="submit" class="btn primary">Unlock</button>
    </div>
  </form>
</div>

<!-- ─────────── Admin dashboard ─────────── -->
<div id="dashboard" class="hidden">

  <nav class="dash-nav">
    <div class="brand">
      <div class="mark">A</div>
      Andrew's Work <span class="sub">Admin</span>
    </div>
    <div class="spacer"></div>
    <span class="clock" id="dash-clock">--:--:--</span>
    <button class="btn ghost sm" onclick="closeDashboard()">Close</button>
    <button class="btn danger sm" onclick="logout()">Log out device</button>
  </nav>

  <div class="dash-shell">

    <!-- Timer -->
    <div class="timer-hero" id="clock-widget"></div>

    <!-- Log activity + Add task -->
    <div class="section" style="margin-bottom:20px;">
      <div class="section-header">
        <div class="heading"><h2>Log a session</h2></div>
      </div>
      <div class="quick-add" style="grid-template-columns: 1fr 120px 120px 90px auto;">
        <input id="activity-text" placeholder="What did you work on?" />
        <input id="activity-start" type="time" title="Start" />
        <input id="activity-end" type="time" title="End" />
        <input id="activity-dur" type="number" placeholder="Min" title="Duration (min) — leave blank to auto-calc" />
        <button class="btn primary" onclick="addActivity()">Log</button>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="heading"><h2>Tasks</h2></div>
      </div>
      <div class="quick-add">
        <input id="task-input" placeholder="Add a new task…" onkeydown="if(event.key==='Enter') addTask()" />
        <button class="btn primary" onclick="addTask()">Add task</button>
      </div>
      <div class="kanban admin-kanban" id="admin-board"></div>
    </div>

    <!-- Time log (from timer) -->
    <section class="section" style="margin-top:32px;">
      <div class="section-header">
        <div class="heading"><h2>Time log</h2></div>
        <span style="font-size:12px;color:var(--ink-3);">Last 7 days from time clock</span>
      </div>
      <div class="log-grid">
        <div class="panel">
          <div class="panel-head">
            <h3>Hours per day</h3>
            <span class="meta" id="chart-total">—</span>
          </div>
          <div class="chart" id="chart"></div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <h3>Recent entries</h3>
            <span class="meta" id="log-count">—</span>
          </div>
          <div class="log-list" id="timelog-list"></div>
        </div>
      </div>
    </section>

  </div>
</div>

<div id="toast"></div>
`;

const JS = `
let TOKEN = localStorage.getItem('adminToken') || null;
let DATA = null;
let notepadTimer = null;
let dashboardOpen = false;

async function api(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (TOKEN) opts.headers['X-Admin-Token'] = TOKEN;
  if (opts.body) opts.headers['Content-Type'] = 'application/json';
  return fetch(path, opts);
}

function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2000);
}

async function load() {
  const res = await api('/api/data');
  DATA = await res.json();
  if (!DATA.isAdmin) { TOKEN = null; localStorage.removeItem('adminToken'); }
  renderPublic();
  if (dashboardOpen) renderDashboard();
}

/* ── formatters ─────────────────────────────────── */
function escapeHtml(s){return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function pad(n){return String(n).padStart(2,'0');}
function timeOf(iso){
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit', hour12:false});
}
function dayOf(iso){
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {month:'short', day:'numeric'});
}
function shortDate(iso){
  const d = new Date(iso);
  return pad(d.getMonth()+1)+'/'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());
}
function relTime(iso){
  const diff = (Date.now() - new Date(iso).getTime())/1000;
  if (diff < 60) return Math.floor(diff)+'s ago';
  if (diff < 3600) return Math.floor(diff/60)+'m ago';
  if (diff < 86400) return Math.floor(diff/3600)+'h ago';
  return Math.floor(diff/86400)+'d ago';
}
function fmtDur(mins){
  if (mins == null) return '—';
  if (mins < 60) return mins+'m';
  const h = Math.floor(mins/60), m = mins%60;
  return m ? h+'h '+m+'m' : h+'h';
}
function statusLabel(s){return {todo:'Todo',inprogress:'In progress',completed:'Completed'}[s]||s;}

/* ── live clock ─────────────────────────────────── */
function tickClock(){
  const now = new Date();
  const t = pad(now.getHours())+':'+pad(now.getMinutes())+':'+pad(now.getSeconds());
  const lc = document.getElementById('local-clock'); if (lc) lc.textContent = t;
  const dc = document.getElementById('dash-clock'); if (dc) dc.textContent = t;
  if (DATA?.activeTimer){
    const el = document.getElementById('timer-elapsed');
    if (el){
      const secs = Math.floor((Date.now() - new Date(DATA.activeTimer.start).getTime())/1000);
      el.textContent = pad(Math.floor(secs/3600))+':'+pad(Math.floor((secs%3600)/60))+':'+pad(secs%60);
    }
  }
}
setInterval(tickClock, 1000); tickClock();

/* ═════════════════════════════════════════════════
   PUBLIC RENDER
   ═════════════════════════════════════════════════ */
function renderPublic(){
  // Header stats
  const counts = DATA.tasks.reduce((acc,t)=>{acc[t.status]=(acc[t.status]||0)+1;return acc;},{});
  const stats = document.getElementById('header-stats');
  stats.innerHTML = \`
    <div class="stat-pill"><span class="swatch" style="background:var(--todo);"></span><span class="num">\${counts.todo||0}</span> Todo</div>
    <div class="stat-pill"><span class="swatch" style="background:var(--progress);"></span><span class="num">\${counts.inprogress||0}</span> In progress</div>
    <div class="stat-pill"><span class="swatch" style="background:var(--done);"></span><span class="num">\${counts.completed||0}</span> Completed</div>
  \`;
  document.getElementById('tasks-count').textContent = DATA.tasks.length;
  document.getElementById('activity-count').textContent = DATA.activity.length;

  // KANBAN (public read-only)
  renderKanban('kanban', false);

  // ACTIVITY TABLE
  const alist = document.getElementById('activity-list');
  alist.innerHTML = DATA.activity.length ? DATA.activity.map(a => {
    // Backward compat: old rows only have \`date\`
    const start = a.startedAt || a.date;
    const end = a.endedAt || a.date;
    const dur = a.duration != null ? a.duration :
      Math.max(1, Math.round((new Date(end) - new Date(start))/60000));
    const sameDay = start.slice(0,10) === end.slice(0,10);
    return \`
    <div class="activity-row">
      <div class="time"><span>\${timeOf(start)}</span><span class="day">\${dayOf(start)}</span></div>
      <div class="time"><span>\${timeOf(end)}</span>\${sameDay ? '' : '<span class="day">'+dayOf(end)+'</span>'}</div>
      <div class="duration">\${fmtDur(dur)}</div>
      <div class="what">\${escapeHtml(a.text)}</div>
      <div class="rel">\${relTime(start)}</div>
    </div>\`;
  }).join('') : '<div class="activity-empty">No sessions logged yet.</div>';

  // Notepad
  document.getElementById('notepad').value = DATA.notepad || '';
}

/* Kanban renderer (shared public + admin) */
function renderKanban(mountId, isAdmin){
  const mount = document.getElementById(mountId);
  if (!mount) return;
  const cols = [
    ['todo', 'To-do'],
    ['inprogress', 'In progress'],
    ['completed', 'Completed'],
  ];
  mount.innerHTML = cols.map(([key,label]) => {
    const items = DATA.tasks.filter(t => t.status === key);
    return \`
      <div class="col" data-status="\${key}">
        <div class="col-header">
          <div class="title-row">
            <span class="swatch"></span>
            <span class="name">\${label}</span>
          </div>
          <span class="count-chip">\${items.length}</span>
        </div>
        <div class="col-body">
          \${items.length ? items.map(t => isAdmin ? adminCard(t) : publicCard(t)).join('') : '<div class="col-empty">No tasks here</div>'}
        </div>
      </div>\`;
  }).join('');
}

/* Public read-only task card */
function publicCard(t){
  const doneSub = t.subtasks.filter(s=>s.done).length;
  const totalSub = t.subtasks.length;
  const pct = totalSub ? Math.round((doneSub/totalSub)*100) : 0;
  const c = t.comments.length;
  return \`<article class="tcard" data-status="\${t.status}">
    <div class="tcard-head">
      <p class="tcard-title">\${escapeHtml(t.text)}</p>
      <span class="tcard-id">#\${t.id.slice(0,4)}</span>
    </div>
    \${totalSub || c ? \`<div class="tcard-meta">
      \${totalSub ? \`<span class="progress-mini"><span class="bar"><span style="width:\${pct}%"></span></span>\${doneSub}/\${totalSub}</span>\` : ''}
      <button class="comments-btn" onclick="toggleComments('\${t.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        \${c}
      </button>
    </div>\` : \`<div class="tcard-meta"><button class="comments-btn" onclick="toggleComments('\${t.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        \${c} comment\${c===1?'':'s'}
      </button></div>\`}
    <div class="comments-panel hidden" id="comments-\${t.id}">
      \${t.comments.length ? t.comments.map(c => \`
        <div class="comment">
          <div class="head">
            <span class="who">\${escapeHtml(c.name)}</span>
            <span class="when">\${relTime(c.ts)}</span>
          </div>
          <div class="body">\${escapeHtml(c.text)}</div>
        </div>\`).join('') : '<div class="comments-empty">No comments yet.</div>'}
      <div class="comment-form">
        <div class="row">
          <input name="name" placeholder="Your name" />
          <input name="text" placeholder="Add a comment…" onkeydown="if(event.key==='Enter') submitComment('\${t.id}', this)" />
          <button class="btn primary sm" onclick="submitComment('\${t.id}', this.previousElementSibling)">Post</button>
        </div>
      </div>
    </div>
  </article>\`;
}

function toggleComments(id){ document.getElementById('comments-'+id).classList.toggle('hidden'); }

async function submitComment(taskId, textInput){
  const form = textInput.closest('.comment-form');
  const name = form.querySelector('[name=name]').value;
  const text = form.querySelector('[name=text]').value;
  if(!name.trim() || !text.trim()){ toast('Name and comment both required'); return; }
  const res = await api('/api/tasks/'+taskId+'/comments', { method:'POST', body: JSON.stringify({ name, text }) });
  if (!res.ok){ toast('Could not post comment'); return; }
  toast('Comment posted');
  load();
}

/* Notepad autosave */
document.getElementById('notepad').addEventListener('input', (e) => {
  const status = document.getElementById('notepad-status');
  status.classList.add('saving');
  status.querySelector('.label').textContent = 'Saving…';
  clearTimeout(notepadTimer);
  notepadTimer = setTimeout(async () => {
    await api('/api/notepad', { method:'PUT', body: JSON.stringify({ content: e.target.value }) });
    status.classList.remove('saving');
    status.querySelector('.label').textContent = 'Saved · '+new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  }, 700);
});

/* ── reveal gestures ────────────────────────────── */
let spaceCount = 0, spaceTimer = null;
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  if (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT') return;
  spaceCount++;
  clearTimeout(spaceTimer);
  spaceTimer = setTimeout(() => spaceCount = 0, 1500);
  if (spaceCount >= 3) { spaceCount = 0; triggerReveal(); }
});
let touchPath = [];
document.addEventListener('touchstart', (e) => { touchPath = [{x:e.touches[0].clientX, y:e.touches[0].clientY}]; });
document.addEventListener('touchmove', (e) => { touchPath.push({x:e.touches[0].clientX, y:e.touches[0].clientY}); });
document.addEventListener('touchend', () => {
  if (touchPath.length < 6) return;
  const xs = touchPath.map(p=>p.x), ys = touchPath.map(p=>p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const minY = Math.min(...ys);
  const start = touchPath[0], end = touchPath[touchPath.length-1];
  const edgeAvgY = (start.y + end.y) / 2;
  const dip = edgeAvgY - minY;
  if (width > 90 && dip > 40 && start.y > minY + 20 && end.y > minY + 20) triggerReveal();
  touchPath = [];
});

function triggerReveal(){
  if (TOKEN) openDashboard();
  else { document.getElementById('unlock-overlay').classList.remove('hidden'); setTimeout(()=>document.getElementById('passcode').focus(),50); }
}
function closeUnlock(){ document.getElementById('unlock-overlay').classList.add('hidden'); }

async function login(){
  const passcode = document.getElementById('passcode').value;
  const res = await api('/api/admin/login', { method:'POST', body: JSON.stringify({ passcode }) });
  if (!res.ok) { toast('Wrong passcode'); return; }
  const { token } = await res.json();
  TOKEN = token;
  localStorage.setItem('adminToken', token);
  closeUnlock();
  await load();
  openDashboard();
}
function logout(){ TOKEN = null; localStorage.removeItem('adminToken'); closeDashboard(); load(); toast('Logged out'); }

function openDashboard(){ dashboardOpen = true; document.getElementById('dashboard').classList.remove('hidden'); renderDashboard(); }
function closeDashboard(){ dashboardOpen = false; document.getElementById('dashboard').classList.add('hidden'); }

/* ═════════════════════════════════════════════════
   DASHBOARD (admin)
   ═════════════════════════════════════════════════ */
function renderDashboard(){
  if (!DATA.isAdmin) return;
  renderClock();
  renderKanban('admin-board', true);
  renderTimelog();
}

function renderClock(){
  const el = document.getElementById('clock-widget');
  if (DATA.activeTimer){
    const task = DATA.tasks.find(t=>t.id===DATA.activeTimer.taskId);
    el.innerHTML = \`
      <div>
        <div class="label"><span class="live-dot"></span>Timer running · since \${timeOf(DATA.activeTimer.start)}</div>
        <div class="display" id="timer-elapsed">00:00:00</div>
        <div class="task-name">\${task ? escapeHtml(task.text) : '(unknown task)'}</div>
      </div>
      <div class="controls">
        <button class="btn stop" onclick="stopTimer()">Stop &amp; log</button>
      </div>\`;
  } else {
    el.innerHTML = \`
      <div>
        <div class="label">Time clock — idle</div>
        <div class="display idle">00:00:00</div>
        <div class="task-name idle">Pick a task and start the clock</div>
      </div>
      <div class="controls">
        <select id="timer-task">
          \${DATA.tasks.filter(t=>t.status!=='completed').map(t=>\`<option value="\${t.id}">\${escapeHtml(t.text)}</option>\`).join('') || '<option>No open tasks</option>'}
        </select>
        <button class="btn primary" onclick="startTimer()">Start</button>
      </div>\`;
  }
}

async function startTimer(){
  const sel = document.getElementById('timer-task');
  const taskId = sel && sel.value;
  if (!taskId) { toast('Add an open task first'); return; }
  await api('/api/timer/start', { method:'POST', body: JSON.stringify({ taskId }) });
  await load();
}
async function stopTimer(){
  const note = prompt('What did you work on?') || '';
  await api('/api/timer/stop', { method:'POST', body: JSON.stringify({ note }) });
  await load();
  toast('Time entry logged');
}

/* Admin task card (with actions) */
function adminCard(t){
  const nextStatus = { todo:'inprogress', inprogress:'completed', completed:'todo' };
  const nextLabel  = { todo:'Start →', inprogress:'Complete ✓', completed:'Reopen ↺' };
  const prevStatus = { inprogress:'todo', completed:'inprogress' };
  return \`<article class="tcard" data-status="\${t.status}">
    <div class="tcard-head">
      <p class="tcard-title">\${escapeHtml(t.text)}</p>
      <span class="tcard-id">#\${t.id.slice(0,4)}</span>
    </div>
    \${t.subtasks.length ? \`<div class="subtasks">
      \${t.subtasks.map(s => \`<div class="subtask \${s.done?'done':''}">
        <input type="checkbox" \${s.done?'checked':''} onchange="toggleSubtask('\${t.id}','\${s.id}',this.checked)" />
        <span>\${escapeHtml(s.text)}</span>
      </div>\`).join('')}
    </div>\` : ''}
    <div class="add-subtask">
      <input placeholder="+ subtask" onkeydown="if(event.key==='Enter') addSubtask('\${t.id}', this)" />
      <button class="btn subtle xs" onclick="addSubtask('\${t.id}', this.previousElementSibling)">Add</button>
    </div>
    <div class="card-actions">
      <div class="left">
        \${prevStatus[t.status] ? \`<button class="btn subtle xs" title="Move back" onclick="moveTask('\${t.id}','\${prevStatus[t.status]}')">←</button>\` : ''}
        <button class="btn ghost sm" onclick="moveTask('\${t.id}','\${nextStatus[t.status]}')">\${nextLabel[t.status]}</button>
      </div>
      <button class="btn subtle xs" onclick="delTask('\${t.id}')" title="Delete">✕</button>
    </div>
  </article>\`;
}

async function addTask(){
  const input = document.getElementById('task-input');
  if (!input.value.trim()) return;
  await api('/api/tasks', { method:'POST', body: JSON.stringify({ text: input.value }) });
  input.value = '';
  await load();
  toast('Task added');
}
async function moveTask(id, status){ await api('/api/tasks/'+id, { method:'PUT', body: JSON.stringify({ status }) }); await load(); }
async function delTask(id){ if(!confirm('Delete this task?')) return; await api('/api/tasks/'+id, { method:'DELETE' }); await load(); toast('Task deleted'); }
async function addSubtask(taskId, input){
  if (!input.value.trim()) return;
  await api('/api/tasks/'+taskId+'/subtasks', { method:'POST', body: JSON.stringify({ text: input.value }) });
  input.value = '';
  await load();
}
async function toggleSubtask(taskId, subId, done){
  await api('/api/tasks/'+taskId+'/subtasks/'+subId, { method:'PUT', body: JSON.stringify({ done }) });
  await load();
}

/* Log an activity session with start/end/duration */
async function addActivity(){
  const text = document.getElementById('activity-text').value.trim();
  const startVal = document.getElementById('activity-start').value; // "HH:MM"
  const endVal   = document.getElementById('activity-end').value;
  const durVal   = document.getElementById('activity-dur').value;
  if (!text) { toast('Add a description'); return; }

  const today = new Date();
  function toISO(hm){
    if (!hm) return null;
    const [h,m] = hm.split(':').map(Number);
    const d = new Date(today); d.setHours(h, m, 0, 0);
    return d.toISOString();
  }
  let startedAt = toISO(startVal);
  let endedAt   = toISO(endVal);
  let duration  = durVal ? parseInt(durVal,10) : null;

  const now = new Date().toISOString();
  if (!startedAt && !endedAt && !duration) {
    // no times entered — default to "just now, 0 min"
    startedAt = now; endedAt = now; duration = 1;
  } else if (startedAt && !endedAt && duration) {
    endedAt = new Date(new Date(startedAt).getTime() + duration*60000).toISOString();
  } else if (!startedAt && endedAt && duration) {
    startedAt = new Date(new Date(endedAt).getTime() - duration*60000).toISOString();
  } else if (startedAt && endedAt && !duration) {
    duration = Math.max(1, Math.round((new Date(endedAt) - new Date(startedAt))/60000));
  } else if (startedAt && !endedAt) {
    endedAt = now;
    duration = duration || Math.max(1, Math.round((new Date(endedAt) - new Date(startedAt))/60000));
  } else if (!startedAt && endedAt) {
    startedAt = endedAt;
    duration = duration || 1;
  }

  await api('/api/activity', { method:'POST', body: JSON.stringify({ text, startedAt, endedAt, duration }) });
  document.getElementById('activity-text').value = '';
  document.getElementById('activity-start').value = '';
  document.getElementById('activity-end').value = '';
  document.getElementById('activity-dur').value = '';
  await load();
  toast('Session logged');
}

function renderTimelog(){
  const logs = DATA.timeLogs || [];
  const byDay = {};
  logs.forEach(l => { const d = l.start.slice(0,10); byDay[d] = (byDay[d]||0) + l.minutes; });

  const days = [];
  const today = new Date();
  for (let i=6;i>=0;i--){
    const d = new Date(today); d.setDate(today.getDate()-i);
    const k = d.toISOString().slice(0,10);
    days.push({ key:k, date:d, minutes: byDay[k]||0 });
  }
  const maxMin = Math.max(60, ...days.map(d=>d.minutes));
  const totalMin = days.reduce((s,d)=>s+d.minutes,0);
  document.getElementById('chart-total').textContent = (totalMin/60).toFixed(1)+'h total';
  document.getElementById('log-count').textContent = logs.length + ' entries';

  const chart = document.getElementById('chart');
  chart.innerHTML = days.map((d,i) => {
    const pct = Math.round((d.minutes/maxMin)*100);
    const hrs = d.minutes ? (d.minutes/60).toFixed(1)+'h' : '';
    const isToday = i === days.length-1;
    const label = d.date.toLocaleDateString(undefined,{weekday:'short'}).slice(0,3);
    return \`<div class="bar \${isToday?'today':''}">
      \${hrs ? \`<span class="val">\${hrs}</span>\` : ''}
      <div class="fill" style="height:\${pct}%"></div>
      <span class="day">\${label}</span>
    </div>\`;
  }).join('');

  const list = document.getElementById('timelog-list');
  list.innerHTML = logs.length ? logs.slice(0,30).map(l => {
    const task = DATA.tasks.find(t=>t.id===l.taskId);
    return \`<div class="log-row">
      <div class="dur-chip">\${(l.minutes/60).toFixed(1)}h</div>
      <div class="body">
        <div class="task">\${task?escapeHtml(task.text):'(deleted task)'}</div>
        \${l.note?'<div class="note">'+escapeHtml(l.note)+'</div>':''}
      </div>
      <div class="when">\${shortDate(l.start)}</div>
    </div>\`;
  }).join('') : '<div class="panel-empty">No time logged yet.</div>';
}

load();
`;
