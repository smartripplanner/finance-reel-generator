"use strict";

/**
 * services/pronunciationEngine.js
 *
 * Multi-layer TTS preprocessing pipeline for Hindi/Hinglish finance reels.
 * Integrates the pronunciation master bank (288 entries, 8 part files merged)
 * for comprehensive, scalable coverage — no individual word hardcoding.
 *
 * ── Pipeline order (applied sequentially) ─────────────────────────────────────
 *
 *  0. Failed-word corrections  (tts_failed_words.json — highest priority)
 *  1. User overrides           (pronunciation-overrides.json — learned corrections)
 *  A. Spelling normalisation   (canonical forms: faida→fayda, nhi→nahi, etc.)
 *  B. Bank phrase-level HIGH   (replace dangerous phrases with safe English)
 *  C. Context fixes            (English homophones: log→loag, use→usse, hal→haal)
 *  D. Smart substitutions      (Hindi→English where TTS consistently fails)
 *  E. Bank phrase MEDIUM/Hindi (phonetic hint for medium-risk Hindi phrases)
 *  F. Bank single-word HIGH    (English replacement for remaining high-risk words)
 *  G. Bank single-word MEDIUM  (phonetic hint for medium-risk Hindi single words)
 *  H. Abbreviation expansion   (SIP/FD/EMI → spoken form)
 *  I. Number normalisation     (₹/digits → spoken Indian form)
 *  J. Phonetic rewrite         (hardcoded fine-tuning: vowel length, consonant quality)
 *  K. QA scan                  (warn if risky words survived)
 *
 * ── How to fix a pronunciation ────────────────────────────────────────────────
 *  • Quick fix (no restart): edit pronunciation-overrides.json
 *    [{ "original": "bad_word", "phonetic": "good_form" }, ...]
 *
 *  • Permanent learning: call pronunciationBankLoader.addFailedWord(original, correction)
 *    Stored in data/tts_failed_words.json, loaded at startup as top-priority.
 *
 *  • Add bulk words: create a new part file in /data, run:
 *    node tools/mergePronunciationBank.js
 *    Then restart the server to reload.
 *
 * ── Adding a new pronunciation bank ──────────────────────────────────────────
 *  1. Create data/hindi_hinglish_pronunciation_bank_v1_part9.json  (same schema)
 *  2. node tools/mergePronunciationBank.js
 *  3. Restart — bank auto-reloads
 */

const fs   = require("fs");
const path = require("path");

const bank = require("./pronunciationBankLoader");

// ── Voice profiles ─────────────────────────────────────────────────────────────
// Maps ElevenLabs voice IDs → processing mode.
// "balanced"      — Hinglish with phonetic vowel hints (default)
// "english_heavy" — prefer English substitutions more aggressively
const VOICE_PROFILES = {
  default:                 { mode: "balanced"      },
  "21m00Tcm4TlvDq8ikWAM": { mode: "balanced"      },  // Rachel
  "EXAVITQu4vr4xnSDxMaL": { mode: "balanced"      },  // Bella
  "yoZ06aMxZJJ28mfd3POQ": { mode: "english_heavy" },  // Sam
};

function getVoiceProfile(voiceId) {
  return VOICE_PROFILES[voiceId] || VOICE_PROFILES.default;
}

// ── Overrides — continuous learning ───────────────────────────────────────────
const OVERRIDES_PATH = path.join(__dirname, "..", "pronunciation-overrides.json");
let USER_OVERRIDES   = [];

function loadOverrides() {
  try {
    if (!fs.existsSync(OVERRIDES_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
    USER_OVERRIDES = Array.isArray(raw) ? raw.filter(o => o.original && o.phonetic) : [];
    if (USER_OVERRIDES.length)
      console.log(`[PronunciationEngine] ${USER_OVERRIDES.length} user override(s) loaded.`);
  } catch (e) {
    console.warn("[PronunciationEngine] Could not load overrides:", e.message);
  }
}
loadOverrides();

function addOverride(original, phonetic) {
  if (!original || !phonetic) return false;
  USER_OVERRIDES = USER_OVERRIDES.filter(o => o.original !== original);
  USER_OVERRIDES.push({ original, phonetic });
  try {
    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(USER_OVERRIDES, null, 2), "utf8");
    console.log(`[PronunciationEngine] Override saved: "${original}" → "${phonetic}"`);
    return true;
  } catch (e) {
    console.warn("[PronunciationEngine] Could not persist override:", e.message);
    return false;
  }
}

// ── Layer A: Spelling normalisation ───────────────────────────────────────────
// Canonical forms — run FIRST so all later layers see consistent spellings.
const NORMALIZE_MAP = [
  [/\bfaida\b/gi,    "fayda"],   [/\bfaayda\b/gi,  "fayda"],
  [/\bmahina\b/gi,   "mahine"],  [/\bmaheena\b/gi, "mahine"],
  [/\bmhina\b/gi,    "mahine"],  [/\bmahino\b/gi,  "mahine"],
  [/\bnuksan\b/gi,   "nuksaan"], [/\bnuqsaan\b/gi, "nuksaan"],
  [/\bfir\b/gi,      "phir"],
  [/\bkyu\b/gi,      "kyun"],
  [/\bnah(?!\w)/gi,  "nahi"],    [/\bnhi\b/gi,     "nahi"],
  [/\bbhe\b/gi,      "bhi"],
  [/\bmai(?!\w)/gi,  "main"],
  [/\bkrta\b/gi,     "karta"],   [/\bkrti\b/gi,    "karti"],
  [/\bkrte\b/gi,     "karte"],   [/\bkrna\b/gi,    "karna"],
  [/\budhari\b/gi,   "udhaari"],
  [/\bjama\b/gi,     "jamaa"],   // "jama" (collect) — often clipped to "jma"
  [/\bsabse\b/gi,    "subse"],
  [/\bthoda\b/gi,    "thoda"],   [/\bthodi\b/gi,   "thodi"],
];

// ── Layer C: Context fixes — English homophones ───────────────────────────────
// These look like English but are ALWAYS the Hindi word in finance reels.
const ALWAYS_HINDI = [
  [/\blog\b/gi,  "loag"],   // लोग (people) — never English "log"
  [/\buse\b/g,   "usse"],   // उसे (him/it) when used as pronoun
  [/\bhal\b/gi,  "haal"],   // हाल (situation) — not English "hal"
];

// ── Layer D: Smart substitutions — Hindi → English for TTS-safe equivalents ──
// These Hindi words consistently sound wrong in TTS; English equivalents are
// universally understood in Indian finance Hinglish and pronounced perfectly.
const SMART_SUBSTITUTIONS = [
  [/\bnuksaan\b/gi,         "loss"],
  [/\blaabh\b/gi,           "profit"],
  [/\bmehengai\b/gi,        "inflation"],
  [/\bdhan\b/gi,            "money"],
  [/\bsampadaa?\b/gi,       "wealth"],
  [/\bbachat\b/gi,          "savings"],
  [/\bkarz\b/gi,            "debt"],
  [/\blakshya\b/gi,         "goal"],
  [/\bvyarth\b/gi,          "waste"],
  [/\baamdani\b/gi,         "income"],
  [/\bprakar\b/gi,          "tarah"],
  [/\bkharach\s+karna\b/gi, "spend karna"],
  [/\bbachana\b/gi,         "save karna"],
  [/\budhaari\b/gi,         "loan"],     // normalised form of udhari
  [/\bmunafa\b/gi,          "profit"],
  [/\bnivesh\b/gi,          "investment"],
  [/\bkamai\b/gi,           "earnings"],
  [/\bgareeb\b/gi,          "poor"],
  [/\bameer\b/gi,           "rich"],
];

// ── Layer H: Abbreviation expander ────────────────────────────────────────────
// NOTE on letter "I": the English letter I sounds like "eye" — NOT "aa ee"
// "aa ee" is the Hindi diphthong 'ai' (as in "aisa"). Using it for the letter
// I caused SIP/EMI/ROI to be mispronounced as "yeessssaaa ip" etc.
//
// NOTE on flags: ALL patterns use /gi (case-insensitive) so "Fd", "fd", "FD"
// are all caught. Without /i, AI-generated lowercase variants silently skip
// expansion and land on TTS as raw letters → "Fdeeee", "eMi" etc.
const ABBREVIATIONS = [
  [/\bSIP\b/gi,   "ess eye pee"],       // S-I-P
  [/\bFD\b/gi,    "ef dee"],            // F-D  (/i catches Fd, fd)
  [/\bEMI\b/gi,   "ee em eye"],         // E-M-I
  [/\bGST\b/gi,   "jee es tee"],        // G-S-T
  [/\bPPF\b/gi,   "pee pee ef"],        // P-P-F
  [/\bNPS\b/gi,   "en pee es"],         // N-P-S
  [/\bELSS\b/gi,  "ee el es es"],       // E-L-S-S
  [/\bRD\b/gi,    "aar dee"],           // R-D
  [/\bROI\b/gi,   "aar o eye"],         // R-O-I
  [/\bXIRR\b/gi,  "ex eye aar aar"],    // X-I-R-R
  [/\bNFO\b/gi,   "en ef o"],           // N-F-O
  [/\bMF\b/gi,    "em ef"],             // Mutual Fund
  [/\bNSE\b/gi,   "en es ee"],          // N-S-E
  [/\bBSE\b/gi,   "bee es ee"],         // B-S-E
  [/\bPAN\b/gi,   "pee ay en"],         // P-A-N
  [/\bKYC\b/gi,   "kay why see"],       // K-Y-C
];

// ── Layer I: Number normalisation ─────────────────────────────────────────────
const NUM_WORDS = {
  0:"zero", 1:"ek", 2:"do", 3:"teen", 4:"chaar", 5:"paanch",
  6:"chheh", 7:"saat", 8:"aath", 9:"nau", 10:"das",
  11:"gyarah", 12:"barah", 13:"terah", 14:"chaudah", 15:"pandrah",
  16:"solah", 17:"satrah", 18:"atharah", 19:"unnis", 20:"bees",
  25:"pachchees", 30:"tees", 40:"chaalis", 50:"pachaas",
  60:"saath", 70:"sattar", 80:"assi", 90:"nabbe", 100:"sau",
};

function numToWord(n) { return NUM_WORDS[parseInt(n, 10)] || String(n); }

function normalizeNumbers(text) {
  return String(text || "")
    .replace(/₹\s*(\d[\d,]*(?:\.\d+)?)\s*(lakh|crore|k|L|Cr)?/gi, (_, amt, sfx) => {
      const num = parseFloat(String(amt).replace(/,/g, ""));
      if (sfx) {
        const sfxW = { lakh:"laakh", crore:"karod", k:"hazaar", L:"laakh", Cr:"karod" }[sfx] || sfx;
        return `${num} ${sfxW} rupaye`;
      }
      if (num >= 10000000) return `${+(num/10000000).toFixed(1)} karod rupaye`;
      if (num >= 100000)   return `${+(num/100000).toFixed(1)} laakh rupaye`;
      if (num >= 1000)     return `${Math.round(num/1000)} hazaar rupaye`;
      return `${num} rupaye`;
    })
    .replace(/₹/g, "rupaye ")
    .replace(/\b(\d+)\s*%/g,     (_, n) => `${numToWord(n)} percent`)
    .replace(/\b(\d+)\s+lakh\b/gi,   (_, n) => `${numToWord(n)} laakh`)
    .replace(/\b(\d+)\s+crore\b/gi,  (_, n) => `${numToWord(n)} karod`)
    .replace(/\b(\d+)\s+saal\b/gi,   (_, n) => `${numToWord(n)} saal`)
    .replace(/\b(\d+)\s+mahine\b/gi, (_, n) => `${numToWord(n)} maheene`)
    .replace(/\b(\d+)\s+month\b/gi,  (_, n) => `${numToWord(n)} month`);
}

// ── Layer J: Phonetic rewrite ─────────────────────────────────────────────────
// Fine-grained fixes for words that survive all previous layers.
// Covers vowel length, schwa deletion, and consonant quality for ElevenLabs.
const PHONETIC_MAP = [
  // Vowel length
  [/\bfayda\b/gi,          "faayda"],
  [/\bnuksaan\b/gi,        "nuksaan"],
  [/\bhazar\b/gi,          "hazaar"],
  [/\blakh\b/gi,           "laakh"],
  [/\bkrore\b/gi,          "karod"],
  [/\bsach\b/gi,           "saach"],
  [/\broz\b/gi,            "roaz"],
  [/\btarika\b/gi,         "taareka"],
  [/\bhamesha\b/gi,        "hamesha"],
  [/\bzindagi\b/gi,        "zindagee"],
  [/\bwarna\b/gi,          "warnaa"],
  [/\baaj\b/gi,            "aaj"],
  [/\bkaash\b/gi,          "kaash"],
  [/\bkyun\b/gi,           "kyoon"],
  [/\bnahi\b/gi,           "nahin"],
  [/\bphir\b/gi,           "phir"],
  [/\bwaqt\b/gi,           "waqt"],
  // Schwa deletion prevention
  [/\bnikaal\b/gi,         "nikaal"],
  [/\bnikal\b/gi,          "nikal"],
  [/\bsamajh\b/gi,         "samajh"],
  [/\bsikhna\b/gi,         "seekhna"],
  [/\bsikho\b/gi,          "seekho"],
  [/\bsikha\b/gi,          "seekha"],
  // Consonant quality
  [/\bchota\b/gi,          "chhota"],
  [/\bchoti\b/gi,          "chhoti"],
  [/\bchotta\b/gi,         "chhota"],
  [/\bchotti\b/gi,         "chhoti"],
  [/\bbhool\b/gi,          "bhool"],
  [/\bbhul\b/gi,           "bhool"],
  // Time words
  [/\bmahine\b/gi,         "maheene"],
  [/\bsaal\b/gi,           "saal"],
  [/\bbaad\b/gi,           "baad"],
  [/\baane\b/gi,           "aane"],
  // Money
  [/\bpaisa\b/gi,          "paisa"],
  [/\bpaise\b/gi,          "paise"],
  [/\bkharcha\b/gi,        "kharchaa"],
  [/\bkharche\b/gi,        "kharche"],
  // Common verbs
  [/\blagta\b/gi,          "lagta"],
  [/\blagti\b/gi,          "lagti"],
  [/\bdikhta\b/gi,         "dikhta"],
  [/\bsoch\b/gi,           "soch"],
  [/\bsaath\b/gi,          "saath"],
  // Hindi listener words — standalone forms get vowel-stretched by TTS
  // after surrounding English text shifts the model to English mode.
  // Short phonetic anchors prevent stretching.
  [/\bsuno\b/gi,           "sunno"],   // su-no → "sunno" (double n blocks stretch)
  [/\bsuno\s+dhyan/gi,     "sunno dhyaan"],
  [/\bdekho\b/gi,          "daykho"],
  [/\bsamjho\b/gi,         "sumjho"],
  [/\bsikho\b/gi,          "seekho"],
  [/\bbatao\b/gi,          "butaao"],
  [/\bbachao\b/gi,         "buchao"],
  // CTA normalisation (belt-and-suspenders)
  [/\bfollow\s+karlungi?\b/gi,     "follow karo"],
  [/\bfollow\s+kar\s+lu[no]gi?\b/gi, "follow karo"],
  [/\bfollow\s+kar\s+lo\b/gi,      "follow karo"],
  [/\bfollow\s+karna\b/gi,         "follow karo"],
  [/\bfollow\s+kar\s+lena\b/gi,    "follow karo"],
  // Feminine voice (belt-and-suspenders — prompt already enforces these)
  [/\bkarunga\b/gi,    "karungi"],  [/\bkahunga\b/gi,   "kahungi"],
  [/\bbolunga\b/gi,    "bolungi"],  [/\bdunga\b/gi,     "dungi"],
  [/\blunga\b/gi,      "lungi"],    [/\baaunga\b/gi,    "aaungi"],
  [/\bjaunga\b/gi,     "jaungi"],   [/\bsochunga\b/gi,  "sochungi"],
  [/\blikhunga\b/gi,   "likhungi"], [/\bpadhunga\b/gi,  "padhungi"],
  [/\bbanaunga\b/gi,   "banaungi"],
  [/\bmain\s+(\w+)\s+raha\s+hoon\b/gi, "main $1 rahi hoon"],
  [/\bmain\s+(\w+)\s+raha\s+hu\b/gi,   "main $1 rahi hu"],
];

// ── Layer K: Final QA scan ────────────────────────────────────────────────────
const QA_PATTERNS = [
  [/\blog\b/gi,     "log (should be loag)"],
  [/\bvyarth\b/gi,  "vyarth (should be waste)"],
  [/\bdhan\b/gi,    "dhan (should be money)"],
  [/\blaabh\b/gi,   "laabh (should be profit)"],
  [/\bnuksaan\b/gi, "nuksaan (should be loss)"],
  [/\bnivesh\b/gi,  "nivesh (should be investment)"],
  [/\bkamai\b/gi,   "kamai (should be earnings)"],
];

function runQA(text) {
  for (const [pattern, label] of QA_PATTERNS) {
    if (pattern.test(text)) console.warn(`[PronunciationEngine QA] Risky word survived: ${label}`);
    pattern.lastIndex = 0;
  }
}

// ── Regex application helper with stats tracking ──────────────────────────────
function applyMap(text, mapArray, stats, bucket) {
  return mapArray.reduce((t, [pattern, replacement]) => {
    // Reset lastIndex for global regexes
    if (pattern.global) pattern.lastIndex = 0;
    const before = t;
    const after  = t.replace(pattern, replacement);
    if (after !== before) stats[bucket] = (stats[bucket] || 0) + 1;
    return after;
  }, text);
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
function process(rawText, voiceId) {
  const profile = getVoiceProfile(voiceId || "default");
  let s = String(rawText || "");

  const stats = {
    inputWords:     s.trim().split(/\s+/).filter(Boolean).length,
    overrides:      0,
    failedWords:    0,
    phraseHighSubs: 0,
    contextFixes:   0,
    smartSubs:      0,
    bankPhraseMed:  0,
    bankWordHigh:   0,
    bankWordMed:    0,
    phonetics:      0,
  };

  // ── 0. Failed-word corrections (highest priority — manually verified) ────────
  const failedWords = bank.getFailedWords();
  for (const { original, correction } of failedWords) {
    try {
      const before = s;
      s = s.replace(new RegExp(`\\b${original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), correction);
      if (s !== before) stats.failedWords++;
    } catch (_) {}
  }

  // ── 1. User overrides (pronunciation-overrides.json) ────────────────────────
  for (const { original, phonetic } of USER_OVERRIDES) {
    try {
      const before = s;
      s = s.replace(new RegExp(`\\b${original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), phonetic);
      if (s !== before) stats.overrides++;
    } catch (_) {}
  }

  // ── A. Normalise spelling variants → canonical forms ────────────────────────
  s = NORMALIZE_MAP.reduce((t, [p, r]) => { if (p.global) p.lastIndex = 0; return t.replace(p, r); }, s);

  // ── B. Bank phrase-level HIGH risk → English replacement ────────────────────
  // (longest phrases first — already sorted in bank)
  const { phraseHighSubs, phraseMediumPhon, wordHighSubs, wordMediumPhon } = bank.getBankPatterns();
  s = applyMap(s, phraseHighSubs, stats, "phraseHighSubs");

  // ── C. Context fixes — English homophones ───────────────────────────────────
  s = applyMap(s, ALWAYS_HINDI, stats, "contextFixes");

  // ── D. Smart substitutions (hardcoded — Hindi → English for TTS failures) ───
  if (profile.mode !== "desi") {
    s = applyMap(s, SMART_SUBSTITUTIONS, stats, "smartSubs");
  }

  // ── E. Bank phrase-level MEDIUM Hindi → phonetic hints ──────────────────────
  s = applyMap(s, phraseMediumPhon, stats, "bankPhraseMed");

  // ── F. Bank single-word HIGH risk → English replacement ─────────────────────
  s = applyMap(s, wordHighSubs, stats, "bankWordHigh");

  // ── G. Bank single-word MEDIUM Hindi → phonetic hint ────────────────────────
  s = applyMap(s, wordMediumPhon, stats, "bankWordMed");

  // ── H. Abbreviation expansion ────────────────────────────────────────────────
  s = ABBREVIATIONS.reduce((t, [p, r]) => { if (p.global) p.lastIndex = 0; return t.replace(p, r); }, s);

  // ── I. Number normalisation ──────────────────────────────────────────────────
  s = normalizeNumbers(s);

  // ── J. Phonetic rewrite (fine-grained hardcoded tuning) ─────────────────────
  s = applyMap(s, PHONETIC_MAP, stats, "phonetics");

  // ── K. QA scan ───────────────────────────────────────────────────────────────
  runQA(s);

  // ── Logging ──────────────────────────────────────────────────────────────────
  const totalMatched =
    stats.overrides + stats.failedWords + stats.phraseHighSubs +
    stats.contextFixes + stats.smartSubs + stats.bankPhraseMed +
    stats.bankWordHigh + stats.bankWordMed + stats.phonetics;

  if (totalMatched > 0) {
    console.log(
      `[PronunciationEngine] ${stats.inputWords} words →` +
      ` matched ${totalMatched}` +
      ` (phraseHigh:${stats.phraseHighSubs}` +
      ` contextFix:${stats.contextFixes}` +
      ` smartSub:${stats.smartSubs}` +
      ` bankWordHigh:${stats.bankWordHigh}` +
      ` phonetics:${stats.phonetics}` +
      (stats.overrides   ? ` userOverride:${stats.overrides}`   : "") +
      (stats.failedWords ? ` failedWordFix:${stats.failedWords}` : "") +
      ")"
    );
  }

  return s.replace(/\s+/g, " ").trim();
}

module.exports = {
  process,
  addOverride,
  getVoiceProfile,
  loadOverrides,
  NUM_WORDS,
};
