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
    <div class="bar">
      <input id="q" placeholder="Search this table…">
      <button id="reload">Reload</button>
      <span class="hint" id="meta"></span>
    </div>
    <p class="hint">Click any cell to edit. Enter saves, Escape cancels. Empty value stores NULL.</p>
    <div style="overflow:auto"><table id="tbl"></table></div>
    <div class="bar" style="margin-top:12px">
      <button id="prev">← Previous</button><button id="next">Next →</button>
    </div>
  </main>
</div>
<div class="toast" id="toast"></div>`,
    `<script>
const $ = (s) => document.querySelector(s);
let current = null, offset = 0, limit = 100;

function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast on" + (bad ? " bad" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast"), 2200);
}

async function loadTables() {
  const r = await fetch("/api/tables").then((r) => r.json());
  const nav = $("#nav");
  nav.innerHTML = "";
  for (const t of r.tables) {
    const b = document.createElement("button");
    b.innerHTML = t.name + '<span class="n">' + t.count + "</span>";
    b.onclick = () => { current = t.name; offset = 0; $("#q").value = ""; loadRows(); paint(); };
    b.dataset.name = t.name;
    nav.appendChild(b);
  }
  if (!current && r.tables.length) { current = r.tables[0].name; loadRows(); }
  paint();
}

function paint() {
  for (const b of document.querySelectorAll("#nav button")) {
    b.classList.toggle("on", b.dataset.name === current);
  }
}

async function loadRows() {
  if (!current) return;
  const q = encodeURIComponent($("#q").value.trim());
  const r = await fetch("/api/rows?table=" + encodeURIComponent(current) + "&q=" + q + "&limit=" + limit + "&offset=" + offset).then((r) => r.json());
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
      td.textContent = v === null ? "NULL" : String(v);
      if (v === null) td.classList.add("null");
      td.contentEditable = "true";
      td.spellcheck = false;
      td.dataset.orig = td.textContent;
      td.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); td.blur(); }
        if (e.key === "Escape") { td.textContent = td.dataset.orig; td.blur(); }
      };
      td.onblur = async () => {
        let val = td.textContent.trim();
        if (val === td.dataset.orig) return;
        if (val === "NULL") val = "";
        const res = await fetch("/api/update", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ table: current, column: c, rowid: row._rowid, value: val }),
        }).then((r) => r.json());
        if (res.error) { td.textContent = td.dataset.orig; return toast(res.error, true); }
        const nv = res.row ? res.row[c] : val;
        td.textContent = nv === null ? "NULL" : String(nv);
        td.classList.toggle("null", nv === null);
        td.dataset.orig = td.textContent;
        toast("Saved " + c);
      };
    }
  }
}

$("#reload").onclick = loadRows;
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
