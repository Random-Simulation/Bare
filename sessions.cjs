/* ------------------------------------------------------------------ */
/* Saved session file management — all chats persisted as JSON files  */
/* ------------------------------------------------------------------ */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const sessionsDir = path.join(app.getPath("userData"), "sessions");
const lastSessionFile = path.join(app.getPath("userData"), "lastSessionId.json");
const INDEX_FILE = "index.json"; // lightweight id -> { title, createdAt } map

// In-memory copy of the index; keeps listSessions() at one small file read
// instead of parsing every session's full history/chatHtml/eventLog.
let _indexCache = null;

function _ensureDirs() {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

function _sessionPath(id) {
  return path.join(sessionsDir, `${id}.json`);
}

function _indexPath() {
  return path.join(sessionsDir, INDEX_FILE);
}

function _loadIndex() {
  if (_indexCache) return _indexCache;
  _indexCache = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(_indexPath(), "utf8"));
    for (const [id, meta] of Object.entries(data)) {
      if (meta && typeof meta === "object") _indexCache.set(id, meta);
    }
  } catch { /* no index yet — built lazily by listSessions() */ }
  return _indexCache;
}

function _saveIndex() {
  try {
    fs.writeFileSync(_indexPath(), JSON.stringify(Object.fromEntries(_indexCache)), "utf8");
  } catch (e) { console.error("Failed to save session index:", e); }
}

// ── Last-session tracking ──

function _saveLastSessionId(id) {
  try { fs.writeFileSync(lastSessionFile, JSON.stringify({ id }), "utf8"); }
  catch (e) { console.error("Failed to save last session ID:", e); }
}

function _loadLastSessionId() {
  try {
    if (fs.existsSync(lastSessionFile)) {
      return JSON.parse(fs.readFileSync(lastSessionFile, "utf8")).id || null;
    }
  } catch (e) { console.error("Failed to load last session ID:", e); }
  return null;
}

function clearLastSession() {
  try {
    if (fs.existsSync(lastSessionFile)) fs.unlinkSync(lastSessionFile);
  } catch (e) { console.error("Failed to clear last session:", e); }
}

// ── Session CRUD ──

function listSessions() {
  _ensureDirs();
  try {
    const index = _loadIndex();
    let dirty = false;

    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json") && f !== INDEX_FILE);
    const onDisk = new Set(files.map(f => f.replace(".json", "")));

    // Drop index entries whose file no longer exists.
    for (const id of [...index.keys()]) {
      if (!onDisk.has(id)) { index.delete(id); dirty = true; }
    }

    const sessions = [];
    for (const file of files) {
      const id = file.replace(".json", "");
      let meta = index.get(id);
      if (!meta) {
        // Unknown file (legacy or added manually) — parse once, then index it.
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), "utf8"));
          meta = { title: data.title || "Untitled", createdAt: data.createdAt };
          index.set(id, meta);
          dirty = true;
        } catch { /* skip corrupt files */ }
      }
      if (meta) sessions.push({ id, title: meta.title, createdAt: meta.createdAt });
    }

    if (dirty) _saveIndex();
    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sessions;
  } catch (e) {
    console.error("Failed to list sessions:", e);
    return [];
  }
}

function loadSession(id) {
  try {
    const fp = _sessionPath(id);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (e) { console.error("Failed to load session:", e); }
  return null;
}

function saveSession({ id, title, history, chatHtml, eventLog }) {
  _ensureDirs();
  try {
    const fp = _sessionPath(id);
    const index = _loadIndex();
    // createdAt normally comes from the index — no need to re-read/parse the
    // full (potentially large) session file.
    let createdAt = index.get(id)?.createdAt;
    if (!createdAt && fs.existsSync(fp)) {
      try {
        const existing = JSON.parse(fs.readFileSync(fp, "utf8"));
        createdAt = existing.createdAt; // legacy file not in index yet
      } catch { /* use new timestamp */ }
    }
    createdAt = createdAt || new Date().toISOString();
    fs.writeFileSync(fp, JSON.stringify({
      id, title, createdAt, history, chatHtml, eventLog,
    }), "utf8");
    index.set(id, { title: title || "Untitled", createdAt });
    _saveIndex();
    _saveLastSessionId(id);
  } catch (e) { console.error("Failed to save session:", e); }
}

function deleteSession(id) {
  try {
    const fp = _sessionPath(id);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    const index = _loadIndex();
    if (index.delete(id)) _saveIndex();
  } catch (e) { console.error("Failed to delete session:", e); }
}

function newSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadLastSession() {
  const lastId = _loadLastSessionId();
  if (!lastId) return null;
  return loadSession(lastId);
}

module.exports = { listSessions, loadSession, saveSession, deleteSession, newSessionId, loadLastSession, clearLastSession };
