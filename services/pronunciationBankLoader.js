"use strict";

/**
 * services/pronunciationBankLoader.js
 *
 * Fast lookup engine over the merged pronunciation master bank.
 * Provides O(1) lookups via hash map + ordered phrase/word pattern arrays
 * that the pronunciationEngine integrates directly into its pipeline.
 *
 * Public API:
 *   loadPronunciationBank()          — initialise / reload (auto-called at startup)
 *   getPronunciation(word)           — returns phonetic_tts form or null
 *   getReplacement(word)             — returns replace_with_if_needed or null
 *   isHindiOrHinglish(word)         — true if not pure English
 *   getRiskScore(word)               — "high"|"medium"|"low"|null
 *   getBankPatterns()                — returns compiled pattern arrays for engine
 *   addFailedWord(original, better) — persist a manual correction
 *   getBankStats()                   — diagnostic counts
 *
 * Pattern arrays (for pronunciationEngine integration):
 *   patterns.phraseHighSubs    [[regex, replacement], ...]  — phrase-level, high risk → English
 *   patterns.phraseMediumPhon  [[regex, phonetic],   ...]  — phrase-level, medium Hindi → phonetic
 *   patterns.wordHighSubs      [[regex, replacement], ...]  — word-level,   high risk → English
 *   patterns.wordMediumPhon    [[regex, phonetic],   ...]  — word-level,   medium Hindi → phonetic
 *
 * Processing rules:
 *   high risk     → always replace with English equivalent (replace_with_if_needed)
 *   medium Hindi  → replace with phonetic_tts hint (vowel-length guidance for TTS)
 *   medium Hinglish → English part is fine; skip phonetic rewrite
 *   low risk      → skip entirely (TTS already handles it correctly)
 *
 * Phrase patterns are sorted LONGEST FIRST so the most specific match wins.
 * All patterns are case-insensitive.
 */

const fs   = require("fs");
const path = require("path");

const MASTER_PATH      = path.join(__dirname, "..", "data", "pronunciation_master.json");
const ADMIN_PATH       = path.join(__dirname, "..", "data", "admin_pronunciation.json");
const FAILED_PATH      = path.join(__dirname, "..", "data", "tts_failed_words.json");

// Words already covered by hardcoded maps in pronunciationEngine.js.
// We skip bank patterns for these so the carefully-tuned hardcoded versions win.
const HARDCODED_COVERED = new Set([
  "log", "use", "hal", "faida", "faayda", "fayda", "mahina", "mahine",
  "mahino", "mhina", "nuksan", "nuqsaan", "nuksaan", "fir", "kyu", "kyun",
  "nah", "nhi", "nahi", "bhe", "bhi", "mai", "main", "krta", "karta",
  "krti", "karti", "krte", "karte", "krna", "karna", "hazar", "hazaar",
  "lakh", "laakh", "krore", "karod", "sach", "roz", "tarika", "hamesha",
  "zindagi", "nikaal", "nikal", "samajh", "sikhna", "sikho", "sikha",
  "seekhna", "seekho", "seekha", "chota", "choti", "chotta", "chotti",
  "chhota", "chhoti", "bhool", "bhul", "waqt", "zehan", "mahine",
  "saal", "baad", "aane", "paisa", "paise", "kharcha", "kharche",
  "lagta", "lagti", "dikhta", "dikhti", "jaanta", "jaanti", "soch",
  "saath", "phir", "kyoon", "warna", "aaj", "kaash",
  // Smart substitution covered
  "laabh", "dhan", "sampadaa", "bachat", "karz", "lakshya", "vyarth",
  "aamdani", "prakar", "mehengai",
]);

// ── Module state ──────────────────────────────────────────────────────────────

/** @type {Map<string, Object>} normalized_word → bank entry */
let _wordMap = new Map();

/** @type {{ phraseHighSubs, phraseMediumPhon, wordHighSubs, wordMediumPhon }} */
let _patterns = null;

let _stats = { total: 0, high: 0, medium: 0, low: 0, phrases: 0, singleWords: 0, loaded: false };

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseKey(word) {
  return String(word || "").toLowerCase().trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(normalizedWord) {
  const escaped = escapeRegex(normalizedWord);
  if (normalizedWord.includes(" ")) {
    // Phrase: match literally (case-insensitive)
    return new RegExp(escaped, "gi");
  }
  // Single word: word-boundary match
  return new RegExp(`\\b${escaped}\\b`, "gi");
}

function isHindi(entry) {
  return String(entry.language_type || "").toLowerCase() === "hindi";
}

// ── Admin entries — read/write ────────────────────────────────────────────────

function loadAdminEntries() {
  try {
    if (!fs.existsSync(ADMIN_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(ADMIN_PATH, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch (_) { return []; }
}

function saveAdminEntries(entries) {
  fs.writeFileSync(ADMIN_PATH, JSON.stringify(entries, null, 2), "utf8");
}

// ── Core loader ───────────────────────────────────────────────────────────────

function loadPronunciationBank() {
  if (!fs.existsSync(MASTER_PATH)) {
    console.warn("[PronunciationBank] Master file not found:", MASTER_PATH);
    console.warn("[PronunciationBank] Run: node tools/mergePronunciationBank.js");
    _stats.loaded = false;
    return;
  }

  try {
    const raw   = JSON.parse(fs.readFileSync(MASTER_PATH, "utf8"));
    const master = raw.pronunciation_bank || [];

    // Admin entries override master bank (same normalized_word = admin wins)
    const adminEntries = loadAdminEntries();
    const adminKeys    = new Set(adminEntries.map(e => normaliseKey(e.normalized_word || e.word)));
    const bank = [
      ...adminEntries,                                    // admin entries first (highest priority)
      ...master.filter(e => !adminKeys.has(normaliseKey(e.normalized_word || e.word))),
    ];

    _wordMap.clear();
    for (const entry of bank) {
      const key = normaliseKey(entry.normalized_word);
      if (key) _wordMap.set(key, entry);
    }

    // ── Build pattern arrays ─────────────────────────────────────────────────
    // Phrases first (sorted longest → shortest, already done in master file).
    // Patterns are split into 4 buckets used at different pipeline stages.

    const phraseHighSubs   = [];  // phrases, high risk   → English replacement
    const phraseMediumPhon = [];  // phrases, medium Hindi → phonetic hint
    const wordHighSubs     = [];  // words,   high risk   → English replacement
    const wordMediumPhon   = [];  // words,   medium Hindi → phonetic hint

    for (const entry of bank) {
      const key        = normaliseKey(entry.normalized_word);
      const isPhrase   = key.includes(" ");
      const risk       = entry.tts_risk_score;
      const hindi      = isHindi(entry);
      const phonetic   = entry.phonetic_tts || entry.phonetic_version?.replace(/-/g, "") || "";
      const english    = entry.replace_with_if_needed || "";

      // Skip words the hardcoded maps already handle precisely
      if (!isPhrase && HARDCODED_COVERED.has(key)) continue;

      // Skip if we have no useful replacement
      if (risk === "high" && !english) continue;
      if (risk === "medium" && !phonetic) continue;
      if (risk === "low") continue;  // TTS handles low-risk fine

      let pattern;
      try { pattern = buildPattern(key); } catch (_) { continue; }

      if (risk === "high") {
        if (isPhrase) phraseHighSubs.push([pattern, english]);
        else          wordHighSubs.push([pattern, english]);
      } else if (risk === "medium" && hindi) {
        // Only rewrite phonetics for pure Hindi words/phrases; Hinglish mixes
        // contain English sub-words that would get mangled by phonetic respelling.
        if (isPhrase) phraseMediumPhon.push([pattern, phonetic]);
        else          wordMediumPhon.push([pattern, phonetic]);
      }
    }

    _patterns = { phraseHighSubs, phraseMediumPhon, wordHighSubs, wordMediumPhon };

    // ── Stats ────────────────────────────────────────────────────────────────
    _stats = {
      total:       bank.length,
      high:        bank.filter(e => e.tts_risk_score === "high").length,
      medium:      bank.filter(e => e.tts_risk_score === "medium").length,
      low:         bank.filter(e => e.tts_risk_score === "low").length,
      phrases:     bank.filter(e => (e.normalized_word || "").includes(" ")).length,
      singleWords: bank.filter(e => !(e.normalized_word || "").includes(" ")).length,
      patterns: {
        phraseHighSubs:   phraseHighSubs.length,
        phraseMediumPhon: phraseMediumPhon.length,
        wordHighSubs:     wordHighSubs.length,
        wordMediumPhon:   wordMediumPhon.length,
      },
      loaded: true,
    };

    console.log(
      `[PronunciationBank] Loaded ${_stats.total} entries` +
      ` (${_stats.high} high-risk, ${_stats.medium} medium, ${_stats.low} low)` +
      ` | ${_stats.phrases} phrases, ${_stats.singleWords} single words` +
      ` | active patterns: ${phraseHighSubs.length + phraseMediumPhon.length + wordHighSubs.length + wordMediumPhon.length}`
    );
  } catch (e) {
    console.error("[PronunciationBank] Load failed:", e.message);
    _stats.loaded = false;
  }
}

// Auto-load at module startup
loadPronunciationBank();

// ── Public lookup API ─────────────────────────────────────────────────────────

/**
 * Returns the TTS-ready phonetic form for a word, or null if not found.
 * Example: getPronunciation("mahina") → "maheenaa"
 */
function getPronunciation(word) {
  const entry = _wordMap.get(normaliseKey(word));
  if (!entry) return null;
  return entry.phonetic_tts || entry.phonetic_version?.replace(/-/g, "") || null;
}

/**
 * Returns the English fallback replacement for a word, or null.
 * Example: getReplacement("bachat") → "savings"
 */
function getReplacement(word) {
  const entry = _wordMap.get(normaliseKey(word));
  if (!entry) return null;
  return entry.replace_with_if_needed || null;
}

/**
 * Returns true if the word is tagged as Hindi or Hinglish (not pure English).
 */
function isHindiOrHinglish(word) {
  const entry = _wordMap.get(normaliseKey(word));
  if (!entry) return false;
  const lt = String(entry.language_type || "").toLowerCase();
  return lt === "hindi" || lt === "hinglish";
}

/**
 * Returns the TTS risk score for a word: "high" | "medium" | "low" | null
 */
function getRiskScore(word) {
  const entry = _wordMap.get(normaliseKey(word));
  return entry ? entry.tts_risk_score : null;
}

/**
 * Returns the compiled pattern buckets for the pronunciation engine pipeline.
 * Call getBankPatterns() once at engine init; the patterns are pre-compiled RegExps.
 */
function getBankPatterns() {
  return _patterns || { phraseHighSubs: [], phraseMediumPhon: [], wordHighSubs: [], wordMediumPhon: [] };
}

/**
 * Returns current bank statistics for diagnostics.
 */
function getBankStats() {
  return { ..._stats };
}

// ── Failure learning ──────────────────────────────────────────────────────────

/**
 * Persist a manual TTS correction for future priority use.
 * These are loaded by pronunciationEngine as highest-priority overrides.
 *
 * @param {string} original   — the word/phrase as it appears in scripts
 * @param {string} correction — the better form to send to TTS
 * @param {string} [note]     — optional description of the fix
 */
function addFailedWord(original, correction, note = "") {
  if (!original || !correction) return false;
  try {
    let existing = [];
    if (fs.existsSync(FAILED_PATH)) {
      existing = JSON.parse(fs.readFileSync(FAILED_PATH, "utf8")) || [];
    }
    // Remove existing entry for the same original
    existing = existing.filter(e => normaliseKey(e.original) !== normaliseKey(original));
    existing.push({
      original,
      correction,
      note,
      added: new Date().toISOString(),
    });
    fs.writeFileSync(FAILED_PATH, JSON.stringify(existing, null, 2), "utf8");
    console.log(`[PronunciationBank] Failed word saved: "${original}" → "${correction}"`);
    return true;
  } catch (e) {
    console.warn("[PronunciationBank] Could not save failed word:", e.message);
    return false;
  }
}

/**
 * Load all manually-corrected failed words.
 * Used by pronunciationEngine to build highest-priority override patterns.
 */
function getFailedWords() {
  try {
    if (!fs.existsSync(FAILED_PATH)) return [];
    return JSON.parse(fs.readFileSync(FAILED_PATH, "utf8")) || [];
  } catch (_) {
    return [];
  }
}

// ── Hot reload — call after any admin change ──────────────────────────────────
/**
 * Fully reloads master bank + admin entries, rebuilds all pattern arrays.
 * No server restart required. Call this after any CRUD operation.
 */
function reloadAll() {
  _wordMap.clear();
  _patterns = null;
  loadPronunciationBank();
  console.log("[PronunciationBank] Hot-reloaded. Active patterns:", (() => {
    const p = getBankPatterns();
    return p.phraseHighSubs.length + p.phraseMediumPhon.length +
           p.wordHighSubs.length   + p.wordMediumPhon.length;
  })());
}

// ── Admin CRUD helpers ────────────────────────────────────────────────────────

/** Return all admin-managed entries */
function getAdminEntries() { return loadAdminEntries(); }

/** Add or update an admin entry. Returns the saved entry. */
function upsertAdminEntry(entry) {
  const entries = loadAdminEntries();
  const key     = normaliseKey(entry.normalized_word || entry.word || "");
  if (!key) throw new Error("word is required");

  const idx = entries.findIndex(e => normaliseKey(e.normalized_word || e.word) === key);
  const now = new Date().toISOString();
  const saved = {
    word:                  entry.word || key,
    normalized_word:       key,
    phonetic_version:      entry.phonetic_version || "",
    phonetic_tts:          (entry.phonetic_version || "").replace(/-/g, ""),
    language_type:         entry.language_type || "Hindi",
    category:              entry.category || "general",
    replace_with_if_needed: entry.replace_with_if_needed || "",
    tts_risk_score:        entry.tts_risk_score || "medium",
    source:                "admin",
    created_at:            idx >= 0 ? entries[idx].created_at : now,
    updated_at:            now,
  };

  if (idx >= 0) entries[idx] = saved;
  else          entries.push(saved);

  saveAdminEntries(entries);
  reloadAll();
  return saved;
}

/** Delete an admin entry by normalised word key. Returns true if deleted. */
function deleteAdminEntry(word) {
  const key     = normaliseKey(word);
  const entries = loadAdminEntries();
  const before  = entries.length;
  const after   = entries.filter(e => normaliseKey(e.normalized_word || e.word) !== key);
  if (after.length === before) return false;
  saveAdminEntries(after);
  reloadAll();
  return true;
}

/** Replace entire admin entries list (import). */
function importAdminEntries(newEntries) {
  if (!Array.isArray(newEntries)) throw new Error("Must be an array");
  const now = new Date().toISOString();
  const cleaned = newEntries.map(e => ({
    word:                  e.word || normaliseKey(e.normalized_word || ""),
    normalized_word:       normaliseKey(e.normalized_word || e.word || ""),
    phonetic_version:      e.phonetic_version || "",
    phonetic_tts:          (e.phonetic_version || "").replace(/-/g, ""),
    language_type:         e.language_type || "Hindi",
    category:              e.category || "general",
    replace_with_if_needed: e.replace_with_if_needed || "",
    tts_risk_score:        e.tts_risk_score || "medium",
    source:                "admin",
    created_at:            e.created_at || now,
    updated_at:            now,
  })).filter(e => e.normalized_word);
  saveAdminEntries(cleaned);
  reloadAll();
  return cleaned.length;
}

module.exports = {
  loadPronunciationBank,
  reloadAll,
  getPronunciation,
  getReplacement,
  isHindiOrHinglish,
  getRiskScore,
  getBankPatterns,
  getBankStats,
  addFailedWord,
  getFailedWords,
  // Admin CRUD
  getAdminEntries,
  upsertAdminEntry,
  deleteAdminEntry,
  importAdminEntries,
  ADMIN_PATH,
  MASTER_PATH,
};
