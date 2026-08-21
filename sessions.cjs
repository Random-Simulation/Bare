/* ------------------------------------------------------------------ */
/* Saved session file management — all chats persisted as JSON files  */
/* ------------------------------------------------------------------ */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const sessionsDir = path.join(app.getPath("userData"), "sessions");
const lastSessionFile = path.join(app.getPath("userData"), "lastSessionId.json");

function _ensureDirs() {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

function _sessionPath(id) {
  return path.join(sessionsDir, `${id}.json`);
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
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json"));
    const sessions = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), "utf8"));
        sessions.push({ id: file.replace(".json", ""), title: data.title || "Untitled", createdAt: data.createdAt });
      } catch { /* skip corrupt files */ }
    }
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
    let createdAt = new Date().toISOString();
    if (fs.existsSync(fp)) {
      try {
        const existing = JSON.parse(fs.readFileSync(fp, "utf8"));
        if (existing.createdAt) createdAt = existing.createdAt;
      } catch { /* use new timestamp */ }
    }
    fs.writeFileSync(fp, JSON.stringify({
      id, title, createdAt, history, chatHtml, eventLog,
    }), "utf8");
    _saveLastSessionId(id);
  } catch (e) { console.error("Failed to save session:", e); }
}

function deleteSession(id) {
  try {
    const fp = _sessionPath(id);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
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
