"use strict";

/**
 * routes/admin.js
 *
 * Secure admin panel for live pronunciation management.
 * Mounted at:  /admin
 *
 * Routes:
 *   GET  /admin/pronunciation          — serve admin UI
 *   POST /admin/api/login              — authenticate → token
 *   POST /admin/api/logout             — invalidate token
 *   GET  /admin/api/entries            — list all entries  [auth]
 *   POST /admin/api/entries            — add / update entry [auth]
 *   DELETE /admin/api/entries/:word    — delete entry       [auth]
 *   POST /admin/api/test               — preview TTS output [auth]
 *   GET  /admin/api/export             — download JSON      [auth]
 *   POST /admin/api/import             — upload JSON        [auth]
 *   POST /admin/api/reload             — force hot-reload   [auth]
 *   GET  /admin/api/stats              — bank stats         [auth]
 *   GET  /admin/api/master             — read-only master bank [auth]
 *
 * Auth:
 *   Password stored in env ADMIN_PASSWORD (default: "admin123" — change in .env!)
 *   Token (UUID) returned on login, stored in browser localStorage.
 *   All protected routes check: Authorization: Bearer <token>
 *   Tokens expire after 24 h. Server holds token map in memory (survives routes,
 *   lost on restart — user must login again after deploy, which is expected).
 */

const express = require("express");
const path    = require("path");
const crypto  = require("crypto");
const fs      = require("fs");

const router  = express.Router();

const bank    = require("../services/pronunciationBankLoader");
const engine  = require("../services/pronunciationEngine");

// ── Config ────────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || "admin123";
const TOKEN_TTL_MS    = 24 * 60 * 60 * 1000;   // 24 hours
const MASTER_PATH     = bank.MASTER_PATH;

// ── Token store (in-memory, survives route file; reset on server restart) ─────
const _tokens = new Map();  // token → { expiresAt }

function issueToken() {
  const token     = crypto.randomUUID();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  _tokens.set(token, { expiresAt });
  // Clean up expired tokens
  for (const [t, { expiresAt: exp }] of _tokens)
    if (Date.now() > exp) _tokens.delete(t);
  return token;
}

function validateToken(req) {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) return false;
  const entry = _tokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { _tokens.delete(token); return false; }
  return true;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!validateToken(req))
    return res.status(401).json({ error: "Unauthorized. Please login." });
  next();
}

// ── Serve admin HTML UI ───────────────────────────────────────────────────────
router.get("/pronunciation", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin", "pronunciation.html"));
});

// ── Login ─────────────────────────────────────────────────────────────────────
router.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: "Invalid password" });
  const token = issueToken();
  res.json({ token, expiresIn: "24h" });
});

// ── Logout ────────────────────────────────────────────────────────────────────
router.post("/api/logout", (req, res) => {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (token) _tokens.delete(token);
  res.json({ ok: true });
});

// ── Bank stats ────────────────────────────────────────────────────────────────
router.get("/api/stats", requireAuth, (_req, res) => {
  res.json(bank.getBankStats());
});

// ── List all entries (master + admin, merged) ─────────────────────────────────
router.get("/api/entries", requireAuth, (req, res) => {
  try {
    const { search = "", risk = "", source = "", page = "1", limit = "50" } = req.query;

    // Load master bank entries
    let masterEntries = [];
    if (fs.existsSync(MASTER_PATH)) {
      const raw = JSON.parse(fs.readFileSync(MASTER_PATH, "utf8"));
      masterEntries = (raw.pronunciation_bank || []).map(e => ({ ...e, source: "master" }));
    }

    // Load admin entries
    const adminEntries = bank.getAdminEntries().map(e => ({ ...e, source: "admin" }));

    // Merge: admin overrides master
    const adminKeys = new Set(adminEntries.map(e => (e.normalized_word || e.word || "").toLowerCase()));
    const all = [
      ...adminEntries,
      ...masterEntries.filter(e => !adminKeys.has((e.normalized_word || e.word || "").toLowerCase())),
    ];

    // Filter
    let filtered = all;
    if (search)
      filtered = filtered.filter(e =>
        (e.word || "").toLowerCase().includes(search.toLowerCase()) ||
        (e.normalized_word || "").toLowerCase().includes(search.toLowerCase()) ||
        (e.phonetic_version || "").toLowerCase().includes(search.toLowerCase()) ||
        (e.replace_with_if_needed || "").toLowerCase().includes(search.toLowerCase()) ||
        (e.category || "").toLowerCase().includes(search.toLowerCase())
      );
    if (risk)   filtered = filtered.filter(e => e.tts_risk_score === risk);
    if (source) filtered = filtered.filter(e => e.source === source);

    // Paginate
    const pageNum  = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(10, parseInt(limit, 10) || 50));
    const total    = filtered.length;
    const items    = filtered.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({ total, page: pageNum, limit: limitNum, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Add / Update entry ────────────────────────────────────────────────────────
router.post("/api/entries", requireAuth, (req, res) => {
  try {
    const entry = req.body;
    if (!entry || !(entry.word || entry.normalized_word))
      return res.status(400).json({ error: "word is required" });
    const saved = bank.upsertAdminEntry(entry);
    res.json({ ok: true, entry: saved, stats: bank.getBankStats() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Delete entry ──────────────────────────────────────────────────────────────
router.delete("/api/entries/:word", requireAuth, (req, res) => {
  try {
    const word    = decodeURIComponent(req.params.word);
    const deleted = bank.deleteAdminEntry(word);
    if (!deleted)
      return res.status(404).json({ error: `Entry "${word}" not found in admin store` });
    res.json({ ok: true, deleted: word, stats: bank.getBankStats() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Test TTS preprocessing ────────────────────────────────────────────────────
router.post("/api/test", requireAuth, (req, res) => {
  try {
    const { text = "", voiceId = "" } = req.body || {};
    if (!text.trim()) return res.status(400).json({ error: "text is required" });

    const original  = text.trim();
    const processed = engine.process(original, voiceId || null);
    const words     = original.trim().split(/\s+/).length;
    const changed   = original !== processed;

    // Find which words changed
    const origWords = original.split(/\s+/);
    const procWords = processed.split(/\s+/);
    const changes   = [];
    for (let i = 0; i < Math.max(origWords.length, procWords.length); i++) {
      if (origWords[i] !== procWords[i])
        changes.push({ from: origWords[i] || "", to: procWords[i] || "" });
    }

    res.json({ original, processed, words, changed, changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Export admin entries as JSON download ─────────────────────────────────────
router.get("/api/export", requireAuth, (_req, res) => {
  try {
    const entries = bank.getAdminEntries();
    const payload = JSON.stringify({
      meta: { exported: new Date().toISOString(), count: entries.length, source: "admin" },
      entries,
    }, null, 2);
    res.setHeader("Content-Disposition", `attachment; filename="admin_pronunciation_${Date.now()}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.send(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Import JSON (merge into admin entries) ────────────────────────────────────
router.post("/api/import", requireAuth, (req, res) => {
  try {
    const body = req.body;
    // Accept { entries: [...] } or plain array
    const arr  = Array.isArray(body) ? body : (body.entries || body.pronunciation_bank || []);
    if (!Array.isArray(arr)) return res.status(400).json({ error: "Expected JSON array of entries" });

    const count = bank.importAdminEntries(arr);
    res.json({ ok: true, imported: count, stats: bank.getBankStats() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Force hot-reload ──────────────────────────────────────────────────────────
router.post("/api/reload", requireAuth, (_req, res) => {
  try {
    bank.reloadAll();
    res.json({ ok: true, stats: bank.getBankStats() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
