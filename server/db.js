// Otaku Sync — storage. SQLite: one file, no daemon, fine well past
// thousands of users on a small VM.

const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const db = new Database(process.env.DB_PATH || path.join(__dirname, "data.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE,
  phone         TEXT UNIQUE,
  name          TEXT,
  pass_hash     TEXT,
  google_id     TEXT UNIQUE,
  facebook_id   TEXT UNIQUE,
  verified      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  trial_ends_at INTEGER NOT NULL,
  paid_until    INTEGER,
  sub_id        TEXT,
  sub_status    TEXT,
  blocked       INTEGER NOT NULL DEFAULT 0
);

-- One row per browser profile that has signed in. device_id is a random UUID
-- the extension stores; it is NOT a hardware identifier (browsers cannot read
-- MAC addresses), so treat it as "this install" rather than "this machine".
CREATE TABLE IF NOT EXISTS devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  device_id  TEXT NOT NULL,
  label      TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, device_id)
);

-- Remembers which installs and networks have already consumed a free trial,
-- so a fresh email address alone does not reset the clock.
CREATE TABLE IF NOT EXISTS trial_marks (
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, value)
);

-- Short-lived sign-in handshakes: the extension opens a hosted page, the page
-- authorises, the extension polls for the resulting token.
CREATE TABLE IF NOT EXISTS auth_requests (
  rid        TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  ip         TEXT,
  created_at INTEGER NOT NULL,
  user_id    INTEGER,
  claimed    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS otps (
  ident      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id      TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_sub ON users(sub_id);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
`);

// Guest accounts: a trial can start with no sign-in at all, keyed to the
// device. Added by migration so existing databases upgrade in place.
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes("guest_device")) {
  db.exec("ALTER TABLE users ADD COLUMN guest_device TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_guest ON users(guest_device)");
}

const now = () => Date.now();
const MAX_DEVICES = parseInt(process.env.MAX_DEVICES || "1", 10);

const q = {
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userByPhone: db.prepare("SELECT * FROM users WHERE phone = ?"),
  userByGoogle: db.prepare("SELECT * FROM users WHERE google_id = ?"),
  userByFacebook: db.prepare("SELECT * FROM users WHERE facebook_id = ?"),
  userBySub: db.prepare("SELECT * FROM users WHERE sub_id = ?"),

  insertUser: db.prepare(`
    INSERT INTO users (email, phone, name, pass_hash, google_id, facebook_id,
                       verified, created_at, trial_ends_at)
    VALUES (@email, @phone, @name, @pass_hash, @google_id, @facebook_id,
            @verified, @created_at, @trial_ends_at)
  `),
  setVerified: db.prepare("UPDATE users SET verified = 1 WHERE id = ?"),
  setPassHash: db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?"),
  linkGoogle: db.prepare("UPDATE users SET google_id = ?, verified = 1 WHERE id = ?"),
  linkFacebook: db.prepare("UPDATE users SET facebook_id = ?, verified = 1 WHERE id = ?"),
  setName: db.prepare("UPDATE users SET name = ? WHERE id = ? AND (name IS NULL OR name = '')"),
  setSub: db.prepare("UPDATE users SET sub_id = ?, sub_status = ? WHERE id = ?"),
  setPaid: db.prepare("UPDATE users SET paid_until = ?, sub_status = ? WHERE id = ?"),

  userByGuest: db.prepare("SELECT * FROM users WHERE guest_device = ?"),
  insertGuest: db.prepare(`
    INSERT INTO users (guest_device, verified, created_at, trial_ends_at)
    VALUES (@guest_device, 0, @created_at, @trial_ends_at)
  `),
  // Turn a guest row into a real account, keeping its trial and any payment.
  upgradeGuest: db.prepare(`
    UPDATE users SET email = COALESCE(@email, email),
                     name = COALESCE(@name, name),
                     pass_hash = COALESCE(@pass_hash, pass_hash),
                     google_id = COALESCE(@google_id, google_id),
                     facebook_id = COALESCE(@facebook_id, facebook_id),
                     verified = 1,
                     guest_device = NULL
    WHERE id = @id
  `),

  devices: db.prepare("SELECT * FROM devices WHERE user_id = ? AND revoked = 0 ORDER BY last_seen DESC"),
  deviceFor: db.prepare("SELECT * FROM devices WHERE user_id = ? AND device_id = ?"),
  insertDevice: db.prepare(`
    INSERT INTO devices (user_id, device_id, label, ip, created_at, last_seen)
    VALUES (@user_id, @device_id, @label, @ip, @t, @t)
    ON CONFLICT(user_id, device_id) DO UPDATE SET revoked = 0, last_seen = @t, ip = @ip
  `),
  touchDevice: db.prepare("UPDATE devices SET last_seen = ?, ip = ? WHERE user_id = ? AND device_id = ?"),
  revokeDevice: db.prepare("UPDATE devices SET revoked = 1 WHERE user_id = ? AND id = ?"),

  trialMark: db.prepare("SELECT * FROM trial_marks WHERE kind = ? AND value = ?"),
  addTrialMark: db.prepare(`
    INSERT INTO trial_marks (kind, value, first_seen, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(kind, value) DO UPDATE SET count = count + 1
  `),

  blockUser: db.prepare("UPDATE users SET blocked = 1 WHERE id = ?"),

  newAuthReq: db.prepare(
    "INSERT INTO auth_requests (rid, device_id, ip, created_at) VALUES (?, ?, ?, ?)"
  ),
  getAuthReq: db.prepare("SELECT * FROM auth_requests WHERE rid = ?"),
  fillAuthReq: db.prepare("UPDATE auth_requests SET user_id = ? WHERE rid = ?"),
  claimAuthReq: db.prepare("UPDATE auth_requests SET claimed = 1 WHERE rid = ?"),
  purgeAuthReqs: db.prepare("DELETE FROM auth_requests WHERE created_at < ?"),

  upsertOtp: db.prepare(`
    INSERT INTO otps (ident, code_hash, expires_at, attempts, sent_at, sent_count)
    VALUES (@ident, @code_hash, @expires_at, 0, @sent_at, 1)
    ON CONFLICT(ident) DO UPDATE SET
      code_hash = @code_hash, expires_at = @expires_at, attempts = 0,
      sent_at = @sent_at, sent_count = sent_count + 1
  `),
  getOtp: db.prepare("SELECT * FROM otps WHERE ident = ?"),
  bumpOtpAttempts: db.prepare("UPDATE otps SET attempts = attempts + 1 WHERE ident = ?"),
  clearOtp: db.prepare("DELETE FROM otps WHERE ident = ?"),

  seenEvent: db.prepare("SELECT id FROM webhook_events WHERE id = ?"),
  markEvent: db.prepare("INSERT OR IGNORE INTO webhook_events (id, seen_at) VALUES (?, ?)"),
};

// ---------------------------------------------------------------- passwords

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function checkPassword(pw, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const got = crypto.scryptSync(pw, salt, 64);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// -------------------------------------------------------------------- trial
//
// A trial is granted unless this install or this network has already had one.
// Deliberately forgiving on IP: shared networks (hostels, offices, cafes,
// mobile carrier NAT) would otherwise punish honest users, so the IP rule
// only trips after several signups.

function trialLengthFor(ctx = {}) {
  const days = parseInt(process.env.TRIAL_DAYS || "7", 10);
  const seenDevice = ctx.deviceId && q.trialMark.get("device", ctx.deviceId);
  const seenIp = ctx.ip && q.trialMark.get("ip", ctx.ip);
  if (seenDevice) return 0;
  if (seenIp && seenIp.count >= 4) return 0;
  return days;
}

function markTrialUsed(ctx = {}) {
  const t = now();
  if (ctx.deviceId) q.addTrialMark.run("device", ctx.deviceId, t);
  if (ctx.ip) q.addTrialMark.run("ip", ctx.ip, t);
}

function createUser(fields, ctx = {}) {
  const t = now();
  const trialDays = trialLengthFor(ctx);
  const trialEnd = t + trialDays * 86400000;

  q.insertUser.run({
    email: fields.email || null,
    phone: fields.phone || null,
    name: fields.name || null,
    pass_hash: fields.pass_hash || null,
    google_id: fields.google_id || null,
    facebook_id: fields.facebook_id || null,
    verified: fields.verified ? 1 : 0,
    created_at: t,
    trial_ends_at: trialEnd,
  });
  if (trialDays > 0) markTrialUsed(ctx);

  let user;
  if (fields.email) user = q.userByEmail.get(fields.email);
  else if (fields.phone) user = q.userByPhone.get(fields.phone);
  else if (fields.google_id) user = q.userByGoogle.get(fields.google_id);
  else user = q.userByFacebook.get(fields.facebook_id);
  return user;
}

// A trial that needs no sign-in: the account exists, but is identified only
// by the device. Signing in later upgrades this same row, so the remaining
// trial days and any subscription carry over.
function findOrCreateGuest(deviceId, ip) {
  const existing = q.userByGuest.get(deviceId);
  if (existing) return existing;
  const t = now();
  const trialDays = trialLengthFor({ deviceId, ip });
  q.insertGuest.run({
    guest_device: deviceId,
    created_at: t,
    trial_ends_at: t + trialDays * 86400000,
  });
  if (trialDays > 0) markTrialUsed({ deviceId, ip });
  return q.userByGuest.get(deviceId);
}

// Attach a real identity to whoever is signing in on this device.
//  - identity already known -> use that account
//  - otherwise, a guest on this device is upgraded in place (keeps the trial)
//  - otherwise, a fresh account
function attachIdentity(fields, ctx = {}) {
  const found =
    (fields.email && q.userByEmail.get(fields.email)) ||
    (fields.google_id && q.userByGoogle.get(fields.google_id)) ||
    (fields.facebook_id && q.userByFacebook.get(fields.facebook_id));
  if (found) return found;

  const guest = ctx.deviceId ? q.userByGuest.get(ctx.deviceId) : null;
  if (guest) {
    q.upgradeGuest.run({
      id: guest.id,
      email: fields.email || null,
      name: fields.name || null,
      pass_hash: fields.pass_hash || null,
      google_id: fields.google_id || null,
      facebook_id: fields.facebook_id || null,
    });
    return q.userById.get(guest.id);
  }
  return createUser({ ...fields, verified: 1 }, ctx);
}

function isGuest(user) {
  return !!user && !user.email && !user.phone && !user.google_id && !user.facebook_id;
}

// The single source of truth for "may this user use the product right now".
function entitlement(user) {
  const t = now();
  if (!user || user.blocked) return { active: false, reason: "blocked" };
  if (user.paid_until && user.paid_until > t) {
    return { active: true, reason: "subscribed", until: user.paid_until };
  }
  if (user.trial_ends_at > t) {
    return { active: true, reason: "trial", until: user.trial_ends_at };
  }
  return { active: false, reason: "expired", until: user.trial_ends_at };
}

// ------------------------------------------------------------------ devices

function registerDevice(userId, deviceId, label, ip) {
  const existing = q.deviceFor.get(userId, deviceId);
  if (existing && !existing.revoked) {
    q.touchDevice.run(now(), ip, userId, deviceId);
    return { ok: true };
  }
  const active = q.devices.all(userId);
  if (active.length >= MAX_DEVICES) {
    return {
      ok: false,
      reason: "device-limit",
      devices: active.map((d) => ({
        id: d.id,
        label: d.label || "Unnamed device",
        last_seen: d.last_seen,
      })),
    };
  }
  q.insertDevice.run({ user_id: userId, device_id: deviceId, label, ip, t: now() });
  return { ok: true };
}

function deviceOk(userId, deviceId) {
  if (!deviceId) return false;
  const d = q.deviceFor.get(userId, deviceId);
  return !!(d && !d.revoked);
}

setInterval(() => q.purgeAuthReqs.run(now() - 30 * 60000), 600000).unref();

module.exports = {
  db,
  q,
  now,
  MAX_DEVICES,
  hashPassword,
  checkPassword,
  createUser,
  findOrCreateGuest,
  attachIdentity,
  isGuest,
  entitlement,
  registerDevice,
  deviceOk,
  trialLengthFor,
  markTrialUsed,
};
