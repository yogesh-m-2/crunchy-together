// Otaku Sync — admin panel.
//
//   node admin.js          then open http://127.0.0.1:3310
//
// Browse every table in the database and edit any value. Runs as its own
// process so a mistake here cannot take the API down.
//
// SECURITY: binds to 127.0.0.1 by default, so it is NOT reachable from the
// internet. Reach it from your laptop with an SSH tunnel:
//
//   ssh -L 3310:127.0.0.1:3310 root@YOUR_SERVER
//
// then browse to http://127.0.0.1:3310 locally. Only set ADMIN_BIND=0.0.0.0
// if you have put HTTPS in front of it — this panel can rewrite anything,
// including who has paid.

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");

const PORT = parseInt(process.env.ADMIN_PORT || "3310", 10);
const BIND = process.env.ADMIN_BIND || "127.0.0.1";
const USER = process.env.ADMIN_USER || "yogesh";
const PASS = process.env.ADMIN_PASS || "pass@shreya";
const SECRET =
  process.env.ADMIN_SECRET || process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// The API creates this too, but the admin panel may open a database that
// hasn't been through a new API start yet.
db.exec(`
CREATE TABLE IF NOT EXISTS events (
  day   TEXT NOT NULL,
  name  TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);`);

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false }));

// ------------------------------------------------------------------ session

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
}

function makeCookie() {
  const exp = Date.now() + 8 * 3600 * 1000; // 8 hours
  const body = `${USER}.${exp}`;
  return `${body}.${sign(body)}`;
}

function validCookie(raw) {
  if (!raw) return false;
  const parts = String(raw).split(".");
  if (parts.length !== 3) return false;
  const [user, exp, mac] = parts;
  const want = Buffer.from(sign(`${user}.${exp}`));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
  return parseInt(exp, 10) > Date.now();
}

function cookies(req) {
  const out = {};
  for (const part of (req.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function requireAuth(req, res, next) {
  if (validCookie(cookies(req).ots_admin)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorised" });
  res.redirect("/login");
}

const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const arr = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(ip, arr);
  return arr.length >= 10;
}

// -------------------------------------------------------------------- login

app.get("/login", (req, res) => res.send(loginPage(req.query.err)));

app.post("/login", (req, res) => {
  const ip = req.ip || "?";
  if (throttled(ip)) return res.status(429).send(loginPage("Too many attempts. Wait 15 minutes."));

  const u = String(req.body.username || "");
  const p = String(req.body.password || "");
  const okUser = u.length === USER.length && crypto.timingSafeEqual(Buffer.from(u), Buffer.from(USER));
  const okPass = p.length === PASS.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(PASS));

  if (!okUser || !okPass) {
    attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
    return res.status(401).send(loginPage("Wrong username or password."));
  }
  res.set(
    "Set-Cookie",
    `ots_admin=${makeCookie()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${8 * 3600}`
  );
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  res.set("Set-Cookie", "ots_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.redirect("/login");
});

// --------------------------------------------------------------------- data

// Only ever touch tables and columns that genuinely exist — this is what makes
// the dynamic SQL below safe.
function tables() {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
}

function columns(table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
}

function assertTable(name) {
  if (!tables().includes(name)) throw new Error("unknown table");
  return name;
}

function assertColumn(table, name) {
  if (!columns(table).includes(name)) throw new Error("unknown column");
  return name;
}

app.get("/api/tables", requireAuth, (req, res) => {
  res.json({
    tables: tables().map((t) => ({
      name: t,
      count: db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n,
    })),
  });
});

app.get("/api/rows", requireAuth, (req, res) => {
  try {
    const table = assertTable(String(req.query.table || ""));
    const cols = columns(table);
    const limit = Math.min(parseInt(req.query.limit || "100", 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset || "0", 10) || 0, 0);
    const search = String(req.query.q || "").trim();

    let where = "";
    const params = {};
    if (search) {
      where = "WHERE " + cols.map((c) => `CAST("${c}" AS TEXT) LIKE @q`).join(" OR ");
      params.q = `%${search}%`;
    }

    const total = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" ${where}`).get(params).n;
    const rows = db
      .prepare(`SELECT rowid AS _rowid, * FROM "${table}" ${where} ORDER BY rowid DESC LIMIT ${limit} OFFSET ${offset}`)
      .all(params);

    res.json({ table, columns: cols, rows, total, limit, offset });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/update", requireAuth, (req, res) => {
  try {
    const table = assertTable(String(req.body.table || ""));
    const column = assertColumn(table, String(req.body.column || ""));
    const rowid = parseInt(req.body.rowid, 10);
    if (!Number.isFinite(rowid)) throw new Error("bad rowid");

    // Empty string means NULL; numbers stay numbers so comparisons keep working.
    let value = req.body.value;
    if (value === "" || value === null) value = null;
    else if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) {
      value = Number(value);
    }

    const info = db
      .prepare(`UPDATE "${table}" SET "${column}" = @value WHERE rowid = @rowid`)
      .run({ value, rowid });
    const row = db.prepare(`SELECT rowid AS _rowid, * FROM "${table}" WHERE rowid = ?`).get(rowid);
    res.json({ ok: true, changes: info.changes, row });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/delete", requireAuth, (req, res) => {
  try {
    const table = assertTable(String(req.body.table || ""));
    const rowid = parseInt(req.body.rowid, 10);
    if (!Number.isFinite(rowid)) throw new Error("bad rowid");
    const info = db.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).run(rowid);
    res.json({ ok: true, changes: info.changes });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Handy shortcuts for the things you'll actually want to change.
app.post("/api/grant", requireAuth, (req, res) => {
  try {
    const userId = parseInt(req.body.user_id, 10);
    const days = parseInt(req.body.days, 10);
    if (!Number.isFinite(userId) || !Number.isFinite(days)) throw new Error("bad input");
    const until = Date.now() + days * 86400000;
    db.prepare("UPDATE users SET paid_until = ?, sub_status = 'manual' WHERE id = ?").run(until, userId);
    res.json({ ok: true, paid_until: until });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ------------------------------------------------------------------- usage

app.get("/api/usage", requireAuth, (req, res) => {
  const days = Math.min(parseInt(req.query.days || "30", 10) || 30, 180);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const totals = db
    .prepare("SELECT name, SUM(count) AS total FROM events WHERE day >= ? GROUP BY name ORDER BY total DESC")
    .all(since);
  const daily = db
    .prepare("SELECT day, name, count FROM events WHERE day >= ? ORDER BY day DESC")
    .all(since);

  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const guests = db.prepare("SELECT COUNT(*) AS n FROM users WHERE guest_device IS NOT NULL").get().n;
  const signedUp = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE email IS NOT NULL OR google_id IS NOT NULL OR facebook_id IS NOT NULL")
    .get().n;
  const paying = db.prepare("SELECT COUNT(*) AS n FROM users WHERE paid_until > ?").get(Date.now()).n;
  const newUsers = db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at > ?").get(Date.now() - 7 * 86400000).n;
  const activeDevices = db
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE revoked = 0 AND last_seen > ?")
    .get(Date.now() - 7 * 86400000).n;

  res.json({
    days, totals, daily,
    summary: { users, guests, signedUp, paying, newUsers, activeDevices },
    billing: String(process.env.BILLING_ENABLED || "false") === "true",
  });
});

// ------------------------------------------------------------------ system

function readNetBytes() {
  try {
    const lines = require("fs").readFileSync("/proc/net/dev", "utf8").split("\n").slice(2);
    let rx = 0, tx = 0;
    for (const line of lines) {
      const [iface, rest] = line.split(":");
      if (!rest || /^\s*lo$/.test(iface)) continue;
      const f = rest.trim().split(/\s+/);
      rx += Number(f[0]) || 0;
      tx += Number(f[8]) || 0;
    }
    return { rx, tx };
  } catch (_) {
    return null;
  }
}

app.get("/api/system", requireAuth, (req, res) => {
  const fs = require("fs");
  const os = require("os");
  const out = { now: Date.now() };

  // Disk
  try {
    const s = fs.statfsSync(path.dirname(DB_PATH));
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    out.disk = { total, free, used: total - free, pct: Math.round(((total - free) / total) * 100) };
  } catch (_) {}

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  out.memory = {
    total: totalMem, free: freeMem, used: totalMem - freeMem,
    pct: Math.round(((totalMem - freeMem) / totalMem) * 100),
  };

  // Database file (plus its write-ahead log)
  let dbSize = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { dbSize += fs.statSync(DB_PATH + suffix).size; } catch (_) {}
  }
  out.database = { bytes: dbSize, rows: {} };
  for (const t of tables()) {
    try { out.database.rows[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n; } catch (_) {}
  }

  // Network counters are cumulative since boot.
  out.net = readNetBytes();
  out.load = os.loadavg();
  out.cpus = os.cpus().length;
  out.uptime = os.uptime();
  res.json(out);
});

app.get("/", requireAuth, (req, res) => res.send(adminPage()));

// -------------------------------------------------------------------- pages

const shell = (body, extra = "") => `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Otaku Sync admin</title><style>
:root{color-scheme:dark}*{box-sizing:border-box;margin:0;font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif}
body{background:#10131a;color:#e6e9f2;font-size:14px}
a{color:#ffb03b}
.center{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:360px;background:#171b24;border:1px solid #262c3a;border-radius:12px;padding:26px}
h1{font-size:19px;margin-bottom:16px}
label{display:block;font-size:12px;color:#8b93a7;margin:12px 0 5px}
input,select{width:100%;background:#10131a;color:#e6e9f2;border:1px solid #262c3a;border-radius:7px;padding:9px;font-size:14px}
input:focus,select:focus{outline:none;border-color:#ffb03b}
button{padding:9px 14px;border-radius:7px;border:1px solid #333b4d;background:#212736;color:#e6e9f2;font-size:13px;cursor:pointer}
button:hover{border-color:#4a5468}
button.primary{background:#ffb03b;border-color:#ffb03b;color:#191400;font-weight:600;width:100%;margin-top:16px}
.err{color:#ff9d9d;font-size:13px;margin-bottom:10px}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid #1e2431;background:#171b24;position:sticky;top:0;z-index:5}
header h1{font-size:15px;flex:1}
.wrap{display:flex;min-height:calc(100vh - 53px)}
nav{width:210px;border-right:1px solid #1e2431;padding:12px;flex:none}
nav button{display:block;width:100%;text-align:left;margin-bottom:5px;background:none;border:0;padding:8px 10px;border-radius:6px;color:#b6bccb}
nav button:hover{background:#212736;color:#e6e9f2}
nav button.on{background:#212736;color:#ffb03b;font-weight:600}
nav .n{font:11px ui-monospace,monospace;color:#59627a;float:right}
main{flex:1;padding:16px;overflow:auto}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:12px}
.bar input{max-width:280px}
table{border-collapse:collapse;width:100%;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
th,td{border:1px solid #232a38;padding:5px 7px;text-align:left;vertical-align:top;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
th{background:#171b24;color:#8b93a7;position:sticky;top:0}
td[contenteditable]{cursor:text}
td[contenteditable]:focus{outline:2px solid #ffb03b;background:#1a1f2b;white-space:normal;overflow:visible}
td.null{color:#59627a;font-style:italic}
td.ts{color:#9fd3ff}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:18px}
.card2{background:#171b24;border:1px solid #262c3a;border-radius:9px;padding:12px}
.card2 .k{font:11px ui-monospace,monospace;color:#8b93a7;text-transform:uppercase;letter-spacing:.08em}
.card2 .v{font-size:22px;font-weight:600;margin-top:4px}
.card2 .s{font:11px ui-monospace,monospace;color:#59627a;margin-top:2px}
.bar2{height:7px;background:#10131a;border:1px solid #262c3a;border-radius:4px;overflow:hidden;margin-top:7px}
.bar2 span{display:block;height:100%;background:#5fd1a0}
.bar2 span.warn{background:#ffb03b}
.bar2 span.bad{background:#e06060}
h2{font-size:14px;margin:18px 0 9px;color:#ffb03b}
.note2{color:#8b93a7;font-size:12px;margin-bottom:12px}
.pill{display:inline-block;padding:2px 9px;border-radius:20px;font:11px ui-monospace,monospace;border:1px solid #333b4d}
.pill.on{border-color:#5fd1a0;color:#5fd1a0}
.pill.off{border-color:#ffb03b;color:#ffb03b}
tr:hover td{background:#161b25}
.del{color:#ff9d9d;cursor:pointer;user-select:none}
.hint{color:#8b93a7;font-size:12px;margin-bottom:10px}
.toast{position:fixed;right:16px;bottom:16px;background:#212736;border:1px solid #333b4d;border-radius:8px;padding:9px 14px;font-size:13px;opacity:0;transition:opacity .2s}
.toast.on{opacity:1}
.toast.bad{border-color:#7a2f2f;color:#ff9d9d}
</style></head><body>${body}${extra}</body></html>`;

const loginPage = (err) =>
  shell(`<div class="center"><form class="card" method="POST" action="/login">
  <h1>Otaku Sync admin</h1>
  ${err ? `<p class="err">${String(err).replace(/[<>&]/g, "")}</p>` : ""}
  <label for="u">Username</label><input id="u" name="username" autocomplete="username" autofocus>
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
  <button class="primary" type="submit">Sign in</button>
</form></div>`);

const adminPage = () =>
  shell(
    `<header>
  <h1>Otaku Sync — database</h1>
  <span class="hint" id="dbpath"></span>
  <form method="POST" action="/logout"><button type="submit">Sign out</button></form>
</header>
<div class="wrap">
  <nav id="nav"></nav>
  <main>
    <div class="bar" id="tools">
      <input id="q" placeholder="Search this table…">
      <button id="reload">Reload</button>
      <button id="dates">Dates: readable</button>
      <span class="hint" id="meta"></span>
    </div>
    <p class="hint" id="edithint">Click any cell to edit. Enter saves, Escape cancels. Empty value stores NULL.</p>
    <div id="dash"></div>
    <div id="tablewrap" style="overflow:auto"><table id="tbl"></table></div>
    <div class="bar" id="pager" style="margin-top:12px">
      <button id="prev">← Previous</button><button id="next">Next →</button>
    </div>
  </main>
</div>
<div class="toast" id="toast"></div>`,
    `<script>
const $ = (s) => document.querySelector(s);
let current = null, offset = 0, limit = 100, showDates = true;

// Columns holding milliseconds-since-epoch. Shown as readable dates, but
// still edited as either a date string or a raw number.
const isTime = (c) => /(_at|_until)$/.test(c) || c === "last_seen" || c === "expires_at";

function fmtTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1e11) return String(v);
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, "0");
  const rel = relTime(n);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
         pad(d.getHours()) + ":" + pad(d.getMinutes()) + (rel ? "  (" + rel + ")" : "");
}

function relTime(ms) {
  const diff = ms - Date.now();
  const days = Math.round(Math.abs(diff) / 86400000);
  const hrs = Math.round(Math.abs(diff) / 3600000);
  if (hrs < 1) return diff >= 0 ? "soon" : "just now";
  if (hrs < 48) return diff >= 0 ? "in " + hrs + "h" : hrs + "h ago";
  return diff >= 0 ? "in " + days + "d" : days + "d ago";
}

// Accepts "2026-09-15", "2026-09-15 18:30" or a raw millisecond number.
function parseTime(text) {
  const t = text.trim();
  if (/^\d{11,}$/.test(t)) return Number(t);
  const ms = Date.parse(t.includes(" ") ? t.replace(" ", "T") : t);
  return Number.isFinite(ms) ? ms : null;
}

function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast on" + (bad ? " bad" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast"), 2200);
}

// Any API call can come back 401 once the session expires. Send the user to
// the login page rather than leaving a blank screen.
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    window.location = "/login";
    throw new Error("session expired");
  }
  if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
  return res.json();
}

async function loadTables() {
  const nav = $("#nav");
  let r;
  try {
    r = await api("/api/tables");
  } catch (e) {
    // Say what went wrong instead of showing an empty sidebar.
    nav.innerHTML = '<div style="padding:10px;color:#ff9d9d;font-size:12px">' +
      "Couldn't load tables.<br>" + String(e.message || e) +
      '<br><br><a href="/login" style="color:#ffb03b">Sign in again</a></div>';
    console.error("loadTables failed:", e);
    return;
  }
  nav.innerHTML = "";

  for (const v of [["usage", "Usage"], ["system", "System"]]) {
    const b = document.createElement("button");
    b.textContent = v[1];
    b.dataset.name = "@" + v[0];
    b.onclick = () => { current = "@" + v[0]; paint(); showView(); };
    nav.appendChild(b);
  }
  const sep = document.createElement("div");
  sep.style.cssText = "border-top:1px solid #1e2431;margin:8px 0";
  nav.appendChild(sep);

  for (const t of r.tables) {
    const b = document.createElement("button");
    b.innerHTML = t.name + '<span class="n">' + t.count + "</span>";
    b.onclick = () => { current = t.name; offset = 0; $("#q").value = ""; paint(); showView(); };
    b.dataset.name = t.name;
    nav.appendChild(b);
  }
  if (!current) current = "@usage";
  paint();
  showView();
}

function paint() {
  for (const b of document.querySelectorAll("#nav button")) {
    b.classList.toggle("on", b.dataset.name === current);
  }
}

async function loadRows() {
  if (!current) return;
  const q = encodeURIComponent($("#q").value.trim());
  let r;
  try {
    r = await api("/api/rows?table=" + encodeURIComponent(current) + "&q=" + q + "&limit=" + limit + "&offset=" + offset);
  } catch (e) {
    return toast(String(e.message || e), true);
  }
  if (r.error) return toast(r.error, true);

  $("#meta").textContent = r.total + " rows · showing " + (r.total ? offset + 1 : 0) + "–" + Math.min(offset + limit, r.total);
  const tbl = $("#tbl");
  tbl.innerHTML = "";

  const head = tbl.insertRow();
  head.insertCell().textContent = "";
  for (const c of r.columns) {
    const th = document.createElement("th");
    th.textContent = c;
    head.appendChild(th);
  }
  head.cells[0].outerHTML = "<th></th>";

  for (const row of r.rows) {
    const tr = tbl.insertRow();
    const del = tr.insertCell();
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete this row";
    del.onclick = async () => {
      if (!confirm("Delete this row from " + current + "? This cannot be undone.")) return;
      const res = await fetch("/api/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: current, rowid: row._rowid }),
      }).then((r) => r.json());
      if (res.error) return toast(res.error, true);
      toast("Row deleted");
      loadRows();
    };

    for (const c of r.columns) {
      const td = tr.insertCell();
      const v = row[c];
      const timeCol = isTime(c) && v !== null;
      td.textContent = v === null ? "NULL" : timeCol && showDates ? fmtTime(v) : String(v);
      if (v === null) td.classList.add("null");
      if (timeCol) { td.classList.add("ts"); td.title = String(v); }
      td.contentEditable = "true";
      td.spellcheck = false;
      td.dataset.raw = v === null ? "" : String(v);
      td.dataset.orig = td.textContent;

      td.onfocus = () => {
        // Edit the underlying number, not the pretty version.
        if (timeCol && showDates) td.textContent = td.dataset.raw;
      };
      td.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); td.blur(); }
        if (e.key === "Escape") { td.textContent = td.dataset.orig; td.dataset.cancel = "1"; td.blur(); }
      };
      td.onblur = async () => {
        if (td.dataset.cancel) { delete td.dataset.cancel; return; }
        let val = td.textContent.trim();
        if (val === "NULL") val = "";

        if (isTime(c) && val !== "") {
          const ms = parseTime(val);
          if (ms === null) {
            td.textContent = td.dataset.orig;
            return toast("Use a date like 2026-09-15 18:30, or a raw number", true);
          }
          val = String(ms);
        }
        if (val === td.dataset.raw) {
          td.textContent = td.dataset.orig; // nothing changed, restore display
          return;
        }

        const res = await fetch("/api/update", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ table: current, column: c, rowid: row._rowid, value: val }),
        }).then((r) => r.json());
        if (res.error) { td.textContent = td.dataset.orig; return toast(res.error, true); }

        const nv = res.row ? res.row[c] : val;
        td.dataset.raw = nv === null ? "" : String(nv);
        td.textContent = nv === null ? "NULL" : isTime(c) && showDates ? fmtTime(nv) : String(nv);
        td.classList.toggle("null", nv === null);
        if (nv !== null && isTime(c)) td.title = String(nv);
        td.dataset.orig = td.textContent;
        toast("Saved " + c);
      };
    }
  }
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + " " + u[i];
}

function card(k, v, s, pct) {
  let h = '<div class="card2"><div class="k">' + k + '</div><div class="v">' + v + "</div>";
  if (s) h += '<div class="s">' + s + "</div>";
  if (Number.isFinite(pct)) {
    const cls = pct > 90 ? "bad" : pct > 70 ? "warn" : "";
    h += '<div class="bar2"><span class="' + cls + '" style="width:' + Math.min(pct, 100) + '%"></span></div>';
  }
  return h + "</div>";
}

function showView() {
  const isTable = current && current[0] !== "@";
  $("#tools").style.display = isTable ? "" : "none";
  $("#tablewrap").style.display = isTable ? "" : "none";
  $("#pager").style.display = isTable ? "" : "none";
  $("#dash").style.display = isTable ? "none" : "";
  $("#edithint").style.display = isTable ? "" : "none";
  if (isTable) return loadRows();
  if (current === "@usage") return loadUsage();
  if (current === "@system") return loadSystem();
}

async function loadUsage() {
  let r;
  try {
    r = await api("/api/usage?days=30");
  } catch (e) {
    return toast(String(e.message || e), true);
  }
  if (r.error) return toast(r.error, true);
  const s = r.summary;

  let h = '<h2>Accounts</h2><div class="cards">';
  h += card("Total users", s.users, s.guests + " never signed in");
  h += card("Signed up", s.signedUp, "with an email or social login");
  h += card("Active devices", s.activeDevices, "used in the last 7 days");
  h += card("New this week", s.newUsers, "");
  h += card("Paying", s.paying, r.billing ? "billing is ON" : "billing is OFF");
  h += "</div>";

  h += '<h2>Feature use — last ' + r.days + " days</h2>";
  if (!r.totals.length) {
    h += '<p class="note2">Nothing recorded yet. Counters appear once people start parties.</p>';
  } else {
    const max = Math.max.apply(null, r.totals.map((t) => t.total));
    h += '<table style="max-width:640px">';
    h += "<tr><th>Event</th><th>Total</th><th style='width:55%'></th></tr>";
    for (const t of r.totals) {
      const w = Math.round((t.total / max) * 100);
      h += "<tr><td>" + t.name + "</td><td>" + t.total + "</td>" +
           '<td><div class="bar2"><span style="width:' + w + '%"></span></div></td></tr>';
    }
    h += "</table>";
  }

  const byDay = {};
  for (const d of r.daily) { (byDay[d.day] = byDay[d.day] || []).push(d); }
  const days = Object.keys(byDay).sort().reverse().slice(0, 14);
  if (days.length) {
    h += "<h2>By day</h2><table style='max-width:640px'><tr><th>Day</th><th>Activity</th></tr>";
    for (const d of days) {
      const parts = byDay[d].map((x) => x.name + " " + x.count).join("  ·  ");
      h += "<tr><td>" + d + "</td><td style='white-space:normal'>" + parts + "</td></tr>";
    }
    h += "</table>";
  }
  $("#dash").innerHTML = h;
}

async function loadSystem() {
  let r;
  try {
    r = await api("/api/system");
  } catch (e) {
    return toast(String(e.message || e), true);
  }
  if (r.error) return toast(r.error, true);

  let h = '<h2>Server</h2><div class="cards">';
  if (r.disk) {
    h += card("Disk", fmtBytes(r.disk.used) + " used", fmtBytes(r.disk.free) + " free of " + fmtBytes(r.disk.total), r.disk.pct);
  }
  h += card("Memory", r.memory.pct + "%", fmtBytes(r.memory.used) + " of " + fmtBytes(r.memory.total), r.memory.pct);
  h += card("Load", r.load.map((x) => x.toFixed(2)).join("  "), r.cpus + " CPU core(s) · 1/5/15 min");
  h += card("Uptime", Math.floor(r.uptime / 86400) + "d " + Math.floor((r.uptime % 86400) / 3600) + "h", "");
  if (r.net) {
    h += card("Network in", fmtBytes(r.net.rx), "since last reboot");
    h += card("Network out", fmtBytes(r.net.tx), "since last reboot");
  }
  h += card("Database", fmtBytes(r.database.bytes), "data.sqlite + WAL");
  h += "</div>";

  h += "<h2>Rows per table</h2><table style='max-width:420px'><tr><th>Table</th><th>Rows</th></tr>";
  for (const k of Object.keys(r.database.rows)) {
    h += "<tr><td>" + k + "</td><td>" + r.database.rows[k] + "</td></tr>";
  }
  h += "</table>";

  const memPct = r.memory.pct, diskPct = r.disk ? r.disk.pct : 0;
  let advice;
  if (memPct > 85 || diskPct > 85) {
    advice = "Time to scale. Memory or disk is above 85% — move to a bigger plan before it starts failing.";
  } else if (memPct > 70 || diskPct > 70) {
    advice = "Getting warm. Above 70%: plan the upgrade now, you are not in trouble yet.";
  } else {
    advice = "Plenty of headroom. Sync traffic is tiny — webcam video goes peer-to-peer and never touches this server, so bandwidth is unlikely to be your limit. Watch memory first.";
  }
  h += '<h2>Scaling</h2><p class="note2">' + advice + "</p>";
  h += '<p class="note2">Rough guide for this box: a party costs a few KB per minute of bandwidth and one open socket per person. ' +
       "Memory is the first ceiling — around 10,000 idle sockets per GB. Disk grows mostly with the database, which is a few KB per user.</p>";
  $("#dash").innerHTML = h;
}

$("#reload").onclick = showView;
$("#dates").onclick = () => {
  showDates = !showDates;
  $("#dates").textContent = "Dates: " + (showDates ? "readable" : "raw ms");
  loadRows();
};
$("#q").oninput = () => { offset = 0; clearTimeout(window._s); window._s = setTimeout(loadRows, 300); };
$("#prev").onclick = () => { offset = Math.max(0, offset - limit); loadRows(); };
$("#next").onclick = () => { offset += limit; loadRows(); };
loadTables();
</script>`
  );

app.listen(PORT, BIND, () => {
  console.log(`Otaku Sync admin on http://${BIND}:${PORT}  (db: ${DB_PATH})`);
  if (BIND !== "127.0.0.1") {
    console.warn("WARNING: admin is bound to a public interface. Put HTTPS in front of it.");
  }
});
