var __freeze = Object.freeze;
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __template = (cooked, raw) => __freeze(__defProp(cooked, "raw", { value: __freeze(raw || cooked.slice()) }));

// worker.js
var DEFAULT_DATA = {
  activity: [],
  // {id, text, startedAt, endedAt, duration}  (legacy: {id,text,date})
  tasks: [],
  timeLogs: [],
  activeTimer: null,
  notepad: "",
  notebookDocs: [],
  // {id, title, content, updatedAt}
  tokens: [],
  // {token, role: 'owner' | 'team', createdAt}
  aiScanLog: []
  // {id, ts, sourceCount, preview} — one entry per "Analyze with AI" run on the Analytics page
};
function uid() {
  return crypto.randomUUID().slice(0, 8);
}
__name(uid, "uid");
var PROFILE_IMG = "/profile.jpg";
var FAVICON_IMG = "/favicon.png";
async function getData(env) {
  const raw = await env.SITE_DATA.get("site-data");
  if (!raw) return structuredClone(DEFAULT_DATA);
  return { ...structuredClone(DEFAULT_DATA), ...JSON.parse(raw) };
}
__name(getData, "getData");
async function saveData(env, data) {
  await env.SITE_DATA.put("site-data", JSON.stringify(data));
}
__name(saveData, "saveData");
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
__name(json, "json");
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
function getRole(request, data) {
  const token = request.headers.get("X-Admin-Token");
  if (!token) return null;
  const entry = data.tokens.find((t) => t.token === token);
  if (!entry) return null;
  if (entry.createdAt && Date.now() - entry.createdAt > TOKEN_MAX_AGE_MS) return null;
  return entry.role;
}
__name(getRole, "getRole");
async function requireOwner(request, data) {
  if (getRole(request, data) !== "owner") return json({ error: "Not authorized." }, 401);
  return null;
}
__name(requireOwner, "requireOwner");
async function requireAnyRole(request, data) {
  if (!getRole(request, data)) return json({ error: "Not authorized." }, 401);
  return null;
}
__name(requireAnyRole, "requireAnyRole");
function taskFor(data, id) {
  return data.tasks.find((t) => t.id === id);
}
__name(taskFor, "taskFor");
const LOGIN_ATTEMPT_LIMIT = 3;
const LOGIN_ATTEMPT_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
}

async function getLoginAttemptRecord(env, ip) {
  const raw = await env.SITE_DATA.get(`login-attempts:${ip}`);
  const now = Date.now();
  if (!raw) return { count: 0, windowStart: now };
  const record = JSON.parse(raw);
  if (now - record.windowStart > LOGIN_ATTEMPT_WINDOW_MS) {
    return { count: 0, windowStart: now };
  }
  return record;
}

async function recordFailedLogin(env, ip, record) {
  const updated = { count: record.count + 1, windowStart: record.windowStart };
  await env.SITE_DATA.put(`login-attempts:${ip}`, JSON.stringify(updated), {
    expirationTtl: Math.ceil(LOGIN_ATTEMPT_WINDOW_MS / 1000),
  });
}

async function clearLoginAttempts(env, ip) {
  await env.SITE_DATA.delete(`login-attempts:${ip}`);
}

async function handleApi(request, env, pathname) {
  const method = request.method;
  if (pathname === "/api/debug-env" && method === "GET") {
    return json({
      hasAdminPasscode: !!env.ADMIN_PASSCODE,
      hasTeamPasscode: !!env.TEAM_PASSCODE,
      hasKvBinding: !!(env.SITE_DATA && typeof env.SITE_DATA.get === "function")
    });
  }
  if (!env.SITE_DATA || typeof env.SITE_DATA.get !== "function") {
    return json({ error: "SITE_DATA KV binding is missing on this Worker." }, 500);
  }
  const data = await getData(env);
  const role = getRole(request, data);
  if (pathname === "/api/data" && method === "GET") {
    if (!role) return json({ error: "Not authorized." }, 401);
    const pub = {
      activity: data.activity,
      tasks: data.tasks.map((t) => ({ ...t, subtasks: t.subtasks, comments: t.comments })),
      notepad: data.notepad,
      notebookDocs: data.notebookDocs,
      timeLogs: data.timeLogs,
      activeTimer: data.activeTimer,
      role,
      // 'owner' or 'team'
      isAdmin: role === "owner"
      // kept for any old client-side references
    };
    return json(pub);
  }
  if (pathname === "/api/admin/login" && method === "POST") {
    const ip = clientIp(request);
    const attemptRecord = await getLoginAttemptRecord(env, ip);
    if (attemptRecord.count >= LOGIN_ATTEMPT_LIMIT) {
      const retryAfterMs = LOGIN_ATTEMPT_WINDOW_MS - (Date.now() - attemptRecord.windowStart);
      const retryAfterMin = Math.max(1, Math.ceil(retryAfterMs / 60000));
      return json({ error: `Too many attempts. Try again in about ${retryAfterMin} minute(s).` }, 429);
    }
    const body = await request.json().catch(() => ({}));
    let grantedRole = null;
    if (env.ADMIN_PASSCODE && body.passcode === env.ADMIN_PASSCODE) grantedRole = "owner";
    else if (env.TEAM_PASSCODE && body.passcode === env.TEAM_PASSCODE) grantedRole = "team";
    if (!grantedRole) {
      await recordFailedLogin(env, ip, attemptRecord);
      return json({ error: "Wrong passcode." }, 401);
    }
    await clearLoginAttempts(env, ip);
    const token = crypto.randomUUID();
    data.tokens.push({ token, role: grantedRole, createdAt: Date.now() });
    if (data.tokens.length > 40) data.tokens.shift();
    await saveData(env, data);
    return json({ token, role: grantedRole });
  }
  if (pathname === "/api/activity" && method === "POST") {
    const denied = await requireOwner(request, data);
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    const startedAt = body.startedAt || (/* @__PURE__ */ new Date()).toISOString();
    const endedAt = body.endedAt || (/* @__PURE__ */ new Date()).toISOString();
    let duration = Number.isFinite(body.duration) ? body.duration : Math.max(1, Math.round((new Date(endedAt) - new Date(startedAt)) / 6e4));
    data.activity.unshift({
      id: uid(),
      startedAt,
      endedAt,
      duration,
      date: startedAt
      // keep legacy field for anything that still reads it
    });
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname.match(/^\/api\/activity\/[^/]+$/) && method === "DELETE") {
    const denied = await requireOwner(request, data);
    if (denied) return denied;
    data.activity = data.activity.filter((a) => a.id !== pathname.split("/").pop());
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname === "/api/tasks" && method === "POST") {
    const denied = await requireOwner(request, data);
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    if (!body.text?.trim()) return json({ error: "Text required." }, 400);
    data.tasks.unshift({ id: uid(), text: body.text.trim(), status: "todo", createdAt: (/* @__PURE__ */ new Date()).toISOString(), subtasks: [], comments: [] });
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname.match(/^\/api\/tasks\/[^/]+$/) && (method === "PUT" || method === "DELETE")) {
    const denied = await requireOwner(request, data);
    if (denied) return denied;
    const id = pathname.split("/").pop();
    if (method === "DELETE") {
      data.tasks = data.tasks.filter((t) => t.id !== id);
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
    const denied = await requireOwner(request, data);
    if (denied) return denied;
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
    const denied = await requireOwner(request, data);
    if (denied) return denied;
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
    const denied = await requireAnyRole(request, data);
    if (denied) return denied;
    const task = taskFor(data, pathname.split("/")[3]);
    if (!task) return json({ error: "Not found." }, 404);
    const body = await request.json().catch(() => ({}));
    if (!body.name?.trim() || !body.text?.trim()) return json({ error: "Name and comment required." }, 400);
    task.comments.push({ id: uid(), name: body.name.trim().slice(0, 40), text: body.text.trim().slice(0, 500), ts: (/* @__PURE__ */ new Date()).toISOString() });
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname.match(/^\/api\/tasks\/[^/]+\/comments\/[^/]+$/) && method === "DELETE") {
    const denied = await requireOwner(request, data);
    if (denied) return denied;
    const parts = pathname.split("/");
    const task = taskFor(data, parts[3]);
    if (!task) return json({ error: "Not found." }, 404);
    task.comments = task.comments.filter((c) => c.id !== parts[5]);
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname === "/api/timer/start" && method === "POST") {
    const denied = await requireOwner(request, data);
    if (denied) return denied;
    if (data.activeTimer) return json({ error: "A timer is already running." }, 400);
    data.activeTimer = { start: (/* @__PURE__ */ new Date()).toISOString() };
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname === "/api/timer/stop" && method === "POST") {
    const denied = await requireOwner(request, data);
    if (denied) return denied;
    if (!data.activeTimer) return json({ error: "No timer running." }, 400);
    const start = new Date(data.activeTimer.start);
    const end = /* @__PURE__ */ new Date();
    const minutes = Math.max(1, Math.round((end - start) / 6e4));
    data.timeLogs.unshift({ id: uid(), start: data.activeTimer.start, end: end.toISOString(), minutes });
    data.activeTimer = null;
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname.match(/^\/api\/timelogs\/[^/]+$/) && method === "DELETE") {
    const denied = await requireOwner(request, data);
    if (denied) return denied;
    const id = pathname.split("/").pop();
    data.timeLogs = data.timeLogs.filter((l) => l.id !== id);
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname === "/api/notebook" && method === "POST") {
    const denied = await requireAnyRole(request, data);
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    const doc = {
      id: uid(),
      title: (body.title || "").trim().slice(0, 80) || "Untitled",
      content: "",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    };
    data.notebookDocs.unshift(doc);
    await saveData(env, data);
    return json({ ok: true, id: doc.id });
  }
  if (pathname.match(/^\/api\/notebook\/[^/]+$/) && (method === "PUT" || method === "DELETE")) {
    const id = pathname.split("/").pop();
    if (method === "DELETE") {
      const denied = await requireOwner(request, data);
      if (denied) return denied;
      data.notebookDocs = data.notebookDocs.filter((d) => d.id !== id);
      await saveData(env, data);
      return json({ ok: true });
    }
    const denied = await requireAnyRole(request, data);
    if (denied) return denied;
    const doc = data.notebookDocs.find((d) => d.id === id);
    if (!doc) return json({ error: "Not found." }, 404);
    const body = await request.json().catch(() => ({}));
    if (typeof body.title === "string" && body.title.trim()) doc.title = body.title.trim().slice(0, 80);
    if (typeof body.content === "string") doc.content = body.content.slice(0, 50000);
    doc.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await saveData(env, data);
    return json({ ok: true });
  }
  if (pathname === "/api/notepad" && method === "PUT") {
    const denied = await requireAnyRole(request, data);
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    data.notepad = (body.content || "").slice(0, 1e4);
    await saveData(env, data);
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}
__name(handleApi, "handleApi");
var CSS = `
/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
   Andrew's Work \u2014 v4 \xB7 Modern PM tool aesthetic
   Neutrals + single indigo/violet accent \xB7 Linear/Height feel
   \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
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
.team-view .owner-only{display:none !important;}
::selection{background:var(--accent); color:#fff;}

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   PROFILE LANDING (the only thing the public sees)
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
#profile-view{
  min-height:100vh; display:flex; align-items:center; justify-content:center;
  background:
    radial-gradient(circle at 20% 15%, var(--accent-soft), transparent 40%),
    radial-gradient(circle at 80% 85%, var(--surface-2), transparent 45%),
    var(--bg);
  padding:24px;
}
.profile-card{
  text-align:center; max-width:360px;
  padding:40px 32px; background:var(--surface);
  border:1px solid var(--border); border-radius:var(--radius-lg);
  box-shadow:var(--shadow-lg);
}
.profile-photo{
  width:132px; height:132px; border-radius:50%;
  object-fit:cover; object-position:center 22%;
  border:3px solid var(--surface); box-shadow:0 0 0 1px var(--border), var(--shadow-md);
  margin-bottom:20px;
}
.profile-name{
  font-size:20px; font-weight:700; letter-spacing:-0.01em;
  margin:0 0 10px; color:var(--ink);
}
.profile-line{
  font-size:13.5px; line-height:1.55; color:var(--ink-2);
  margin:0 0 8px;
}
.profile-line.profile-muted{color:var(--ink-3); margin-bottom:0;}
::-webkit-scrollbar{width:8px; height:8px;}
::-webkit-scrollbar-thumb{background:var(--border-strong); border-radius:4px;}
::-webkit-scrollbar-thumb:hover{background:var(--ink-4);}

/* \u2500\u2500 Top navigation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
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

/* \u2500\u2500 Page shell \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
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

/* \u2500\u2500 Section headers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   KANBAN \u2014 public read-only
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   ACTIVITY \u2014 work session log (below tasks)
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
.activity-table{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow:hidden;
  box-shadow: var(--shadow-sm);
}
.activity-head, .activity-row{
  display:grid;
  grid-template-columns: 140px 140px 84px 1fr;
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   NOTEPAD
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   NOTEBOOK (multi-doc)
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
.notebook-shell{
  display:grid; grid-template-columns: 220px 1fr; gap:16px;
}
@media (max-width: 760px){
  .notebook-shell{grid-template-columns: 1fr;}
}
.notebook-list{
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
  padding:8px; box-shadow:var(--shadow-sm);
  max-height: 420px; overflow-y:auto;
}
.notebook-doc-item{
  display:flex; align-items:center; justify-content:space-between; gap:6px;
  padding:8px 10px; border-radius:6px; cursor:pointer;
  font-size:13px; color:var(--ink-2); transition: background .1s ease;
}
.notebook-doc-item:hover{background:var(--surface-2);}
.notebook-doc-item.active{background:var(--accent-soft); color:var(--accent-ink); font-weight:600;}
.notebook-doc-item .doc-title{
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;
}
.notebook-doc-item .del-btn{
  opacity:0; background:none; border:none; color:var(--ink-4); font-size:12px;
  padding:2px 4px; cursor:pointer; flex-shrink:0;
}
.notebook-doc-item:hover .del-btn{opacity:1;}
.notebook-doc-item .del-btn:hover{color:var(--danger);}
.notebook-empty-list{
  padding:20px 10px; text-align:center; color:var(--ink-4); font-size:12px;
}
.notebook-new-btn{
  width:100%; margin-top:4px; padding:8px 10px; border-radius:6px;
  background:transparent; border:1px dashed var(--border-strong);
  color:var(--ink-3); font-size:12.5px; font-weight:500;
}
.notebook-new-btn:hover{background:var(--surface-2); color:var(--ink);}
.notebook-editor{
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
  overflow:hidden; box-shadow:var(--shadow-sm);
  display:flex; flex-direction:column;
}
.notebook-editor-head{
  display:flex; align-items:center; gap:8px;
  padding:10px 14px; border-bottom:1px solid var(--border);
}
.notebook-editor-head input.doc-title-input{
  flex:1; border:none; background:transparent; outline:none;
  font-size:14px; font-weight:600; padding:4px 6px; color:var(--ink);
}
textarea#notebook-content{
  width:100%; min-height:280px; flex:1;
  border:none; outline:none; resize:vertical;
  padding:16px 20px; font-family:var(--sans);
  font-size:14px; line-height:1.6; color:var(--ink);
  background:transparent; display:block;
}
.notebook-empty-editor{
  padding:60px 20px; text-align:center; color:var(--ink-4); font-size:13px;
}

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   INPUTS / BUTTONS
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   UNLOCK MODAL
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   DASHBOARD (admin)
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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
  flex-shrink:0;
}
.dash-nav .brand .mark{
  width:24px; height:24px; min-width:24px; min-height:24px;
  border-radius:50%; flex-shrink:0;
  object-fit:cover; object-position:center 22%;
  box-shadow: 0 0 0 1px var(--border);
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
.dash-nav .page-links{
  display:flex; align-items:center; gap:4px;
  background: var(--surface-2);
  border:1px solid var(--border);
  border-radius: 999px;
  padding: 3px;
}
.dash-nav .page-links a{
  font-size:12.5px; font-weight:500; color:var(--ink-3);
  text-decoration:none; padding: 5px 12px; border-radius:999px;
  transition: all .12s ease;
}
.dash-nav .page-links a:hover{color:var(--ink);}
.dash-nav .page-links a.active{
  background: var(--surface); color:var(--ink);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border);
}

.dash-shell{max-width:1400px; margin:0 auto; padding: 24px 24px 100px;}
@media (max-width: 760px){
  /* Mobile dashboard: only the time clock + time log stay visible */
  .mobile-hide{display:none !important;}
}
@media (max-width: 640px){
  /* Keep the logo + name pinned at full size; let the rest of the nav
     scroll horizontally instead of squeezing the logo into an oval. */
  .dash-nav{gap:12px; padding:0 16px; overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch;}
  .dash-nav::-webkit-scrollbar{display:none;}
  .dash-nav .brand .sub{display:none;}
}

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

/* Admin kanban (dashboard variant \u2014 has editable controls) */
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
  padding: 10px 0; align-items:center;
  border-bottom: 1px dashed var(--border);
}
.log-row:last-child{border-bottom:none;}
.log-row .dur-chip{
  font-family:var(--mono); font-size:12px; font-weight:600;
  color:var(--accent-ink); background:var(--accent-soft);
  padding: 4px 8px; border-radius:5px; text-align:center;
  font-variant-numeric: tabular-nums;
}
.log-row .when{
  font-family:var(--mono); font-size:10.5px; color:var(--ink-4);
  text-align:right; font-variant-numeric: tabular-nums;
}
.panel-empty{
  padding: 24px 8px; text-align:center;
  color: var(--ink-4); font-size:12.5px;
}

/* \u2500 Toast \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
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
var BODY = `
<!-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 Public landing (profile only) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
<div id="profile-view">
  <div class="profile-card">
    <img class="profile-photo" src="${PROFILE_IMG}" alt="Andrew Ryan Garber" />
    <h1 class="profile-name">Andrew Ryan Garber</h1>
    <p class="profile-line">Attending Elon University, studying Financial Technology</p>
    <p class="profile-line profile-muted">Interested in the applications of artificial intelligence in finance and business</p>
  </div>
</div>
<!-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 Unlock modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
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

<!-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 Admin dashboard \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
<div id="dashboard" class="hidden">

  <nav class="dash-nav">
    <div class="brand">
      <img class="mark" src="${PROFILE_IMG}" alt="Andrew Ryan Garber" />
      Andrew's Work <span class="sub" id="dash-role-label">Admin</span>
    </div>
    <div class="page-links">
      <a href="/" class="active">Tasks</a>
      <a href="/analytics">Analytics</a>
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
    <div class="section owner-only mobile-hide" style="margin-bottom:20px;">
      <div class="section-header">
        <div class="heading"><h2>Log a session</h2></div>
      </div>
      <div class="quick-add" style="grid-template-columns: 140px 140px 100px auto;">
        <input id="activity-start" type="time" title="Start" />
        <input id="activity-end" type="time" title="End" />
        <input id="activity-dur" type="number" placeholder="Min" title="Duration (min) \u2014 leave blank to auto-calc" />
        <button class="btn primary" onclick="addActivity()">Log</button>
      </div>
    </div>

    <div class="section mobile-hide">
      <div class="section-header">
        <div class="heading"><h2>Tasks</h2></div>
      </div>
      <div class="quick-add owner-only">
        <input id="task-input" placeholder="Add a new task\u2026" onkeydown="if(event.key==='Enter') addTask()" />
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
            <span class="meta" id="chart-total">\u2014</span>
          </div>
          <div class="chart" id="chart"></div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <h3>Recent entries</h3>
            <span class="meta" id="log-count">\u2014</span>
          </div>
          <div class="log-list" id="timelog-list"></div>
        </div>
      </div>
    </section>

    <!-- Notepad -->
    <section class="section mobile-hide" style="margin-top:32px;">
      <div class="section-header">
        <div class="heading"><h2>Notepad</h2></div>
      </div>
      <div class="notepad-card">
        <textarea id="notepad" spellcheck="false" placeholder="Drop a note, a link, an idea\u2026"></textarea>
        <div class="notepad-foot">
          <span>Private \xB7 autosaves</span>
          <span class="save-state" id="notepad-status"><span class="dot"></span><span class="label">Saved</span></span>
        </div>
      </div>
    </section>

    <!-- Notebook (multi-doc) -->
    <section class="section mobile-hide" style="margin-top:32px;">
      <div class="section-header">
        <div class="heading"><h2>Notebook</h2></div>
        <span style="font-size:12px;color:var(--ink-3);" id="notebook-save-state">&nbsp;</span>
      </div>
      <div class="notebook-shell">
        <div class="notebook-list" id="notebook-list"></div>
        <div class="notebook-editor" id="notebook-editor"></div>
      </div>
    </section>

  </div>
</div>

<div id="toast"></div>
`;
var JS = `
let TOKEN = localStorage.getItem('adminToken') || null;
let ROLE = localStorage.getItem('adminRole') || null;
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
  if (!res.ok) {
    DATA = { activity:[], tasks:[], notepad:'', role:null, isAdmin:false };
    TOKEN = null; ROLE = null;
    localStorage.removeItem('adminToken'); localStorage.removeItem('adminRole');
    return;
  }
  DATA = await res.json();
  ROLE = DATA.role || null;
  if (!ROLE) {
    TOKEN = null;
    localStorage.removeItem('adminToken'); localStorage.removeItem('adminRole');
  } else {
    localStorage.setItem('adminRole', ROLE);
  }
  if (dashboardOpen) renderDashboard();
}

/* \u2500\u2500 formatters \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
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
  if (mins == null) return '\u2014';
  if (mins < 60) return mins+'m';
  const h = Math.floor(mins/60), m = mins%60;
  return m ? h+'h '+m+'m' : h+'h';
}
function statusLabel(s){return {todo:'Todo',inprogress:'In progress',completed:'Completed'}[s]||s;}

/* \u2500\u2500 live clock \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
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
          <input name="text" placeholder="Add a comment\u2026" onkeydown="if(event.key==='Enter') submitComment('\${t.id}', this)" />
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
  status.querySelector('.label').textContent = 'Saving\u2026';
  clearTimeout(notepadTimer);
  notepadTimer = setTimeout(async () => {
    await api('/api/notepad', { method:'PUT', body: JSON.stringify({ content: e.target.value }) });
    status.classList.remove('saving');
    status.querySelector('.label').textContent = 'Saved \xB7 '+new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  }, 700);
});

/* \u2500\u2500 reveal gestures \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
let spaceCount = 0, spaceTimer = null;
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  if (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT') return;
  spaceCount++;
  clearTimeout(spaceTimer);
  spaceTimer = setTimeout(() => spaceCount = 0, 1500);
  if (spaceCount >= 2) { spaceCount = 0; triggerReveal(); }
});
/* Mobile reveal: tap the screen 3 times within 2 seconds. A tap that drags
   more than a few pixels (e.g. a scroll) does not count. */
let tapTimes = [];
let tapStart = null;
let tapMoved = false;
document.addEventListener('touchstart', (e) => {
  tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  tapMoved = false;
});
document.addEventListener('touchmove', (e) => {
  if (!tapStart) return;
  const dx = e.touches[0].clientX - tapStart.x;
  const dy = e.touches[0].clientY - tapStart.y;
  if (Math.sqrt(dx*dx + dy*dy) > 12) tapMoved = true;
});
document.addEventListener('touchend', () => {
  if (tapMoved) { tapTimes = []; return; }
  const now = Date.now();
  tapTimes.push(now);
  tapTimes = tapTimes.filter(t => now - t <= 2000);
  if (tapTimes.length >= 3) { tapTimes = []; triggerReveal(); }
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
  const { token, role } = await res.json();
  TOKEN = token; ROLE = role;
  localStorage.setItem('adminToken', token);
  localStorage.setItem('adminRole', role);
  closeUnlock();
  await load();
  openDashboard();
}
function logout(){
  TOKEN = null; ROLE = null;
  localStorage.removeItem('adminToken'); localStorage.removeItem('adminRole');
  closeDashboard(); load(); toast('Logged out');
}

function openDashboard(){
  dashboardOpen = true;
  const dash = document.getElementById('dashboard');
  dash.classList.remove('hidden');
  dash.classList.toggle('team-view', ROLE !== 'owner');
  const label = document.getElementById('dash-role-label');
  if (label) label.textContent = ROLE === 'owner' ? 'Admin' : 'Team (view only)';
  renderDashboard();
}
function closeDashboard(){ dashboardOpen = false; document.getElementById('dashboard').classList.add('hidden'); }

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   DASHBOARD (admin)
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
function renderDashboard(){
  if (!ROLE) return;
  renderClock();
  renderKanban('admin-board', ROLE === 'owner');
  renderTimelog();
  document.getElementById('notepad').value = DATA.notepad || '';
  renderNotebook();
}

function renderClock(){
  const el = document.getElementById('clock-widget');
  const isOwner = ROLE === 'owner';
  if (DATA.activeTimer){
    el.innerHTML = \`
      <div>
        <div class="label"><span class="live-dot"></span>Timer running \xB7 since \${timeOf(DATA.activeTimer.start)}</div>
        <div class="display" id="timer-elapsed">00:00:00</div>
      </div>
      \${isOwner ? \`<div class="controls">
        <button class="btn stop" onclick="stopTimer()">Stop &amp; log</button>
      </div>\` : ''}\`;
  } else if (isOwner) {
    el.innerHTML = \`
      <div>
        <div class="label">Time clock \u2014 idle</div>
        <div class="display idle">00:00:00</div>
      </div>
      <div class="controls">
        <button class="btn primary" onclick="startTimer()">Start</button>
      </div>\`;
  } else {
    el.innerHTML = \`
      <div>
        <div class="label">Time clock \u2014 idle</div>
        <div class="display idle">00:00:00</div>
      </div>\`;
  }
}

async function startTimer(){
  const res = await api('/api/timer/start', { method:'POST' });
  if (!res.ok) { toast('Could not start timer'); return; }
  await load();
}
async function stopTimer(){
  await api('/api/timer/stop', { method:'POST' });
  await load();
  toast('Time entry logged');
}

/* Admin task card (with actions) */
function adminCard(t){
  const nextStatus = { todo:'inprogress', inprogress:'completed', completed:'todo' };
  const nextLabel  = { todo:'Start \u2192', inprogress:'Complete \u2713', completed:'Reopen \u21BA' };
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
        \${prevStatus[t.status] ? \`<button class="btn subtle xs" title="Move back" onclick="moveTask('\${t.id}','\${prevStatus[t.status]}')">\u2190</button>\` : ''}
        <button class="btn ghost sm" onclick="moveTask('\${t.id}','\${nextStatus[t.status]}')">\${nextLabel[t.status]}</button>
      </div>
      <button class="btn subtle xs" onclick="delTask('\${t.id}')" title="Delete">\u2715</button>
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
  const startVal = document.getElementById('activity-start').value; // "HH:MM"
  const endVal   = document.getElementById('activity-end').value;
  const durVal   = document.getElementById('activity-dur').value;

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
    // no times entered \u2014 default to "just now, 0 min"
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

  await api('/api/activity', { method:'POST', body: JSON.stringify({ startedAt, endedAt, duration }) });
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
  const isOwner = ROLE === 'owner';
  list.innerHTML = logs.length ? logs.slice(0,30).map(l => {
    return \`<div class="log-row">
      <div class="dur-chip">\${(l.minutes/60).toFixed(1)}h</div>
      <div class="when">\${shortDate(l.start)}</div>
      \${isOwner ? \`<button class="btn subtle xs" title="Delete entry" onclick="delTimeLog('\${l.id}')">\u2715</button>\` : ''}
    </div>\`;
  }).join('') : '<div class="panel-empty">No time logged yet.</div>';
}

async function delTimeLog(id){
  const res = await api('/api/timelogs/'+id, { method:'DELETE' });
  if (!res.ok) { toast('Could not delete entry'); return; }
  await load();
  toast('Entry deleted');
}

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   NOTEBOOK (multi-doc)
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
let currentNotebookDocId = null;
let notebookSaveTimer = null;

function renderNotebook(){
  const docs = DATA.notebookDocs || [];
  const listEl = document.getElementById('notebook-list');
  const editorEl = document.getElementById('notebook-editor');
  if (!listEl || !editorEl) return;

  if (!currentNotebookDocId || !docs.find(d => d.id === currentNotebookDocId)) {
    currentNotebookDocId = docs.length ? docs[0].id : null;
  }

  listEl.innerHTML = (docs.length ? docs.map(d => {
    const active = d.id === currentNotebookDocId ? 'active' : '';
    return '<div class="notebook-doc-item ' + active + '" onclick="selectNotebookDoc(\\'' + d.id + '\\')">' +
      '<span class="doc-title">' + escapeHtml(d.title || 'Untitled') + '</span>' +
      '<button class="del-btn owner-only" title="Delete" onclick="event.stopPropagation(); deleteNotebookDoc(\\'' + d.id + '\\')">\\u2715</button>' +
      '</div>';
  }).join('') : '<div class="notebook-empty-list">No docs yet</div>') +
    '<button class="notebook-new-btn" onclick="newNotebookDoc()">+ New doc</button>';

  const doc = docs.find(d => d.id === currentNotebookDocId);
  if (!doc) {
    editorEl.innerHTML = '<div class="notebook-empty-editor">Create a doc to start writing.</div>';
    return;
  }
  editorEl.innerHTML =
    '<div class="notebook-editor-head">' +
      '<input class="doc-title-input" id="notebook-title-input" value="' + escapeHtml(doc.title || '') + '" placeholder="Untitled" />' +
    '</div>' +
    '<textarea id="notebook-content" spellcheck="false" placeholder="Start writing\\u2026">' + escapeHtml(doc.content || '') + '</textarea>';

  document.getElementById('notebook-title-input').addEventListener('input', scheduleNotebookSave);
  document.getElementById('notebook-content').addEventListener('input', scheduleNotebookSave);
}

function selectNotebookDoc(id){
  currentNotebookDocId = id;
  renderNotebook();
}

async function newNotebookDoc(){
  const res = await api('/api/notebook', { method:'POST', body: JSON.stringify({ title: 'Untitled' }) });
  if (!res.ok) { toast('Could not create doc'); return; }
  const { id } = await res.json();
  await load();
  currentNotebookDocId = id;
  renderNotebook();
  toast('Doc created');
}

async function deleteNotebookDoc(id){
  if (!confirm('Delete this doc?')) return;
  const res = await api('/api/notebook/'+id, { method:'DELETE' });
  if (!res.ok) { toast('Could not delete doc'); return; }
  if (currentNotebookDocId === id) currentNotebookDocId = null;
  await load();
  toast('Doc deleted');
}

function scheduleNotebookSave(){
  const stateEl = document.getElementById('notebook-save-state');
  if (stateEl) stateEl.textContent = 'Saving\\u2026';
  clearTimeout(notebookSaveTimer);
  notebookSaveTimer = setTimeout(async () => {
    const titleEl = document.getElementById('notebook-title-input');
    const contentEl = document.getElementById('notebook-content');
    if (!titleEl || !contentEl || !currentNotebookDocId) return;
    await api('/api/notebook/'+currentNotebookDocId, {
      method:'PUT',
      body: JSON.stringify({ title: titleEl.value, content: contentEl.value })
    });
    if (stateEl) stateEl.textContent = 'Saved \\u00b7 ' + new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
    // keep local DATA in sync without a full reload/re-render (avoids losing focus)
    const doc = (DATA.notebookDocs || []).find(d => d.id === currentNotebookDocId);
    if (doc) { doc.title = titleEl.value; doc.content = contentEl.value; }
    const item = document.querySelector('.notebook-doc-item.active .doc-title');
    if (item) item.textContent = titleEl.value || 'Untitled';
  }, 700);
}

load();
`;
var _a;
var HTML = String.raw(_a || (_a = __template([`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<title>Andrew's Work</title>
<link rel="icon" type="image/png" href="${FAVICON_IMG}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>`, "</style>\n</head>\n<body>\n", "\n<script>", "<\/script>\n</body>\n</html>"])), CSS, BODY, JS);

// ============================================================
// ANALYTICS (Write with Us / Tool Performance) — GA4-backed
// Gated by the same admin/team token system as the rest of the site.
// ============================================================

const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_CACHE_KEY = 'ga4_access_token';
const TOKEN_CACHE_TTL_SECONDS = 3000;
const BEFORE_PERIOD_DAYS = 30;

const TOOL_EVENTS = [
  'panel_opened',
  'message_generated',
  'regenerate_clicked',
  'message_selected',
  'message_saved_to_cart',
];

function todayStr() {
  return new Date().toISOString().split('T')[0];
}
function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().split('T')[0];
}
function daysBetweenInclusive(startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  return Math.round((end - start) / 86400000) + 1;
}
function getLaunchDate(env) {
  return env.TOOL_LAUNCH_DATE || todayStr();
}

function base64url(input) {
  let base64;
  if (typeof input === 'string') {
    base64 = btoa(input);
  } else {
    base64 = btoa(String.fromCharCode(...new Uint8Array(input)));
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importPrivateKey(pem) {
  const pemContents = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function createSignedJWT(serviceAccount) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: GA4_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
  const key = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64url(signature)}`;
}

async function getAccessToken(env) {
  const cached = await env.TOKEN_CACHE.get(TOKEN_CACHE_KEY);
  if (cached) return cached;

  const serviceAccount = JSON.parse(env.GA4_SERVICE_ACCOUNT_KEY);
  const jwt = await createSignedJWT(serviceAccount);

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  await env.TOKEN_CACHE.put(TOKEN_CACHE_KEY, data.access_token, {
    expirationTtl: TOKEN_CACHE_TTL_SECONDS,
  });
  return data.access_token;
}

async function callGA4(env, method, body) {
  const accessToken = await getAccessToken(env);
  const propertyId = env.GA4_PROPERTY_ID;

  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:${method}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    throw new Error(`GA4 ${method} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function getRealtimeReport(env) {
  return callGA4(env, 'runRealtimeReport', {
    dimensions: [{ name: 'unifiedScreenName' }],
    metrics: [{ name: 'activeUsers' }],
  });
}

function getHistoricalReport(env, days) {
  return callGA4(env, 'runReport', {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'conversions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
  });
}

function parseGA4Breakdown(settledResult) {
  if (settledResult.status !== 'fulfilled' || !settledResult.value.rows) return null;
  return settledResult.value.rows.map((row) => ({
    label: row.dimensionValues[0].value,
    count: Number(row.metricValues[0].value),
  }));
}

async function getToolMetrics(env, days) {
  const eventCountsQuery = callGA4(env, 'runReport', {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName', inListFilter: { values: TOOL_EVENTS } },
    },
  });

  const eventUsersQuery = callGA4(env, 'runReport', {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'totalUsers' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName', inListFilter: { values: TOOL_EVENTS } },
    },
  });

  const productViewsQuery = callGA4(env, 'runReport', {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    metrics: [{ name: 'screenPageViews' }],
    dimensionFilter: {
      filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/products/' } },
    },
  });

  const breakdownQuery = (customDimension) =>
    callGA4(env, 'runReport', {
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: `customEvent:${customDimension}` }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'message_generated' } },
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 10,
    });

  const [eventCountsRes, eventUsersRes, productViewsRes, occasionRes, toneRes, cardRes] = await Promise.allSettled([
    eventCountsQuery,
    eventUsersQuery,
    productViewsQuery,
    breakdownQuery('occasion'),
    breakdownQuery('tone'),
    breakdownQuery('card_title'),
  ]);

  const eventCounts = {};
  TOOL_EVENTS.forEach((n) => (eventCounts[n] = 0));
  if (eventCountsRes.status === 'fulfilled') {
    for (const row of eventCountsRes.value.rows || []) {
      eventCounts[row.dimensionValues[0].value] = Number(row.metricValues[0].value);
    }
  }

  const eventUsers = {};
  TOOL_EVENTS.forEach((n) => (eventUsers[n] = 0));
  if (eventUsersRes.status === 'fulfilled') {
    for (const row of eventUsersRes.value.rows || []) {
      eventUsers[row.dimensionValues[0].value] = Number(row.metricValues[0].value);
    }
  }

  const productPageViews =
    productViewsRes.status === 'fulfilled' && productViewsRes.value.rows
      ? Number(productViewsRes.value.rows[0]?.metricValues[0]?.value || 0)
      : 0;

  const panelOpened = eventCounts.panel_opened;
  const messageGenerated = eventCounts.message_generated;
  const regenerateClicked = eventCounts.regenerate_clicked;

  return {
    days,
    eventCounts,
    eventUsers,
    productPageViews,
    rates: {
      adoptionRate: productPageViews > 0 ? (panelOpened / productPageViews) * 100 : null,
      regenerationRate: messageGenerated > 0 ? (regenerateClicked / messageGenerated) * 100 : null,
    },
    funnel: [
      { label: 'Opened the panel', count: eventUsers.panel_opened },
      { label: 'Generated a message', count: eventUsers.message_generated },
      { label: 'Selected a message', count: eventUsers.message_selected },
      { label: 'Saved to cart', count: eventUsers.message_saved_to_cart },
    ],
    occasionBreakdown: parseGA4Breakdown(occasionRes),
    toneBreakdown: parseGA4Breakdown(toneRes),
    cardBreakdown: parseGA4Breakdown(cardRes),
  };
}

function getPeriodTotals(env, startDate, endDate) {
  return callGA4(env, 'runReport', {
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'ecommercePurchases' },
      { name: 'totalRevenue' },
      { name: 'newUsers' },
      { name: 'engagementRate' },
    ],
  });
}

function parseTotals(settledResult) {
  if (settledResult.status !== 'fulfilled' || !settledResult.value.rows || !settledResult.value.rows.length) {
    return { sessions: 0, activeUsers: 0, purchases: 0, revenue: 0, newUsers: 0, engagementRate: null };
  }
  const row = settledResult.value.rows[0];
  return {
    sessions: Number(row.metricValues[0].value),
    activeUsers: Number(row.metricValues[1].value),
    purchases: Number(row.metricValues[2].value),
    revenue: Number(row.metricValues[3].value),
    newUsers: Number(row.metricValues[4].value),
    engagementRate: Number(row.metricValues[5].value) * 100,
  };
}

function perDayStats(totals, days) {
  return {
    sessions: totals.sessions / days,
    activeUsers: totals.activeUsers / days,
    purchases: totals.purchases / days,
    revenue: totals.revenue / days,
    newUsers: totals.newUsers / days,
    conversionRate: totals.sessions > 0 ? (totals.purchases / totals.sessions) * 100 : null,
    aov: totals.purchases > 0 ? totals.revenue / totals.purchases : null,
    engagementRate: totals.engagementRate,
  };
}

function pctChange(before, after) {
  if (before === null || before === undefined || before === 0) return null;
  if (after === null || after === undefined) return null;
  return ((after - before) / before) * 100;
}

async function getComparison(env) {
  const launchDate = getLaunchDate(env);
  const beforeStart = addDays(launchDate, -BEFORE_PERIOD_DAYS);
  const beforeEnd = addDays(launchDate, -1);
  const afterStart = launchDate;
  const afterEnd = todayStr();

  const [beforeRes, afterRes] = await Promise.allSettled([
    getPeriodTotals(env, beforeStart, beforeEnd),
    getPeriodTotals(env, afterStart, afterEnd),
  ]);

  const beforeTotals = parseTotals(beforeRes);
  const afterTotals = parseTotals(afterRes);

  const beforeDays = daysBetweenInclusive(beforeStart, beforeEnd);
  const afterDays = Math.max(1, daysBetweenInclusive(afterStart, afterEnd));

  const beforePerDay = perDayStats(beforeTotals, beforeDays);
  const afterPerDay = perDayStats(afterTotals, afterDays);

  return {
    launchDate,
    before: { start: beforeStart, end: beforeEnd, days: beforeDays, totals: beforeTotals, perDay: beforePerDay },
    after: { start: afterStart, end: afterEnd, days: afterDays, totals: afterTotals, perDay: afterPerDay },
    change: {
      sessionsPerDay: pctChange(beforePerDay.sessions, afterPerDay.sessions),
      activeUsersPerDay: pctChange(beforePerDay.activeUsers, afterPerDay.activeUsers),
      purchasesPerDay: pctChange(beforePerDay.purchases, afterPerDay.purchases),
      revenuePerDay: pctChange(beforePerDay.revenue, afterPerDay.revenue),
      newUsersPerDay: pctChange(beforePerDay.newUsers, afterPerDay.newUsers),
      conversionRate: pctChange(beforePerDay.conversionRate, afterPerDay.conversionRate),
      aov: pctChange(beforePerDay.aov, afterPerDay.aov),
      engagementRate: pctChange(beforePerDay.engagementRate, afterPerDay.engagementRate),
    },
  };
}

function getTodayHourlyReport(env) {
  return callGA4(env, 'runReport', {
    dateRanges: [{ startDate: 'today', endDate: 'today' }],
    dimensions: [{ name: 'hour' }],
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'ecommercePurchases' }],
  });
}

function getBaselineHourlyReport(env, startDate, endDate) {
  return callGA4(env, 'runReport', {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'date' }, { name: 'hour' }],
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'ecommercePurchases' }],
  });
}

async function getTodayPace(env) {
  const launchDate = getLaunchDate(env);
  const beforeStart = addDays(launchDate, -BEFORE_PERIOD_DAYS);
  const beforeEnd = addDays(launchDate, -1);

  const [todayRes, baselineRes] = await Promise.allSettled([
    getTodayHourlyReport(env),
    getBaselineHourlyReport(env, beforeStart, beforeEnd),
  ]);

  let currentHour = 0;
  const todayTotals = { sessions: 0, activeUsers: 0, purchases: 0 };
  if (todayRes.status === 'fulfilled' && todayRes.value.rows) {
    for (const row of todayRes.value.rows) {
      const h = Number(row.dimensionValues[0].value);
      if (h > currentHour) currentHour = h;
      todayTotals.sessions += Number(row.metricValues[0].value);
      todayTotals.activeUsers += Number(row.metricValues[1].value);
      todayTotals.purchases += Number(row.metricValues[2].value);
    }
  }

  const numBaselineDays = daysBetweenInclusive(beforeStart, beforeEnd);
  const perDateTotals = {};
  for (let i = 0; i < numBaselineDays; i++) {
    perDateTotals[addDays(beforeStart, i)] = { sessions: 0, activeUsers: 0, purchases: 0 };
  }

  if (baselineRes.status === 'fulfilled' && baselineRes.value.rows) {
    for (const row of baselineRes.value.rows) {
      const dateRaw = row.dimensionValues[0].value;
      const hour = Number(row.dimensionValues[1].value);
      if (hour > currentHour) continue;
      const ds = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
      if (!perDateTotals[ds]) continue;
      perDateTotals[ds].sessions += Number(row.metricValues[0].value);
      perDateTotals[ds].activeUsers += Number(row.metricValues[1].value);
      perDateTotals[ds].purchases += Number(row.metricValues[2].value);
    }
  }

  const dates = Object.keys(perDateTotals);
  const n = dates.length || 1;
  const typical = { sessions: 0, activeUsers: 0, purchases: 0 };
  dates.forEach((ds) => {
    typical.sessions += perDateTotals[ds].sessions;
    typical.activeUsers += perDateTotals[ds].activeUsers;
    typical.purchases += perDateTotals[ds].purchases;
  });
  typical.sessions /= n;
  typical.activeUsers /= n;
  typical.purchases /= n;

  return {
    asOfHour: currentHour,
    baselineDays: dates.length,
    today: todayTotals,
    typicalByThisHour: typical,
    change: {
      sessions: pctChange(typical.sessions, todayTotals.sessions),
      activeUsers: pctChange(typical.activeUsers, todayTotals.activeUsers),
      purchases: pctChange(typical.purchases, todayTotals.purchases),
    },
  };
}

function getFullTrendReport(env, startDate, endDate) {
  return callGA4(env, 'runReport', {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'ecommercePurchases' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
  });
}

async function getFullTrend(env, windowDays) {
  const launchDate = getLaunchDate(env);
  const start = addDays(launchDate, -windowDays);
  const end = todayStr();
  const report = await getFullTrendReport(env, start, end);
  return { launchDate, start, end, windowDays, report };
}

async function getSiteInsights(env, days) {
  const devicesQuery = callGA4(env, 'runReport', {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'deviceCategory' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  });

  const channelsQuery = callGA4(env, 'runReport', {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 6,
  });

  const [devicesRes, channelsRes] = await Promise.allSettled([devicesQuery, channelsQuery]);

  return {
    days,
    devices: parseGA4Breakdown(devicesRes),
    channels: parseGA4Breakdown(channelsRes),
  };
}

const BRAND_CONTEXT = [
  'Quilling Card — brand snapshot for context:',
  'Tagline: "Don\'t Just Send a Card. Send Art."',
  'Premium handcrafted greeting cards made with centuries-old paper quilling art, by a workshop of ~1,000 skilled artisans (Guinness World Record recognition).',
  'Target customer: women 25-65 who value artistry, craftsmanship, emotional gifting, and premium keepsakes. Secondary: museum shoppers, collectors, stationery lovers.',
  'Brand values: Heritage, Preservation, Artistry, Human Touch, Craftsmanship, Timeless Giving, Fair Trade.',
  'Positioning: not a disposable card — a collectible, frameable, keepsake work of art with a story.',
  'Sells via own Shopify site plus Faire/Etsy/Amazon; the "Write with Us" AI tool referenced below helps shoppers write personalized card messages.',
].join(' ');

function buildInsightsPrompt(data) {
  const lines = [
    'You are a senior e-commerce and market-research analyst producing a briefing for a small handcrafted-goods company\'s leadership.',
    BRAND_CONTEXT,
    '',
    'Below is this store\'s own current analytics data (from Google Analytics 4, via our own dashboard — trust these numbers as ground truth, do not need to verify them):',
    JSON.stringify(data, null, 2),
    '',
    'Using real web search (do not rely only on prior knowledge), research 2-4 real named competitors/comparables in premium handcrafted greeting cards or artisan keepsake gifting, and current 2026 trends in gifting/e-commerce/handcrafted goods relevant to this business. Cross-reference that research against the store\'s own data above.',
    '',
    'Respond in EXACTLY this format — plain text with these exact bracketed markers, nothing before the first marker. Each section is 1-2 short, specific, plain-English sentences (not generic filler) EXCEPT FULL_BRIEFING, which is a longer structured writeup:',
    '',
    '[[SECTION:TRAFFIC_TREND]]',
    '1-2 sentences on what the 30/60/90-day traffic trend chart shows and whether it is meaningfully up, down, or flat, referencing the launch marker.',
    '',
    '[[SECTION:LAUNCH_COMPARISON]]',
    '1-2 sentences interpreting the before-vs-after-launch numbers — is this a real signal yet given the sample size, and what stands out.',
    '',
    '[[SECTION:TODAY_PACE]]',
    '1-2 sentences on whether today is pacing ahead or behind typical, and whether that matters.',
    '',
    '[[SECTION:TOOL_FUNNEL]]',
    '1-2 sentences on where the biggest drop-off in the Write with Us funnel is and what it likely means.',
    '',
    '[[SECTION:DEVICES_CHANNELS]]',
    '1-2 sentences on what the device split and traffic channel mix suggest about where to focus.',
    '',
    '[[SECTION:FULL_BRIEFING]]',
    '## Competitive Landscape',
    '(2-4 named competitors, what they do well, pricing/positioning/channels, cited)',
    '## Market Trends',
    '(bullet points, cited)',
    '## Recommendations',
    '(4-6 specific, prioritized, actionable bullet points, each tied to either the store\'s own data or something concrete from your research — not generic advice)',
    '',
    'Be direct and specific throughout — this is read by the business owner, not a marketing agency. Cite sources for competitor or market claims.',
  ];
  return lines.join('\n');
}

function parseSections(text) {
  const sections = {};
  const parts = text.split(/\[\[SECTION:([A-Z_]+)\]\]/);
  for (let i = 1; i < parts.length; i += 2) {
    sections[parts[i]] = (parts[i + 1] || '').trim();
  }
  return sections;
}

async function getAIInsights(env) {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const [comparisonRes, toolMetricsRes, siteInsightsRes] = await Promise.allSettled([
    getComparison(env),
    getToolMetrics(env, 7),
    getSiteInsights(env, 7),
  ]);

  const dataForPrompt = {
    launchComparison: comparisonRes.status === 'fulfilled' ? comparisonRes.value : null,
    toolFunnelLast7Days: toolMetricsRes.status === 'fulfilled' ? toolMetricsRes.value : null,
    devicesAndChannelsLast7Days: siteInsightsRes.status === 'fulfilled' ? siteInsightsRes.value : null,
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1',
      tools: [{ type: 'web_search' }],
      input: buildInsightsPrompt(dataForPrompt),
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();

  let text = '';
  for (const item of result.output || []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text' && c.text) text += c.text;
      }
    }
  }

  const sources = [];
  const seen = new Set();
  for (const item of result.output || []) {
    for (const content of item.content || []) {
      for (const ann of content.annotations || []) {
        if (ann.type === 'url_citation' && ann.url && !seen.has(ann.url)) {
          seen.add(ann.url);
          sources.push({ title: ann.title || ann.url, url: ann.url });
        }
      }
    }
  }

  const sections = parseSections(text);
  const generatedAt = new Date().toISOString();

  // Log this scan to the persistent AI scan log (SITE_DATA KV).
  try {
    const data = await getData(env);
    data.aiScanLog = data.aiScanLog || [];
    data.aiScanLog.unshift({
      id: uid(),
      ts: generatedAt,
      sourceCount: sources.length,
      preview: (sections.FULL_BRIEFING || text || "").replace(/\s+/g, " ").trim().slice(0, 200)
    });
    data.aiScanLog = data.aiScanLog.slice(0, 200);
    await saveData(env, data);
  } catch (logErr) {
    // Never let logging failures break the actual insights response.
    console.error("Failed to save AI scan log:", logErr);
  }

  return { sections, rawText: text, sources, generatedAt };
}

// ---------- Analytics API router ----------
// Auth here is handled entirely by Cloudflare Access sitting in front of this
// route (see /analytics and /api/analytics/* in your Access application config).
// This header check is defense-in-depth: it confirms the request actually came
// through Access rather than hitting the Worker directly (e.g. via the
// workers.dev subdomain, which Access does not protect).
async function handleAnalyticsApi(request, env, pathname) {
  const accessEmail = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (!accessEmail) {
    return json({
      error: 'Access required. This page must be reached through the protected domain (not the workers.dev URL).',
    }, 403);
  }

  if (pathname === '/api/analytics/whoami') {
    return json({ email: accessEmail });
  }

  try {
    if (pathname === '/api/analytics/realtime') {
      return json(await getRealtimeReport(env));
    }
    if (pathname === '/api/analytics/historical') {
      const url = new URL(request.url);
      const days = Number(url.searchParams.get('days') || 7);
      return json(await getHistoricalReport(env, days));
    }
    if (pathname === '/api/analytics/tool-metrics') {
      const url = new URL(request.url);
      const days = Number(url.searchParams.get('days') || 7);
      return json(await getToolMetrics(env, days));
    }
    if (pathname === '/api/analytics/comparison') {
      return json(await getComparison(env));
    }
    if (pathname === '/api/analytics/today-pace') {
      return json(await getTodayPace(env));
    }
    if (pathname === '/api/analytics/full-trend') {
      const url = new URL(request.url);
      const windowDays = Number(url.searchParams.get('days') || BEFORE_PERIOD_DAYS);
      return json(await getFullTrend(env, windowDays));
    }
    if (pathname === '/api/analytics/site-insights') {
      const url = new URL(request.url);
      const days = Number(url.searchParams.get('days') || 7);
      return json(await getSiteInsights(env, days));
    }
    if (pathname === '/api/analytics/ai-insights') {
      return json(await getAIInsights(env));
    }
    if (pathname === '/api/analytics/ai-scan-log') {
      const data = await getData(env);
      return json({ log: data.aiScanLog || [] });
    }
    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ============================================================
// ANALYTICS PAGE — same design tokens as the Tasks page (andrewswork palette)
// ============================================================

const ANALYTICS_CSS = `
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
  --amber:#d97706;
  --amber-soft:#fef3c7;
  --green:#16a34a;
  --green-soft:#dcfce7;
  --danger:#dc2626;
  --danger-soft:#fee2e2;
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
  -webkit-font-smoothing:antialiased;
}
.hidden{display:none !important;}
.num{font-variant-numeric:tabular-nums; font-family:var(--mono);}
::selection{background:var(--accent); color:#fff;}
::-webkit-scrollbar{width:8px; height:8px;}
::-webkit-scrollbar-thumb{background:var(--border-strong); border-radius:4px;}

/* Top nav (mirrors dash-nav) */
.dash-nav{
  position:sticky; top:0; z-index:20;
  height:52px;
  display:flex; align-items:center; gap:20px;
  padding: 0 24px;
  background: rgba(255,255,255,0.85);
  backdrop-filter: saturate(180%) blur(12px);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  border-bottom:1px solid var(--border);
}
.dash-nav .brand{display:flex; align-items:center; gap:10px; font-weight:600; font-size:14px; flex-shrink:0;}
.dash-nav .brand .mark{
  width:24px; height:24px; min-width:24px; min-height:24px;
  border-radius:50%; flex-shrink:0;
  object-fit:cover; object-position:center 22%;
  box-shadow: 0 0 0 1px var(--border);
}
.dash-nav .brand .sub{
  color:var(--ink-3); font-weight:400;
  padding: 2px 8px; background:var(--surface-2); border-radius:5px;
  font-size:11.5px; font-family:var(--mono);
  border:1px solid var(--border);
  margin-left: 4px;
}
.dash-nav .page-links{
  display:flex; align-items:center; gap:4px;
  background: var(--surface-2); border:1px solid var(--border);
  border-radius: 999px; padding: 3px;
}
.dash-nav .page-links a{
  font-size:12.5px; font-weight:500; color:var(--ink-3);
  text-decoration:none; padding: 5px 12px; border-radius:999px;
  transition: all .12s ease;
}
.dash-nav .page-links a:hover{color:var(--ink);}
.dash-nav .page-links a.active{
  background: var(--surface); color:var(--ink);
  box-shadow: var(--shadow-sm); border:1px solid var(--border);
}
.dash-nav .spacer{flex:1;}
.dash-nav .clock{
  font-family:var(--mono); font-size:12px; color:var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.dash-nav .live-chip{
  display:inline-flex; align-items:center; gap:6px;
  font-size:11px; font-weight:600; color:var(--green);
  background:var(--green-soft); padding:4px 10px; border-radius:999px;
}
.dash-nav .live-dot{
  width:6px; height:6px; border-radius:50%; background:var(--green);
  box-shadow: 0 0 0 3px rgba(22,163,74,0.2);
  animation: pulse 2.4s infinite;
}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.5;}}
@media (max-width: 640px){
  /* Keep the logo + name pinned at full size; let the rest of the nav
     scroll horizontally instead of squeezing the logo into an oval. */
  .dash-nav{gap:12px; padding:0 16px; overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch;}
  .dash-nav::-webkit-scrollbar{display:none;}
  .dash-nav .brand .sub{display:none;}
}

input[type=text], input[type=password], input:not([type]){
  font-family:var(--sans); font-size:13px;
  background:var(--surface); color:var(--ink);
  border:1px solid var(--border-strong);
  border-radius:6px; padding: 7px 10px;
  outline:none;
}
input:focus{border-color:var(--accent); box-shadow:0 0 0 3px rgba(91,91,214,0.18);}
button{font-family:var(--sans); cursor:pointer; border:none;}
.btn{
  display:inline-flex; align-items:center; gap:6px;
  padding: 7px 12px; border-radius:6px;
  font-size:13px; font-weight:500;
  background: var(--ink); color:#fff;
  box-shadow: var(--shadow-sm);
}
.btn:hover{background:#000;}
.btn.primary{background:var(--accent);}
.btn.primary:hover{background:var(--accent-hover);}
.btn.primary:disabled{opacity:0.55; cursor:default;}
.btn.ghost{background:var(--surface); color:var(--ink); border:1px solid var(--border-strong);}
.btn.ghost:hover{background:var(--surface-2);}
.btn.danger{background:transparent; color:var(--danger); border:1px solid var(--border-strong);}
.btn.danger:hover{background:var(--danger); color:#fff; border-color:var(--danger);}
.btn.sm{padding:5px 9px; font-size:12px;}
.btn svg{width:13px; height:13px; stroke:currentColor; fill:none; stroke-width:2;}

/* Unlock overlay (matches Tasks page) */
.unlock-overlay{
  position:fixed; inset:0; z-index:60;
  background: rgba(10,10,15,0.45);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  display:flex; align-items:center; justify-content:center;
}
.unlock-box{
  background:var(--surface); border-radius:var(--radius-lg);
  padding:24px; width:360px; box-shadow:var(--shadow-lg);
  border:1px solid var(--border);
}
.unlock-box .icon{
  width:36px; height:36px; border-radius:8px;
  background:var(--accent-soft); color:var(--accent);
  display:flex; align-items:center; justify-content:center; margin-bottom:14px;
}
.unlock-box h3{font-size:17px; font-weight:600; letter-spacing:-0.01em; margin:0 0 4px;}
.unlock-box p{font-size:13px; color:var(--ink-3); margin:0 0 16px; line-height:1.5;}
.unlock-box input{width:100%; margin-bottom:12px; padding:9px 12px; font-size:14px;}
.unlock-box .actions{display:flex; gap:8px; justify-content:flex-end;}

/* Page shell */
.shell{max-width:1400px; margin:0 auto; padding: 24px 24px 100px;}
.page-head{margin-bottom:24px;}
.page-head h1{font-size:24px; font-weight:600; letter-spacing:-0.02em; margin:0 0 6px;}
.page-head p{font-size:13.5px; color:var(--ink-3); margin:0; max-width:640px; line-height:1.5;}

.sec{margin-bottom:36px;}
.sec-head{
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:14px; gap:16px; flex-wrap:wrap;
}
.sec-head h2{font-size:16px; font-weight:600; letter-spacing:-0.01em; margin:0;}
.chip{
  font-size:11px; font-weight:560; color:var(--ink-3); background:var(--surface-2);
  border:1px solid var(--border); padding:4px 10px; border-radius:999px;
}

.grid{display:grid; grid-template-columns: repeat(12,1fr); gap:16px; align-items:start;}
.s12{grid-column:span 12;} .s8{grid-column:span 12;} .s6{grid-column:span 12;} .s4{grid-column:span 12;}
@media(min-width:760px){.s6{grid-column:span 6;}}
@media(min-width:1100px){.s4{grid-column:span 4;} .s8{grid-column:span 8;}}

.card{
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
  padding:20px 22px; box-shadow:var(--shadow-sm);
}
.card-head{display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:16px; flex-wrap:wrap;}
.card-title{font-size:14.5px; font-weight:600; letter-spacing:-0.01em;}
.card-hint{font-size:12px; color:var(--ink-3); margin-top:4px; line-height:1.45;}

.stat-row{display:grid; grid-template-columns:1fr; gap:16px;}
@media(min-width:700px){.stat-row{grid-template-columns:repeat(2,1fr);}}
@media(min-width:1180px){.stat-row{grid-template-columns:repeat(4,1fr);}}
.stat{
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
  padding:16px 18px; box-shadow:var(--shadow-sm);
}
.stat-top{display:flex; align-items:center; gap:9px;}
.stat-ico{
  width:26px; height:26px; border-radius:7px; flex-shrink:0;
  display:flex; align-items:center; justify-content:center;
}
.stat-ico svg{width:14px; height:14px; stroke:currentColor; fill:none; stroke-width:1.9;}
.stat-ico.i-accent{background:var(--accent-soft); color:var(--accent-ink);}
.stat-ico.i-amber{background:var(--amber-soft); color:#a0611f;}
.stat-ico.i-green{background:var(--green-soft); color:var(--green);}
.stat-label{font-size:12.5px; font-weight:550; color:var(--ink-2);}
.stat-value{font-size:25px; font-weight:650; letter-spacing:-0.02em; margin-top:11px; font-family:var(--mono);}
.stat-caption{font-size:11.5px; color:var(--ink-3); margin-top:6px;}

.delta{display:inline-flex; align-items:center; gap:4px; font-size:11.5px; font-weight:650; font-family:var(--mono);}
.delta.up{color:var(--green);} .delta.down{color:var(--danger);} .delta.flat{color:var(--ink-3);}

.ai-insight-card{
  background: linear-gradient(135deg, var(--accent-soft) 0%, #fdf7ee 55%, var(--amber-soft) 100%);
  border:1px solid var(--border); border-radius:var(--radius-lg); padding:20px 22px; box-shadow:var(--shadow-sm);
}
.ai-badge{
  display:inline-flex; align-items:center; gap:6px; font-size:10.5px; font-weight:700;
  letter-spacing:0.05em; text-transform:uppercase; color:var(--accent-ink);
}
.ai-badge svg{width:12px; height:12px; stroke:currentColor; fill:none; stroke-width:2;}
.ai-insight-title{font-size:16px; font-weight:650; letter-spacing:-0.01em; margin-top:7px;}
.ai-insight-body{font-size:13.5px; line-height:1.6; color:var(--ink-2); margin-top:8px;}
.conf-row{display:flex; align-items:center; justify-content:space-between; margin-top:16px; font-size:12px; color:var(--ink-2); font-weight:560;}
.conf-track{height:7px; border-radius:999px; background:rgba(10,10,15,0.08); overflow:hidden; margin-top:8px;}
.conf-fill{height:100%; border-radius:999px; background:linear-gradient(90deg,var(--amber),var(--accent)); width:0; transition:width .9s ease;}

.skel{
  display:inline-block; border-radius:5px; min-width:44px;
  background: linear-gradient(90deg,#efe9e0 25%,#f7f3ec 50%,#efe9e0 75%);
  background-size:200% 100%; animation: shimmer 1.4s ease infinite; color:transparent !important;
}
@keyframes shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}

table{width:100%; border-collapse:collapse; font-size:13px;}
th{text-align:left; font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:var(--ink-3); padding:0 0 10px; border-bottom:1px solid var(--border);}
td{padding:10px 0; border-bottom:1px solid var(--surface-3); color:var(--ink-2);}
tr:last-child td{border-bottom:none;}
.td-num{text-align:right; color:var(--ink); font-weight:600; font-family:var(--mono);}
th.th-num{text-align:right;}
.rank{
  display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px;
  border-radius:6px; margin-right:10px; font-size:10px; font-weight:650; color:var(--ink-2);
  background:var(--surface-2); border:1px solid var(--border); font-family:var(--mono);
}
.page-cell{display:flex; align-items:center;}
.page-name{white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:320px;}

.fn-step{margin-bottom:15px;}
.fn-top{display:flex; justify-content:space-between; align-items:baseline; margin-bottom:7px;}
.fn-name{font-size:13px; color:var(--ink-2); font-weight:520;}
.fn-count{font-size:14px; font-weight:650; font-family:var(--mono);}
.fn-track{height:8px; border-radius:999px; background:var(--surface-3); overflow:hidden;}
.fn-fill{height:100%; border-radius:999px; background:linear-gradient(90deg,#8f8bea,var(--accent)); width:0; transition:width .85s ease;}
.fn-drop{font-size:11px; color:var(--ink-3); margin-top:7px;}
.fn-drop b{color:var(--ink-2); font-weight:650; font-family:var(--mono);}

.gauges{display:grid; grid-template-columns:1fr 1fr; gap:16px;}
.gauge{text-align:center;}
.gauge svg{display:block; margin:0 auto;}
.gauge-cap{font-size:11px; color:var(--ink-3); margin-top:8px;}
.ring-bg{stroke:var(--surface-3);}
.ring-fg{stroke-linecap:round; transition:stroke-dashoffset 1s ease;}

.pace-row{display:grid; grid-template-columns:1fr; gap:12px;}
@media(min-width:760px){.pace-row{grid-template-columns:repeat(3,1fr);}}
.pace-tile{background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius); padding:14px 15px;}
.pace-label{font-size:10.5px; font-weight:650; color:var(--ink-3); text-transform:uppercase; letter-spacing:0.05em;}
.pace-values{display:flex; align-items:baseline; gap:7px; margin-top:9px;}
.pace-today{font-size:22px; font-weight:650; letter-spacing:-0.02em; font-family:var(--mono);}
.pace-typical{font-size:11.5px; color:var(--ink-3); font-family:var(--mono);}
.pace-row .delta{margin-top:10px;}

.bk-row{display:flex; align-items:center; gap:13px; margin-bottom:13px;}
.bk-row:last-child{margin-bottom:0;}
.bk-label{flex:0 0 32%; font-size:12px; color:var(--ink-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.bk-track{flex:1; height:8px; border-radius:999px; background:var(--surface-3); overflow:hidden;}
.bk-fill{height:100%; border-radius:999px; background:linear-gradient(90deg,#8f8bea,var(--accent)); width:0; transition:width .85s ease;}
.bk-fill.alt{background:linear-gradient(90deg,var(--green),#0e7f42);}
.bk-count{flex:0 0 50px; text-align:right; font-size:12px; font-weight:650; font-family:var(--mono);}

.seg{display:inline-flex; background:var(--surface-2); border:1px solid var(--border); border-radius:999px; padding:3px; gap:2px;}
.seg-btn{border:none; background:transparent; color:var(--ink-3); font-family:var(--sans); font-size:12px; font-weight:600; padding:6px 14px; border-radius:999px;}
.seg-btn:hover{color:var(--ink-2);}
.seg-btn.active{background:var(--accent); color:#fff; box-shadow:var(--shadow-sm);}

.ai-note{
  display:none; margin-top:14px; padding:11px 13px;
  background:linear-gradient(135deg,var(--accent-soft),#fdf7ee); border-radius:var(--radius);
  font-size:12px; line-height:1.55; color:var(--accent-ink);
}
.ai-note.visible{display:block;}
.ai-note .ai-tag{display:inline-block; font-weight:700; font-size:9px; letter-spacing:0.07em; color:var(--accent); margin-right:6px;}

.empty{font-size:12px; color:var(--ink-3); background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius); padding:16px; text-align:center; line-height:1.5;}
.note{font-size:11px; color:var(--ink-3); margin-top:14px; padding-top:12px; border-top:1px solid var(--surface-3); line-height:1.6;}
.loading{color:var(--ink-3); font-size:12px;}
canvas{max-width:100%;}

.ai-empty-state{font-size:12px; color:var(--ink-3); padding:24px 0; text-align:center;}
.ai-loading{font-size:12px; color:var(--ink-2); padding:24px 0; text-align:center;}
.ai-output{font-size:13px; line-height:1.65; color:var(--ink-2);}
.ai-output .ai-h{font-size:14.5px; font-weight:650; margin:20px 0 8px;}
.ai-output .ai-h:first-child{margin-top:0;}
.ai-output p{margin:0 0 10px;}
.ai-output .ai-list{margin:0 0 12px; padding-left:18px;}
.ai-output .ai-list li{margin-bottom:6px;}
.ai-output b{color:var(--ink); font-weight:650;}
.ai-sources{display:flex; flex-wrap:wrap; gap:7px; margin-top:6px;}
.ai-source-link{
  font-size:11px; color:var(--ink-2); text-decoration:none; background:var(--surface-2); border:1px solid var(--border);
  padding:5px 11px; border-radius:999px; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:inline-block;
}
.ai-source-link:hover{color:var(--accent-ink);}
.ai-error{font-size:12px; color:var(--danger); background:var(--danger-soft); border-radius:var(--radius); padding:13px;}
.ai-scan-log-list{display:flex; flex-direction:column; gap:1px; max-height:280px; overflow-y:auto;}
.ai-scan-log-row{display:flex; align-items:baseline; justify-content:space-between; gap:16px; padding:10px 2px; border-bottom:1px solid var(--surface-3);}
.ai-scan-log-row:last-child{border-bottom:none;}
.ai-scan-log-date{font-size:12px; font-weight:600; color:var(--ink); white-space:nowrap;}
.ai-scan-log-preview{font-size:11.5px; color:var(--ink-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;}
.ai-scan-log-sources{font-size:10.5px; color:var(--ink-3); white-space:nowrap;}
`;

const ANALYTICS_BODY = `
<div class="unlock-overlay hidden" id="access-error-overlay">
  <div class="unlock-box">
    <div class="icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    </div>
    <h3>Access required</h3>
    <p id="access-error-text">This page is protected by Cloudflare Access. If you're seeing this, you may have reached it through an unprotected URL.</p>
    <div class="actions">
      <button type="button" class="btn ghost" onclick="window.location.href='/'">Back to Tasks</button>
    </div>
  </div>
</div>

<nav class="dash-nav">
  <div class="brand">
    Andrew's Work <span class="sub" id="dash-role-label">&hellip;</span>
  </div>
  <div class="page-links">
    <a href="/">Tasks</a>
    <a href="/analytics" class="active">Analytics</a>
  </div>
  <div class="spacer"></div>
  <span class="live-chip"><span class="live-dot"></span>LIVE</span>
  <span class="clock" id="dash-clock">--:--:--</span>
  <button class="btn ghost sm" onclick="window.location.href='/'">Back to Tasks</button>
  <a class="btn danger sm" href="/cdn-cgi/access/logout" style="text-decoration:none;">Log out</a>
</nav>

<div class="shell hidden" id="analytics-content">
  <div class="page-head">
    <h1>Write with Us &mdash; Tool Performance</h1>
    <p>How the AI card-writing tool is performing: who uses it, where they drop off, and what they write. Site-wide traffic appears further down as supporting context.</p>
  </div>

  <div class="sec">
    <div class="sec-head"><h2>Is the Tool Working?</h2></div>
    <div class="stat-row">
      <div class="stat">
        <div class="stat-top">
          <div class="stat-ico i-amber"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          <div class="stat-label">Messages generated</div>
        </div>
        <div class="stat-value num" id="hero-messages"><span class="skel">000</span></div>
        <div class="stat-caption" id="hero-messages-regen">last 7 days</div>
      </div>
      <div class="stat">
        <div class="stat-top">
          <div class="stat-ico i-accent"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          <div class="stat-label">Adoption rate</div>
        </div>
        <div class="stat-value num" id="kpi-adoption"><span class="skel">00%</span></div>
        <div class="stat-caption">panel opens &divide; product page views</div>
      </div>
      <div class="stat">
        <div class="stat-top">
          <div class="stat-ico i-accent"><svg viewBox="0 0 24 24"><path d="M6 6h15l-1.5 9h-12z"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="17" cy="19" r="1.3"/></svg></div>
          <div class="stat-label">Saved to cart</div>
        </div>
        <div class="stat-value num" id="kpi-savedcart"><span class="skel">000</span></div>
        <div class="stat-caption">visitors who kept a message</div>
      </div>
      <div class="stat">
        <div class="stat-top">
          <div class="stat-ico i-green"><svg viewBox="0 0 24 24"><path d="M3 6h18M6 12h12M10 18h4" stroke-linecap="round"/></svg></div>
          <div class="stat-label">Funnel completion</div>
        </div>
        <div class="stat-value num" id="kpi-completion"><span class="skel">00%</span></div>
        <div class="stat-caption">panel open &rarr; saved to cart</div>
      </div>
    </div>
    <div class="grid" style="margin-top:16px">
      <div class="ai-insight-card s12">
        <div class="ai-badge"><svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" stroke-linejoin="round"/></svg>Summary</div>
        <div class="ai-insight-title">Tool Performance Snapshot</div>
        <div class="ai-insight-body" id="hero-verdict">Calculating&hellip;</div>
        <div class="conf-row"><span>Funnel completion</span><span class="num" id="conf-value">&mdash;</span></div>
        <div class="conf-track"><div class="conf-fill" id="conf-fill"></div></div>
      </div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-head"><h2>Where People Drop Off</h2></div>
    <div class="grid">
      <div class="card s8">
        <div class="card-head">
          <div><div class="card-title">The Funnel</div><div class="card-hint">Unique visitors reaching each step &mdash; each step is a true subset of the one above.</div></div>
          <span class="chip">7 days</span>
        </div>
        <div id="funnel-container"><div class="loading">Loading&hellip;</div></div>
        <div class="ai-note" id="ai-note-funnel"><span class="ai-tag">AI</span><span id="ai-note-funnel-text"></span></div>
      </div>
      <div class="card s4">
        <div class="card-head"><div class="card-title">Adoption &amp; Regeneration</div></div>
        <div class="gauges" id="rates-container">
          <div class="gauge"><div class="loading">&hellip;</div><div class="gauge-cap">Adoption rate</div></div>
          <div class="gauge"><div class="loading">&hellip;</div><div class="gauge-cap">Regeneration rate</div></div>
        </div>
        <div class="note">High regeneration means the first draft usually isn't landing.</div>
      </div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-head"><h2>What They're Writing</h2></div>
    <div class="grid">
      <div class="card s12">
        <div class="card-head">
          <div class="card-title">Occasions, Tones &amp; Cards</div>
          <div class="seg" id="gen-tabs">
            <button class="seg-btn active" data-key="occasion">Occasions</button>
            <button class="seg-btn" data-key="tone">Tones</button>
            <button class="seg-btn" data-key="card">Cards</button>
          </div>
        </div>
        <div id="gen-breakdown"><div class="loading">Loading&hellip;</div></div>
      </div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-head"><h2>Right Now</h2></div>
    <div class="grid">
      <div class="card s4">
        <div class="card-head"><div class="card-title">Active Now</div><span class="chip">Last 30 min</span></div>
        <div class="stat-value num" id="kpi-active"><span class="skel">00</span></div>
      </div>
      <div class="card s8">
        <div class="card-head">
          <div><div class="card-title">Today vs. Typical Pace</div><div class="card-hint" id="pace-window-label">Comparing today so far to the same time-of-day average.</div></div>
          <span class="chip" id="pace-asof-label">&mdash;</span>
        </div>
        <div class="pace-row" id="pace-container">
          <div class="pace-tile"><div class="loading">Loading&hellip;</div></div>
          <div class="pace-tile"><div class="loading">Loading&hellip;</div></div>
          <div class="pace-tile"><div class="loading">Loading&hellip;</div></div>
        </div>
        <div class="ai-note" id="ai-note-pace"><span class="ai-tag">AI</span><span id="ai-note-pace-text"></span></div>
      </div>
      <div class="card s4">
        <div class="card-head"><div class="card-title">Top Pages Right Now</div><span class="chip">Realtime</span></div>
        <table id="active-pages-table"><tbody><tr><td class="loading">Loading&hellip;</td></tr></tbody></table>
      </div>
      <div class="card s4">
        <div class="card-head"><div class="card-title">Devices</div><span class="chip">7 days</span></div>
        <canvas id="devices-chart" height="170"></canvas>
        <div class="ai-note" id="ai-note-devices"><span class="ai-tag">AI</span><span id="ai-note-devices-text"></span></div>
      </div>
      <div class="card s4">
        <div class="card-head"><div class="card-title">Traffic Channels</div><span class="chip">7 days</span></div>
        <div id="channels-breakdown"><div class="loading">Loading&hellip;</div></div>
      </div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-head"><h2>Business Impact <span style="font-weight:500; text-transform:none; font-size:11.5px; color:var(--ink-3);">&mdash; site-wide context</span></h2></div>
    <div class="grid">
      <div class="card s12">
        <div class="card-head">
          <div><div class="card-title">Traffic &amp; Purchases Over Time</div><div class="card-hint" id="trend-window-label">Hover for exact daily values</div></div>
          <div class="seg" id="trend-tabs">
            <button class="seg-btn active" data-days="30">30D</button>
            <button class="seg-btn" data-days="60">60D</button>
            <button class="seg-btn" data-days="90">90D</button>
          </div>
        </div>
        <canvas id="full-trend-chart" height="76"></canvas>
        <div class="ai-note" id="ai-note-traffic"><span class="ai-tag">AI</span><span id="ai-note-traffic-text"></span></div>
      </div>
      <div class="card s12">
        <div class="card-head">
          <div><div class="card-title">Before vs After Launch</div><div class="card-hint">Site-wide daily averages &mdash; do these track with the tool's adoption above?</div></div>
          <span class="chip" id="launch-date-label">&mdash;</span>
        </div>
        <table id="comparison-table">
          <thead><tr><th>Metric (daily average)</th><th class="th-num">Before</th><th class="th-num">After</th><th class="th-num">Change</th></tr></thead>
          <tbody><tr><td colspan="4" class="loading">Loading&hellip;</td></tr></tbody>
        </table>
        <div class="note" id="comparison-caveat"></div>
        <div class="ai-note" id="ai-note-comparison"><span class="ai-tag">AI</span><span id="ai-note-comparison-text"></span></div>
      </div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-head"><h2>AI Insights</h2>
      <button class="btn primary" id="ai-analyze-btn">
        <svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" stroke-linejoin="round"/></svg>
        Analyze with AI
      </button>
    </div>
    <div class="grid">
      <div class="card s12">
        <div class="card-head">
          <div><div class="card-title">Research &amp; Recommendations</div><div class="card-hint">Everything the last Analyze run collected &mdash; competitive research, market trends, and prioritized recommendations, with sources.</div></div>
        </div>
        <div id="ai-insights-container"><div class="ai-empty-state">Click <b>Analyze with AI</b> above to generate a briefing. Takes 15&ndash;40 seconds.</div></div>
        <div class="note" id="ai-sources-note" style="display:none"></div>
      </div>
      <div class="card s12">
        <div class="card-head">
          <div><div class="card-title">Scan Log</div><div class="card-hint">Date and time of every AI analysis run, saved automatically.</div></div>
        </div>
        <div id="ai-scan-log-container"><div class="ai-empty-state">Loading&hellip;</div></div>
      </div>
    </div>
  </div>
</div>
`;

const ANALYTICS_JS = `
function pad(n){return String(n).padStart(2,'0');}
function tickAClock(){
  const now = new Date();
  const t = pad(now.getHours())+':'+pad(now.getMinutes())+':'+pad(now.getSeconds());
  const el = document.getElementById('dash-clock'); if (el) el.textContent = t;
}
setInterval(tickAClock, 1000); tickAClock();

// Auth for this page is handled entirely by Cloudflare Access at the edge \\u2014
// there is no passcode flow here. We just confirm the Access header made it
// through before rendering, and show a clear message if it didn't.
async function aapi(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (opts.body) opts.headers['Content-Type'] = 'application/json';
  return fetch(path, opts);
}

async function boot(){
  const res = await aapi('/api/analytics/whoami');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const errText = document.getElementById('access-error-text');
    if (errText && body.error) errText.textContent = body.error;
    document.getElementById('access-error-overlay').classList.remove('hidden');
    return;
  }
  const { email } = await res.json();
  const label = document.getElementById('dash-role-label');
  if (label) label.textContent = email || 'Authenticated';
  document.getElementById('analytics-content').classList.remove('hidden');
  refreshAll();
}

var fmt = function(n) { return Number(n).toLocaleString(); };
var fmt1 = function(n) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }); };
var fmtMoney = function(n) { return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
var pct = function(n) { return (n === null || n === undefined) ? '\\u2014' : n.toFixed(1) + '%'; };
function emptyState(msg) { return '<div class="empty">' + msg + '</div>'; }

Chart.defaults.font.family = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
Chart.defaults.font.size = 11.5;
Chart.defaults.color = '#71717a';

var C = { ink: '#0a0a0f', accent: '#5b5bd6', green: '#16a34a', amber: '#d97706', danger:'#dc2626', grid: 'rgba(10,10,15,0.06)' };
var tooltipStyle = { backgroundColor: '#0a0a0f', borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1, titleColor: '#fff', bodyColor: '#e4e4e7', padding: 12, cornerRadius: 8, usePointStyle: true, boxWidth: 8, boxHeight: 8, titleFont: { weight: 'bold' }, callbacks: { title: function (items) { return (items && items[0] && items[0].label) ? items[0].label : ''; }, label: function (ctx) { var name = (ctx.dataset && ctx.dataset.label) ? ctx.dataset.label : ''; var v = ctx.parsed && (ctx.parsed.y !== undefined && ctx.parsed.y !== null) ? ctx.parsed.y : null; return name + ': ' + (v === null ? '\\u2014' : Number(v).toLocaleString()); } } };

function countUp(el, target, opts) {
  opts = opts || {};
  if (target === null || target === undefined) { el.textContent = '\\u2014'; return; }
  var dur = 900, start = null;
  var fmtFn = opts.pct ? function (v) { return v.toFixed(1) + '%'; } : (opts.money ? fmtMoney : (opts.dec ? fmt1 : fmt));
  function frame(ts) {
    if (!start) start = ts;
    var p = Math.min((ts - start) / dur, 1);
    var eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtFn(target * eased);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function gaugeSVG(value, color) {
  var r = 30, c = 2 * Math.PI * r;
  var v = (value === null || value === undefined) ? 0 : Math.max(0, Math.min(100, value));
  var off = c - (v / 100) * c;
  return '<svg width="76" height="76" viewBox="0 0 76 76">' +
    '<circle class="ring-bg" cx="38" cy="38" r="' + r + '" fill="none" stroke-width="6"/>' +
    '<circle class="ring-fg" cx="38" cy="38" r="' + r + '" fill="none" stroke-width="6" stroke="' + color + '"' +
    ' stroke-dasharray="' + c + '" stroke-dashoffset="' + c + '" transform="rotate(-90 38 38)"' +
    ' data-target="' + off + '"/>' +
    '<text x="38" y="43" text-anchor="middle" fill="#0a0a0f" font-size="14" font-weight="700">' +
    ((value === null || value === undefined) ? '\\u2014' : value.toFixed(1) + '%') + '</text></svg>';
}
function animateGauges(container) {
  requestAnimationFrame(function () {
    container.querySelectorAll('.ring-fg').forEach(function (ring) {
      ring.style.strokeDashoffset = ring.getAttribute('data-target');
    });
  });
}

function renderBars(elId, data, cssClass) {
  var el = document.getElementById(elId);
  if (!data || data.length === 0) { el.innerHTML = emptyState('No data in this window yet.'); return; }
  var max = Math.max.apply(null, data.map(function (d) { return d.count; }));
  el.innerHTML = data.map(function (d) {
    var width = (d.count / max) * 100;
    return '<div class="bk-row"><div class="bk-label" title="' + d.label + '">' + d.label + '</div>' +
      '<div class="bk-track"><div class="bk-fill ' + (cssClass || '') + '" data-w="' + width + '"></div></div>' +
      '<div class="bk-count num">' + fmt(d.count) + '</div></div>';
  }).join('');
  requestAnimationFrame(function () {
    el.querySelectorAll('.bk-fill').forEach(function (f) { f.style.width = f.getAttribute('data-w') + '%'; });
  });
}
function renderBreakdown(elId, data, label) {
  var el = document.getElementById(elId);
  if (data === null) {
    el.innerHTML = emptyState('Register \\u201c' + label + '\\u201d as a custom dimension in GA4 Admin \\u2192 Custom definitions to unlock this.');
    return;
  }
  renderBars(elId, data, '');
}

function loadRealtime() {
  return aapi('/api/analytics/realtime').then(function (res) { return res.json(); }).then(function (data) {
    var rows = data.rows || [];
    var total = rows.reduce(function (sum, r) { return sum + Number(r.metricValues[0].value); }, 0);
    countUp(document.getElementById('kpi-active'), total);
    var tbody = rows.slice(0, 8).map(function (r, i) {
      return '<tr><td><span class="page-cell"><span class="rank">' + (i + 1) + '</span>' +
        '<span class="page-name" title="' + r.dimensionValues[0].value + '">' + r.dimensionValues[0].value + '</span></span></td>' +
        '<td class="td-num num">' + fmt(r.metricValues[0].value) + '</td></tr>';
    }).join('');
    document.querySelector('#active-pages-table').innerHTML =
      '<thead><tr><th>Page</th><th class="th-num">Users</th></tr></thead><tbody>' +
      (tbody || '<tr><td colspan="2" class="loading">No active users right now</td></tr>') + '</tbody>';
  }).catch(function () { document.getElementById('kpi-active').textContent = '\\u2014'; });
}

function buildToolVerdict(data) {
  var messages = data.eventCounts.message_generated;
  if (!messages) { return 'No messages generated yet in this window.'; }
  var adoption = data.rates.adoptionRate;
  var regen = data.rates.regenerationRate;
  var adoptionTxt = (adoption === null || adoption === undefined) ? 'an unknown share' : adoption.toFixed(1) + '%';
  var regenTxt = (regen === null || regen === undefined) ? '' : ' About ' + regen.toFixed(1) + '% of those get regenerated at least once \\u2014 worth checking if the first draft is landing.';
  return fmt(messages) + ' messages generated this week. ' + adoptionTxt + ' of product-page visitors who saw the tool opened the panel.' + regenTxt;
}

var genData = { occasion: null, tone: null, card: null };
var currentGenTab = 'occasion';
var genLabels = { occasion: 'occasion', tone: 'tone', card: 'card_title' };
function renderGenTab(key) { currentGenTab = key; renderBreakdown('gen-breakdown', genData[key], genLabels[key]); }
document.querySelectorAll('#gen-tabs .seg-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('#gen-tabs .seg-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    renderGenTab(btn.getAttribute('data-key'));
  });
});

function loadToolMetrics() {
  return aapi('/api/analytics/tool-metrics?days=7').then(function (res) { return res.json(); }).then(function (data) {
    var max = data.funnel[0].count || 1;
    var html = '';
    for (var i = 0; i < data.funnel.length; i++) {
      var step = data.funnel[i];
      html += '<div class="fn-step"><div class="fn-top"><span class="fn-name">' + step.label + '</span>' +
        '<span class="fn-count num">' + fmt(step.count) + '</span></div>' +
        '<div class="fn-track"><div class="fn-fill" data-w="' + ((step.count / max) * 100) + '"></div></div>';
      if (i < data.funnel.length - 1) {
        var next = data.funnel[i + 1];
        var retained = step.count > 0 ? Math.min(100, (next.count / step.count) * 100).toFixed(1) : '\\u2014';
        html += '<div class="fn-drop"><b>' + retained + '%</b> continued</div>';
      } else { html += '<div style="height:4px"></div>'; }
      html += '</div>';
    }
    var fc = document.getElementById('funnel-container');
    fc.innerHTML = html;
    requestAnimationFrame(function () { fc.querySelectorAll('.fn-fill').forEach(function (f) { f.style.width = f.getAttribute('data-w') + '%'; }); });
    var rc = document.getElementById('rates-container');
    rc.innerHTML =
      '<div class="gauge">' + gaugeSVG(data.rates.adoptionRate, C.accent) + '<div class="gauge-cap">Adoption rate</div></div>' +
      '<div class="gauge">' + gaugeSVG(data.rates.regenerationRate, C.amber) + '<div class="gauge-cap">Regeneration rate</div></div>';
    animateGauges(rc);
    countUp(document.getElementById('hero-messages'), data.eventCounts.message_generated);
    var regenCap = document.getElementById('hero-messages-regen');
    regenCap.textContent = (data.rates.regenerationRate === null || data.rates.regenerationRate === undefined) ? 'last 7 days' : data.rates.regenerationRate.toFixed(1) + '% regenerate \\u00b7 last 7 days';
    countUp(document.getElementById('kpi-adoption'), data.rates.adoptionRate, { pct: true });
    countUp(document.getElementById('kpi-savedcart'), data.eventCounts.message_saved_to_cart);
    var completion = data.eventUsers && data.eventUsers.panel_opened > 0 ? Math.min(100, data.eventUsers.message_saved_to_cart / data.eventUsers.panel_opened * 100) : null;
    countUp(document.getElementById('kpi-completion'), completion, { pct: true });
    var cf = document.getElementById('conf-fill');
    var cv = document.getElementById('conf-value');
    if (cf && cv) {
      cv.textContent = (completion === null) ? '\\u2014' : completion.toFixed(1) + '%';
      requestAnimationFrame(function () { cf.style.width = (completion === null ? 0 : Math.max(2, completion)) + '%'; });
    }
    document.getElementById('hero-verdict').textContent = buildToolVerdict(data);
    genData = { occasion: data.occasionBreakdown, tone: data.toneBreakdown, card: data.cardBreakdown };
    renderGenTab(currentGenTab);
  }).catch(function () {
    document.getElementById('funnel-container').innerHTML = emptyState('Failed to load tool metrics.');
    document.getElementById('hero-verdict').textContent = 'Could not load tool performance data.';
  });
}

var devicesChart;
var donutCenterPlugin = {
  id: 'donutCenter',
  afterDraw: function (chart) {
    var opts = chart.options.plugins && chart.options.plugins.donutCenter;
    if (!opts || opts.value === undefined) return;
    var ctx = chart.ctx;
    var meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || !meta.data[0]) return;
    var cx = meta.data[0].x, cy = meta.data[0].y;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0a0a0f'; ctx.font = '650 20px JetBrains Mono, monospace';
    ctx.fillText(opts.value, cx, cy - 9);
    ctx.fillStyle = '#a1a1aa'; ctx.font = '700 9px Helvetica, Arial, sans-serif';
    ctx.fillText(opts.label, cx, cy + 13);
    ctx.restore();
  }
};
Chart.register(donutCenterPlugin);

function loadSiteInsights() {
  return aapi('/api/analytics/site-insights?days=7').then(function (res) { return res.json(); }).then(function (data) {
    if (data.channels) { renderBars('channels-breakdown', data.channels, 'alt'); }
    else { document.getElementById('channels-breakdown').innerHTML = emptyState('Channel data unavailable.'); }
    if (data.devices && data.devices.length) {
      var totalSessions = data.devices.reduce(function (sum, d) { return sum + d.count; }, 0);
      var ctx = document.getElementById('devices-chart').getContext('2d');
      var cfg = {
        type: 'doughnut',
        data: {
          labels: data.devices.map(function (d) { return d.label.charAt(0).toUpperCase() + d.label.slice(1); }),
          datasets: [{ data: data.devices.map(function (d) { return d.count; }),
            backgroundColor: [C.accent, C.amber, C.green, '#8f8bea'],
            borderColor: '#ffffff', borderWidth: 4, hoverOffset: 6 }]
        },
        options: {
          responsive: true, cutout: '72%',
          plugins: {
            legend: { position: 'bottom', labels: { color: '#71717a', usePointStyle: true, pointStyle: 'circle', boxWidth: 7, padding: 16 } },
            tooltip: tooltipStyle,
            donutCenter: { value: fmt(totalSessions), label: 'SESSIONS' }
          }
        }
      };
      if (devicesChart) { devicesChart.data = cfg.data; devicesChart.options = cfg.options; devicesChart.update(); } else { devicesChart = new Chart(ctx, cfg); }
    }
  }).catch(function () {});
}

function chgText(v) { if (v === null || v === undefined) return '\\u2014'; return (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }
function hourLabel(h) { var ampm = h >= 12 ? 'PM' : 'AM'; var h12 = h % 12; if (h12 === 0) h12 = 12; return h12 + ':00 ' + ampm; }

function loadTodayPace() {
  return aapi('/api/analytics/today-pace').then(function (res) { return res.json(); }).then(function (data) {
    document.getElementById('pace-asof-label').textContent = 'As of ' + hourLabel(data.asOfHour);
    document.getElementById('pace-window-label').textContent =
      'Comparing today\\u2019s activity through ' + hourLabel(data.asOfHour) + ' to the average of the same window across the last ' + data.baselineDays + ' days.';
    var tiles = [
      { label: 'Sessions', today: data.today.sessions, typical: data.typicalByThisHour.sessions, change: data.change.sessions },
      { label: 'Active users', today: data.today.activeUsers, typical: data.typicalByThisHour.activeUsers, change: data.change.activeUsers },
      { label: 'Purchases', today: data.today.purchases, typical: data.typicalByThisHour.purchases, change: data.change.purchases }
    ];
    document.getElementById('pace-container').innerHTML = tiles.map(function (t) {
      var sign = t.change === null || t.change === undefined ? '' : (t.change > 0 ? '\\u2191 ' : (t.change < 0 ? '\\u2193 ' : ''));
      var cls = t.change === null || t.change === undefined ? 'flat' : (t.change > 0 ? 'up' : (t.change < 0 ? 'down' : 'flat'));
      var changeTxt = (t.change === null || t.change === undefined) ? 'no baseline' : sign + Math.abs(t.change).toFixed(1) + '% vs typical pace';
      return '<div class="pace-tile"><div class="pace-label">' + t.label + '</div>' +
        '<div class="pace-values"><span class="pace-today num">' + fmt(t.today) + '</span>' +
        '<span class="pace-typical num">/ ' + fmt1(t.typical) + ' typical</span></div>' +
        '<span class="delta ' + cls + '">' + changeTxt + '</span></div>';
    }).join('');
  }).catch(function () { document.getElementById('pace-container').innerHTML = emptyState('Failed to load today\\u2019s pace comparison.'); });
}

function loadComparison() {
  return aapi('/api/analytics/comparison').then(function (res) { return res.json(); }).then(function (data) {
    document.getElementById('launch-date-label').textContent = 'Launch ' + data.launchDate;
    var rows = [
      { label: 'Sessions / day', before: data.before.perDay.sessions, after: data.after.perDay.sessions, change: data.change.sessionsPerDay },
      { label: 'Active users / day', before: data.before.perDay.activeUsers, after: data.after.perDay.activeUsers, change: data.change.activeUsersPerDay },
      { label: 'New users / day', before: data.before.perDay.newUsers, after: data.after.perDay.newUsers, change: data.change.newUsersPerDay },
      { label: 'Purchases / day', before: data.before.perDay.purchases, after: data.after.perDay.purchases, change: data.change.purchasesPerDay },
      { label: 'Revenue / day', before: data.before.perDay.revenue, after: data.after.perDay.revenue, change: data.change.revenuePerDay, isMoney: true },
      { label: 'Avg order value', before: data.before.perDay.aov, after: data.after.perDay.aov, change: data.change.aov, isMoney: true },
      { label: 'Conversion rate', before: data.before.perDay.conversionRate, after: data.after.perDay.conversionRate, change: data.change.conversionRate, isPct: true },
      { label: 'Engagement rate', before: data.before.perDay.engagementRate, after: data.after.perDay.engagementRate, change: data.change.engagementRate, isPct: true }
    ];
    var html = rows.map(function (r) {
      var f = r.isPct ? pct : (r.isMoney ? function (v) { return (v === null || v === undefined) ? '\\u2014' : fmtMoney(v); } : fmt1);
      var pillCls = r.change === null || r.change === undefined ? 'flat' : (r.change > 0 ? 'up' : (r.change < 0 ? 'down' : 'flat'));
      return '<tr><td>' + r.label + '</td><td class="td-num num">' + f(r.before) + '</td><td class="td-num num">' + f(r.after) + '</td>' +
        '<td class="td-num"><span class="delta ' + pillCls + '">' + chgText(r.change) + '</span></td></tr>';
    }).join('');
    document.querySelector('#comparison-table tbody').innerHTML = html;
    document.getElementById('comparison-caveat').textContent =
      'Before: ' + data.before.days + '-day average (' + data.before.start + ' \\u2192 ' + data.before.end + '). ' +
      'After: ' + data.after.days + '-day average (' + data.after.start + ' \\u2192 ' + data.after.end + ').' +
      (data.after.days < 7 ? ' Only ' + data.after.days + ' day(s) of post-launch data \\u2014 treat as early signal.' : '') +
      ' Revenue figures require Shopify\\u2019s GA4 purchase tracking; if they read $0.00, verify that integration.';
  }).catch(function () {
    document.querySelector('#comparison-table tbody').innerHTML = '<tr><td colspan="4">' + emptyState('Failed to load comparison.') + '</td></tr>';
  });
}

var fullTrendChart;
var launchLinePlugin = {
  id: 'launchLine',
  afterDraw: function (chart) {
    var opts = chart.options.plugins && chart.options.plugins.launchLine;
    if (!opts || opts.index === null || opts.index === undefined) return;
    var xScale = chart.scales.x, yScale = chart.scales.y;
    var x = xScale.getPixelForValue(opts.index);
    var ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = '#d97706'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(x, yScale.top); ctx.lineTo(x, yScale.bottom); ctx.stroke();
    ctx.fillStyle = '#a0611f'; ctx.font = 'bold 10px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center';
    var labelX = Math.min(Math.max(x, xScale.left + 26), xScale.right - 26);
    ctx.fillText('LAUNCH', labelX, yScale.top - 6);
    ctx.restore();
  }
};
Chart.register(launchLinePlugin);

var currentTrendDays = 30;
function loadFullTrend(days) {
  var d = days || currentTrendDays;
  currentTrendDays = d;
  return aapi('/api/analytics/full-trend?days=' + d).then(function (res) { return res.json(); }).then(function (payload) {
    document.getElementById('trend-window-label').textContent = d + ' days before launch through today \\u00b7 hover for exact daily values';
    var rows = (payload.report.rows || []).slice();
    var labels = rows.map(function (r) { var v = r.dimensionValues[0].value; return v.slice(4, 6) + '/' + v.slice(6, 8); });
    var rawDates = rows.map(function (r) { return r.dimensionValues[0].value; });
    var launchDateCompact = payload.launchDate.replace(/-/g, '');
    var launchIndex = rawDates.indexOf(launchDateCompact);
    var sessions = rows.map(function (r) { return Number(r.metricValues[0].value); });
    var activeUsers = rows.map(function (r) { return Number(r.metricValues[1].value); });
    var purchases = rows.map(function (r) { return Number(r.metricValues[2].value); });
    var ctx = document.getElementById('full-trend-chart').getContext('2d');
    var cfg = {
      type: 'line',
      data: { labels: labels, datasets: [
        { label: 'Sessions', data: sessions, borderColor: '#5b5bd6', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2.3, yAxisID: 'y' },
        { label: 'Active users', data: activeUsers, borderColor: '#16a34a', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2, borderDash: [4,3], yAxisID: 'y' },
        { label: 'Purchases', data: purchases, borderColor: '#d97706', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2, yAxisID: 'y1' }
      ] },
      options: {
        responsive: true, interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', align: 'start', labels: { color: '#71717a', usePointStyle: true, pointStyle: 'circle', boxWidth: 7, padding: 16 } },
          tooltip: tooltipStyle, launchLine: { index: launchIndex >= 0 ? launchIndex : null }
        },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { color: C.grid, drawTicks: false }, border: { display: false } },
          y: { position: 'left', beginAtZero: true, ticks: { padding: 8 }, grid: { color: C.grid, drawTicks: false }, border: { display: false }, title: { display: true, text: 'Sessions / Active users', color: '#a1a1aa', font: { size: 10 } } },
          y1: { position: 'right', beginAtZero: true, ticks: { padding: 8 }, grid: { display: false }, border: { display: false }, title: { display: true, text: 'Purchases', color: '#a1a1aa', font: { size: 10 } } }
        }
      }
    };
    if (fullTrendChart) { fullTrendChart.data = cfg.data; fullTrendChart.options = cfg.options; fullTrendChart.update(); } else { fullTrendChart = new Chart(ctx, cfg); }
  }).catch(function () { document.getElementById('full-trend-chart').outerHTML = '<div class="empty">Failed to load traffic trend.</div>'; });
}

document.querySelectorAll('#trend-tabs .seg-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('#trend-tabs .seg-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    loadFullTrend(Number(btn.getAttribute('data-days')));
  });
});

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function renderAIMarkdown(text) {
  var lines = escapeHtml(text).split('\\n');
  var html = ''; var inList = false;
  lines.forEach(function (raw) {
    var line = raw.trim();
    if (/^#{1,4}\\s+/.test(line)) { if (inList) { html += '</ul>'; inList = false; } html += '<div class="ai-h">' + line.replace(/^#{1,4}\\s+/, '') + '</div>'; }
    else if (/^[-*]\\s+/.test(line)) { if (!inList) { html += '<ul class="ai-list">'; inList = true; } html += '<li>' + line.replace(/^[-*]\\s+/, '') + '</li>'; }
    else if (line === '') { if (inList) { html += '</ul>'; inList = false; } }
    else { if (inList) { html += '</ul>'; inList = false; } html += '<p>' + line + '</p>'; }
  });
  if (inList) html += '</ul>';
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<b>$1</b>');
  return html;
}
function showNote(key, text) {
  var note = document.getElementById('ai-note-' + key);
  var textEl = document.getElementById('ai-note-' + key + '-text');
  if (!note || !textEl || !text) return;
  textEl.textContent = text; note.classList.add('visible');
}

function loadAIInsights() {
  var btn = document.getElementById('ai-analyze-btn');
  var container = document.getElementById('ai-insights-container');
  var sourcesNote = document.getElementById('ai-sources-note');
  btn.disabled = true; btn.textContent = 'Analyzing\\u2026';
  container.innerHTML = '<div class="ai-loading">Researching competitors, trends, and your data&hellip;</div>';
  sourcesNote.style.display = 'none';
  return aapi('/api/analytics/ai-insights').then(function (res) { return res.json(); }).then(function (data) {
    if (data.error) { throw new Error(data.error); }
    var sections = data.sections || {};
    showNote('traffic', sections.TRAFFIC_TREND);
    showNote('comparison', sections.LAUNCH_COMPARISON);
    showNote('pace', sections.TODAY_PACE);
    showNote('funnel', sections.TOOL_FUNNEL);
    showNote('devices', sections.DEVICES_CHANNELS);
    var briefing = sections.FULL_BRIEFING || data.rawText || 'No response text returned.';
    container.innerHTML = '<div class="ai-output">' + renderAIMarkdown(briefing) + '</div>';
    if (data.sources && data.sources.length) {
      sourcesNote.style.display = 'block';
      sourcesNote.innerHTML = '<b style="color:var(--accent-ink)">Sources</b><div class="ai-sources">' +
        data.sources.map(function (s) { return '<a class="ai-source-link" href="' + s.url + '" target="_blank" rel="noopener" title="' + escapeHtml(s.title) + '">' + escapeHtml(s.title) + '</a>'; }).join('') + '</div>';
    }
    loadAIScanLog();
  }).catch(function (err) {
    container.innerHTML = '<div class="ai-error">Analysis failed: ' + escapeHtml(err.message) + '</div>';
  }).finally(function () { btn.disabled = false; btn.textContent = 'Analyze with AI'; });
}
document.getElementById('ai-analyze-btn').addEventListener('click', loadAIInsights);

function loadAIScanLog() {
  var container = document.getElementById('ai-scan-log-container');
  if (!container) return;
  return aapi('/api/analytics/ai-scan-log').then(function (res) { return res.json(); }).then(function (data) {
    var log = data.log || [];
    if (!log.length) {
      container.innerHTML = '<div class="ai-empty-state">No scans run yet.</div>';
      return;
    }
    container.innerHTML = '<div class="ai-scan-log-list">' + log.map(function (entry) {
      var d = new Date(entry.ts);
      var dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
        ' \\u00B7 ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      var sourceStr = (entry.sourceCount || 0) + ' source' + (entry.sourceCount === 1 ? '' : 's');
      return '<div class="ai-scan-log-row">' +
        '<span class="ai-scan-log-date">' + escapeHtml(dateStr) + '</span>' +
        '<span class="ai-scan-log-preview">' + escapeHtml(entry.preview || '') + '</span>' +
        '<span class="ai-scan-log-sources">' + sourceStr + '</span>' +
        '</div>';
    }).join('') + '</div>';
  }).catch(function () {
    container.innerHTML = '<div class="ai-error">Could not load scan log.</div>';
  });
}
loadAIScanLog();

function refreshAll() {
  return Promise.all([loadRealtime(), loadToolMetrics(), loadComparison(), loadFullTrend(), loadSiteInsights(), loadTodayPace()]);
}

boot();
`;

var _b;
const ANALYTICS_HTML = String.raw(_b || (_b = __template([`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<title>Analytics · Andrew's Work</title>
<link rel="icon" type="image/png" href="${FAVICON_IMG}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
<style>`, "</style>\n</head>\n<body>\n", "\n<script>", "<\/script>\n</body>\n</html>"])), ANALYTICS_CSS, ANALYTICS_BODY, ANALYTICS_JS);

// ============================================================
// Combined router
// ============================================================
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(HTML, { headers: { "content-type": "text/html;charset=UTF-8" } });
    }
    if (url.pathname === "/analytics" && request.method === "GET") {
      return new Response(ANALYTICS_HTML, { headers: { "content-type": "text/html;charset=UTF-8" } });
    }
    if (url.pathname.startsWith("/api/analytics/")) {
      return handleAnalyticsApi(request, env, url.pathname);
    }
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url.pathname);
    }
    return new Response("Not found", { status: 404 });
  }
};

export {
  worker_default as default
};
