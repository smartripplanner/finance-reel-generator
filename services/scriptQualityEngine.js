"use strict";

/**
 * services/scriptQualityEngine.js
 *
 * Validates, scores, and auto-fixes generated Hinglish scenes BEFORE TTS.
 *
 * Pipeline (called from routes/generate.js after language balancer):
 *   validateAndFixScript(scenes) → { scenes, report }
 *
 * What it catches:
 *   - Broken tense mixing:    "risk manage ho goes hai", "kar raha was"
 *   - Past tense duplication: "did kiya", "grew hua", "huaed"
 *   - Copula duplication:     "hota is", "hain are", "tha was"
 *   - Meaning duplication:    "every day aaj", "silently chupke", "sabse best"
 *   - Plural-singular mismatch: "people karta hai" → "people karte hain"
 *   - Trailing word fragments: "...every day. aaj" from sentence joins
 *
 * Scoring (1–10 per scene, averaged for overall):
 *   Start at 10, deduct for each issue found, bonus for natural patterns.
 *   If overall < 8 → caller should trigger LLM humanization pass.
 */

const { analyzeLanguageRatio } = require("./languageBalancer");

// ─────────────────────────────────────────────────────────────────────────────
// GRAMMAR AUTO-FIX RULES
// Applied in order — each rule is [regex, replacement]
// ─────────────────────────────────────────────────────────────────────────────
const GRAMMAR_FIXES = [
  // ── Broken "ho goes hai" family ────────────────────────────────────────────
  [/\bmanage\s+ho\s+goes?\s+hain?\b/gi,   "manage ho jaata hai"],
  [/\bcontrol\s+ho\s+goes?\s+hain?\b/gi,  "control ho jaata hai"],
  [/\bho\s+goes?\s+hain\b/gi,             "ho jaate hain"],
  [/\bho\s+goes?\s+hai\b/gi,              "ho jaata hai"],
  [/\bho\s+went\s+hain?\b/gi,             "ho gaya"],

  // ── English verb + "hai/hain" (never valid Hinglish) ──────────────────────
  [/\bgrows?\s+hain\b/gi,                 "grow hote hain"],
  [/\bgrows?\s+hai\b/gi,                  "grow hota hai"],
  [/\bincreases?\s+hain?\b/gi,            "increase hota hai"],
  [/\bworks?\s+hain\b/gi,                 "kaam karte hain"],
  [/\bworks?\s+hai\b/gi,                  "kaam karta hai"],
  [/\bhappens?\s+hain\b/gi,               "hote hain"],
  [/\bhappens?\s+hai\b/gi,                "hota hai"],
  [/\bloses?\s+hain?\b/gi,                "lose hota hai"],
  [/\bgoes?\s+hain\b/gi,                  "jaate hain"],
  [/\bgoes?\s+hai\b/gi,                   "jaata hai"],
  [/\bcomes?\s+hain\b/gi,                 "aate hain"],
  [/\bcomes?\s+hai\b/gi,                  "aata hai"],
  [/\bbuilds?\s+hai\b/gi,                 "build hota hai"],
  [/\bcreates?\s+hai\b/gi,                "create hota hai"],

  // ── Past tense duplication ─────────────────────────────────────────────────
  [/\bdid\s+kiya\b/gi,                    "kiya"],
  [/\bkiya\s+did\b/gi,                    "kiya"],
  [/\bgrew\s+hua\b/gi,                    "badh gaya"],
  [/\bgrow\s+huaa?\b/gi,                  "badh gaya"],
  [/\binvested?\s+kiya\b/gi,              "invest kiya"],
  [/\bstarted?\s+kiya\b/gi,               "start kiya"],
  [/\bhuaed\b/gi,                         "hua"],
  [/\b(\w+)ed\s+hua\b/gi, (_, v) => {
    // "invested hua" → "invest hua", "failed hua" → "fail hua"
    return `${v.replace(/ed$/, "")} hua`;
  }],

  // ── Wrong continuous tense ─────────────────────────────────────────────────
  [/\bkar\s+raha\s+was\b/gi,              "kar raha tha"],
  [/\bkar\s+rahi\s+was\b/gi,              "kar rahi thi"],
  [/\bkar\s+rahe\s+were\b/gi,             "kar rahe the"],
  [/\bkarte\s+were\b/gi,                  "karte the"],
  [/\bkarta\s+were\b/gi,                  "karta tha"],
  [/\bkarti\s+were\b/gi,                  "karti thi"],
  [/\brehte\s+were\b/gi,                  "rehte the"],

  // ── Copula duplication ────────────────────────────────────────────────────
  [/\bhota\s+is\b/gi,                     "hota hai"],
  [/\bhoti\s+is\b/gi,                     "hoti hai"],
  [/\bhote\s+are\b/gi,                    "hote hain"],
  [/\bhain\s+are\b/gi,                    "hain"],
  [/\bare\s+hain\b/gi,                    "hain"],
  [/\bhai\s+is\b/gi,                      "hai"],
  [/\bis\s+hai\b/gi,                      "hai"],
  [/\btha\s+was\b/gi,                     "tha"],
  [/\bwas\s+tha\b/gi,                     "tha"],
  [/\bthe\s+were\b/gi,                    "the"],
  [/\bwere\s+the\b/gi,                    "the"],

  // ── Double superlatives ───────────────────────────────────────────────────
  [/\bsabse\s+best\b/gi,                  "best"],
  [/\bbest\s+sabse\s+best\b/gi,           "best"],
  [/\bmost\s+sabse\b/gi,                  "most"],
  [/\bsabse\s+zyada\s+most\b/gi,          "most"],
  [/\bsabse\s+worst\b/gi,                 "worst"],

  // ── Broken conditional "kiya to X hai" ───────────────────────────────────
  [/\binvest\s+kiya\s+to\s+(\w+)s\s+hai\b/gi, "invest karo toh $1 hoga"],
  [/\bkiya\s+to\s+(\w+)s?\s+hain?\b/gi,   "karo toh $1 hoga"],

  // ── Plural-singular agreement ─────────────────────────────────────────────
  [/\bpeople\s+karta\s+hai\b/gi,          "people karte hain"],
  [/\bpeople\s+karti\s+hai\b/gi,          "people karte hain"],
  [/\bsab\s+karta\s+hai\b/gi,             "sab karte hain"],
  [/\bsab\s+karti\s+hai\b/gi,             "sab karte hain"],
  [/\blog\s+karta\s+hai\b/gi,             "log karte hain"],
  [/\blog\s+karti\s+hai\b/gi,             "log karte hain"],
  [/\bsabhi\s+karta\s+hai\b/gi,           "sabhi karte hain"],
  [/\bhum\s+karta\s+hai\b/gi,             "hum karte hain"],
  [/\btum\s+karta\s+hai\b/gi,             "tum karte ho"],
  [/\baap\s+karta\s+hai\b/gi,             "aap karte hain"],

  // ── Trailing fragment left after sentence join ────────────────────────────
  // "...every day. aaj" → "...every day."
  [/([.!?])\s+aaj\s*$/gi,                 "$1"],
  [/([.!?])\s+abhi\s*$/gi,                "$1"],
  // "...value. aaj?" → "...value."
  [/\.\s+(aaj|abhi|phir)\s*[?!]?\s*$/gi,  "."],

  // ── Cleanup: double spaces introduced by any replacement ──────────────────
  [/  +/g,                                " "],
  [/\s+([.!?,])/g,                        "$1"],
];

// ─────────────────────────────────────────────────────────────────────────────
// MEANING DUPLICATION RULES
// Each entry: { desc, pattern, replacement }
// ─────────────────────────────────────────────────────────────────────────────
const MEANING_DEDUP_RULES = [
  // every day / daily + aaj
  { desc: "every day + aaj",     pattern: /\bevery\s*[- ]?day[,]?\s+aaj\b/gi,     fix: "every day" },
  { desc: "aaj + every day",     pattern: /\baaj\s+every\s*[- ]?day\b/gi,          fix: "every day" },
  { desc: "daily + aaj",         pattern: /\bdaily[,]?\s+aaj\b/gi,                 fix: "daily" },
  { desc: "aaj + daily",         pattern: /\baaj\s+daily\b/gi,                     fix: "daily" },
  // today / aaj
  { desc: "today + aaj",         pattern: /\btoday[,]?\s+aaj\b/gi,                 fix: "today" },
  { desc: "aaj + today",         pattern: /\baaj\s+today\b/gi,                     fix: "aaj" },
  // silently / chupke / quietly
  { desc: "silently + chupke",   pattern: /\bsilent(?:ly)?\s+chupke\b/gi,          fix: "silently" },
  { desc: "chupke + silently",   pattern: /\bchupke\s+silent(?:ly)?\b/gi,          fix: "chupke" },
  { desc: "quietly + chupke",    pattern: /\bquietly\s+chupke\b/gi,                fix: "quietly" },
  { desc: "chupke + quietly",    pattern: /\bchupke\s+quietly\b/gi,                fix: "chupke" },
  // now / abhi
  { desc: "now + abhi",          pattern: /\bnow[,]?\s+abhi\b/gi,                  fix: "abhi" },
  { desc: "abhi + now",          pattern: /\babhi\s+now\b/gi,                      fix: "abhi" },
  // always / hamesha
  { desc: "always + hamesha",    pattern: /\balways\s+hamesha\b/gi,                fix: "always" },
  { desc: "hamesha + always",    pattern: /\bhamesha\s+always\b/gi,                fix: "hamesha" },
  // mistake / galti
  { desc: "mistake + galti",     pattern: /\bmistake\s+galti\b/gi,                 fix: "mistake" },
  { desc: "galti + mistake",     pattern: /\bgalti\s+mistake\b/gi,                 fix: "galti" },
  // money / paisa (immediate adjacency only)
  { desc: "money + paisa",       pattern: /\bmoney\s+paisa\b/gi,                   fix: "paisa" },
  { desc: "paisa + money",       pattern: /\bpaisa\s+money\b/gi,                   fix: "paisa" },
  // loss / nuksan
  { desc: "loss + nuksan",       pattern: /\bloss\s+nuksaan?\b/gi,                 fix: "loss" },
  { desc: "nuksan + loss",       pattern: /\bnuksaan?\s+loss\b/gi,                 fix: "nuksan" },
  // save / bachao (different verb forms handled by language balancer)
  { desc: "save + bachao",       pattern: /\bsave\s+bachao\b/gi,                   fix: "save" },
  { desc: "bachao + save",       pattern: /\bbachao\s+save\b/gi,                   fix: "bachao" },
  // understand / samjho
  { desc: "understand + samjho", pattern: /\bunderstand\s+samjho\b/gi,             fix: "understand" },
  { desc: "samjho + understand", pattern: /\bsamjho\s+understand\b/gi,             fix: "samjho" },
  // listen / suno
  { desc: "listen + suno",       pattern: /\blisten\s+suno\b/gi,                   fix: "listen" },
  { desc: "suno + listen",       pattern: /\bsuno\s+listen\b/gi,                   fix: "suno" },
  // daily / har din
  { desc: "daily + har din",     pattern: /\bdaily\s+har\s+din\b/gi,               fix: "daily" },
  { desc: "har din + daily",     pattern: /\bhar\s+din\s+daily\b/gi,               fix: "har din" },
  // future / bhavishya
  { desc: "future + bhavishya",  pattern: /\bfuture\s+bha?vishya\b/gi,             fix: "future" },
  { desc: "bhavishya + future",  pattern: /\bbha?vishya\s+future\b/gi,             fix: "future" },
  // best sabse best (triple)
  { desc: "best sabse best",     pattern: /\bbest\s+sabse\s+best\b/gi,             fix: "best" },
  // free muft
  { desc: "free + muft",         pattern: /\bfree\s+muft\b/gi,                     fix: "free" },
  { desc: "muft + free",         pattern: /\bmuft\s+free\b/gi,                     fix: "free" },
  // start shuru
  { desc: "start + shuru",       pattern: /\bstart\s+shuru\b/gi,                   fix: "start" },
  { desc: "shuru + start",       pattern: /\bshuru\s+start\b/gi,                   fix: "shuru" },
  // right sahi
  { desc: "right + sahi",        pattern: /\bright\s+sahi\b/gi,                    fix: "right" },
  { desc: "sahi + right",        pattern: /\bsahi\s+right\b/gi,                    fix: "sahi" },
  // wrong galat
  { desc: "wrong + galat",       pattern: /\bwrong\s+galat\b/gi,                   fix: "wrong" },
  { desc: "galat + wrong",       pattern: /\bgalat\s+wrong\b/gi,                   fix: "galat" },
];

// ─────────────────────────────────────────────────────────────────────────────
// FORBIDDEN PATTERNS — for detection and scoring (not all auto-fixable)
// ─────────────────────────────────────────────────────────────────────────────
const FORBIDDEN_PATTERNS = [
  { pattern: /\bho\s+goes?\s+hain?\b/gi,       desc: "ho goes hai (broken tense)",     severity: 2.0 },
  { pattern: /\bgrows?\s+hain?\b/gi,            desc: "grows hai (English verb+copula)", severity: 1.5 },
  { pattern: /\bworks?\s+hain?\b/gi,            desc: "works hai (English verb+copula)", severity: 1.5 },
  { pattern: /\bhappens?\s+hain?\b/gi,          desc: "happens hai",                    severity: 1.5 },
  { pattern: /\bkiya\s+to\s+\w+s\s+hain?\b/gi, desc: "kiya to Xs hai (broken cond.)",  severity: 2.0 },
  { pattern: /\bdid\s+kiya\b/gi,                desc: "double past: did kiya",          severity: 1.5 },
  { pattern: /\bgrow\s+huaa?\b/gi,              desc: "tense duplication: grow hua",    severity: 1.5 },
  { pattern: /\bhuaed\b/gi,                     desc: "huaed (impossible hybrid)",      severity: 2.0 },
  { pattern: /\bkar\s+raha\s+was\b/gi,          desc: "kar raha was (wrong tense)",     severity: 1.5 },
  { pattern: /\bevery\s*[- ]?day\s+aaj\b/gi,   desc: "every day aaj (meaning dedup)",  severity: 1.0 },
  { pattern: /\baaj\s+every\s*[- ]?day\b/gi,   desc: "aaj every day (meaning dedup)",  severity: 1.0 },
  { pattern: /\btoday\s+aaj\b/gi,               desc: "today aaj (meaning dedup)",      severity: 1.0 },
  { pattern: /\bsilently?\s+chupke\b/gi,        desc: "silently chupke (meaning dedup)",severity: 1.0 },
  { pattern: /\bchupke\s+silently?\b/gi,        desc: "chupke silently (meaning dedup)",severity: 1.0 },
  { pattern: /\bsabse\s+best\b/gi,              desc: "sabse best (double superlative)", severity: 0.8 },
  { pattern: /\bhota\s+is\b/gi,                 desc: "hota is (copula duplication)",   severity: 1.0 },
  { pattern: /\bhain\s+are\b/gi,                desc: "hain are (copula duplication)",  severity: 1.0 },
  { pattern: /\bhai\s+is\b/gi,                  desc: "hai is (copula duplication)",    severity: 1.0 },
  { pattern: /\btha\s+was\b/gi,                 desc: "tha was (copula duplication)",   severity: 1.0 },
  { pattern: /\bpeople\s+karta\s+hai\b/gi,      desc: "people karta hai (plural mismatch)", severity: 0.8 },
  { pattern: /\bsab\s+karta\s+hai\b/gi,         desc: "sab karta hai (plural mismatch)",    severity: 0.8 },
  { pattern: /\blog\s+karta\s+hai\b/gi,         desc: "log karta hai (plural mismatch)",    severity: 0.8 },
  { pattern: /\bmistake\s+galti\b/gi,           desc: "mistake galti (meaning dedup)",  severity: 1.0 },
  { pattern: /\bmoney\s+paisa\b/gi,             desc: "money paisa (meaning dedup)",    severity: 1.0 },
];

// ─────────────────────────────────────────────────────────────────────────────
// NATURAL HINGLISH BONUS PATTERNS (reward good grammar)
// ─────────────────────────────────────────────────────────────────────────────
const NATURAL_PATTERNS = [
  { pattern: /\b\w+\s+kar\s+sakte\s+hain\b/i,       desc: "X kar sakte hain",     bonus: 0.3 },
  { pattern: /\b\w+\s+ho\s+sakta\s+hai\b/i,         desc: "X ho sakta hai",       bonus: 0.3 },
  { pattern: /\b\w+\s+ho\s+jaata\s+hai\b/i,         desc: "X ho jaata hai",       bonus: 0.3 },
  { pattern: /\b\w+\s+karte\s+hain\b/i,             desc: "X karte hain",         bonus: 0.2 },
  { pattern: /\bphir\s+bhi\b/i,                     desc: "phir bhi",             bonus: 0.2 },
  { pattern: /\bsirf\s+\w+/i,                       desc: "sirf X",               bonus: 0.1 },
  { pattern: /\b(SIP|FD|EMI|XIRR|mutual\s+fund)\b/i, desc: "finance term",       bonus: 0.3 },
  { pattern: /\b(invest|returns?|portfolio|inflation|wealth)\b/i, desc: "finance word", bonus: 0.2 },
  // Clean imperative combos (English noun + Hindi verb) — good Hinglish
  { pattern: /\b(invest|save|start|follow|build)\s+karo\b/i,     desc: "EN+karo",  bonus: 0.3 },
  { pattern: /\b\w+\s+hota\s+hai\b/i,               desc: "X hota hai",           bonus: 0.2 },
];

// ─────────────────────────────────────────────────────────────────────────────
// CORE FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * applyGrammarFixes(text) → { text, changes }
 * Applies all grammar auto-fix rules in order.
 */
function applyGrammarFixes(text) {
  if (!text) return { text: "", changes: [] };

  let result = text;
  const changes = [];

  for (const rule of GRAMMAR_FIXES) {
    const [pattern, replacement] = rule;
    const prev = result;
    if (typeof replacement === "string") {
      result = result.replace(pattern, replacement);
    } else if (typeof replacement === "function") {
      result = result.replace(pattern, replacement);
    }
    if (result !== prev) {
      changes.push({ from: prev, to: result });
    }
  }

  // Final cleanup: trim trailing whitespace
  result = result.trim();

  return { text: result, changes };
}

/**
 * applyMeaningDedup(text) → { text, removals }
 * Removes meaning-duplicated bilingual fragments.
 */
function applyMeaningDedup(text) {
  if (!text) return { text: "", removals: [] };

  let result = text;
  const removals = [];

  for (const rule of MEANING_DEDUP_RULES) {
    const prev = result;
    result = result.replace(rule.pattern, rule.fix);
    if (result !== prev) {
      removals.push(rule.desc);
    }
  }

  // Clean up double spaces after any removal
  result = result.replace(/  +/g, " ").replace(/\s+([.!?,])/g, "$1").trim();

  return { text: result, removals };
}

/**
 * scoreScene(text, purpose) → { score, issues, bonuses, penalties }
 * Score 1–10. Deduct for forbidden patterns, reward for natural Hinglish.
 */
function scoreScene(text, purpose = "content") {
  if (!text || !text.trim()) {
    return { score: 0, issues: ["Empty scene text"], penalties: [], bonuses: [], wordCount: 0 };
  }

  let score = 10.0;
  const penalties = [];
  const bonuses   = [];
  const issues    = [];

  // ── Check forbidden patterns ────────────────────────────────────────────
  for (const { pattern, desc, severity } of FORBIDDEN_PATTERNS) {
    // Reset lastIndex for global patterns
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(text)) {
      score -= severity;
      penalties.push(`-${severity}: ${desc}`);
      issues.push(desc);
    }
  }

  // ── Word count penalties ────────────────────────────────────────────────
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount > 16) {
    score -= 0.5;
    penalties.push(`-0.5: too long (${wordCount} words, max 16)`);
    issues.push(`Scene too long: ${wordCount} words`);
  } else if (wordCount < 3) {
    score -= 1.0;
    penalties.push(`-1.0: too short (${wordCount} words)`);
    issues.push(`Scene too short: ${wordCount} words`);
  }

  // ── Hook scene: must be mostly English ─────────────────────────────────
  if (purpose === "hook") {
    const { hindiPct } = analyzeLanguageRatio(text);
    if (hindiPct > 30) {
      score -= 1.0;
      penalties.push(`-1.0: hook has ${hindiPct}% Hindi (target ≤ 30%)`);
      issues.push(`Hook too much Hindi: ${hindiPct}%`);
    }
    // Hook must end with ? or !
    if (!/[?!]$/.test(text.trim())) {
      score -= 0.3;
      penalties.push("-0.3: hook should end with ? or !");
    }
  }

  // ── Missing end punctuation ─────────────────────────────────────────────
  if (!/[.!?…]$/.test(text.trim())) {
    score -= 0.2;
    penalties.push("-0.2: missing end punctuation");
  }

  // ── Reward natural Hinglish patterns ────────────────────────────────────
  let bonusApplied = false;
  for (const { pattern, desc, bonus } of NATURAL_PATTERNS) {
    if (pattern.test(text)) {
      score += bonus;
      bonuses.push(`+${bonus}: ${desc}`);
      bonusApplied = true;
      if (score >= 10) break;
    }
  }

  // Max cap at 10
  score = Math.max(0, Math.min(10, score));

  return {
    score:    Math.round(score * 10) / 10,
    issues,
    penalties,
    bonuses,
    wordCount,
  };
}

/**
 * scoreScript(scenes) → { overallScore, scenes, totalIssues, summary }
 * Average scene scores weighted equally.
 */
function scoreScript(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { overallScore: 0, scenes: [], totalIssues: [], summary: "no scenes" };
  }

  const sceneResults = scenes.map((s, i) => {
    const text    = typeof s === "string" ? s : (s.text || "");
    const purpose = typeof s === "object"
      ? (s.scenePurpose || (i === 0 ? "hook" : i === scenes.length - 1 ? "cta" : "content"))
      : (i === 0 ? "hook" : "content");

    const result = scoreScene(text, purpose);
    return { sceneNum: i + 1, purpose, text, ...result };
  });

  const totalScore  = sceneResults.reduce((s, r) => s + r.score, 0);
  const overallScore = Math.round((totalScore / sceneResults.length) * 10) / 10;
  const totalIssues = sceneResults.flatMap(r => r.issues);

  return {
    overallScore,
    scenes:      sceneResults,
    totalIssues,
    summary: `${overallScore}/10 | issues: ${totalIssues.length} | scenes: ${scenes.length}`,
  };
}

/**
 * fixScene(text, purpose) → { text, grammarChanges, dedupRemovals, score }
 * Full fix pass on a single scene text.
 */
function fixScene(text, purpose = "content") {
  if (!text || !text.trim()) return { text: "", grammarChanges: 0, dedupRemovals: 0, score: 0 };

  const { text: g, changes }    = applyGrammarFixes(text);
  const { text: d, removals }   = applyMeaningDedup(g);
  const { score }               = scoreScene(d, purpose);

  return {
    text:           d,
    grammarChanges: changes.length,
    dedupRemovals:  removals.length,
    score,
  };
}

/**
 * validateAndFixScript(scenes) → { scenes: fixedScenes, report }
 *
 * Main entry point. Applies grammar + meaning fixes to every scene,
 * scores the result, and returns a detailed report.
 */
function validateAndFixScript(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return {
      scenes: scenes || [],
      report: { overallScore: 10, totalGrammarChanges: 0, totalDedupRemovals: 0,
                totalIssuesBefore: 0, summary: "no scenes to validate" },
    };
  }

  // Score BEFORE fix (for the report)
  const beforeScore = scoreScript(scenes);

  let totalGrammarChanges = 0;
  let totalDedupRemovals  = 0;
  const sceneReports      = [];

  const fixedScenes = scenes.map((scene, i) => {
    const purpose = typeof scene === "object"
      ? (scene.scenePurpose || (i === 0 ? "hook" : i === scenes.length - 1 ? "cta" : "content"))
      : (i === 0 ? "hook" : "content");

    if (typeof scene === "string") {
      const { text, grammarChanges, dedupRemovals, score } = fixScene(scene, purpose);
      totalGrammarChanges += grammarChanges;
      totalDedupRemovals  += dedupRemovals;
      sceneReports.push({ scene: i + 1, purpose, grammarChanges, dedupRemovals, score });
      return text;

    } else if (scene && typeof scene === "object") {
      const originalText = scene.text || "";
      const { text, grammarChanges, dedupRemovals, score } = fixScene(originalText, purpose);
      totalGrammarChanges += grammarChanges;
      totalDedupRemovals  += dedupRemovals;
      sceneReports.push({ scene: i + 1, purpose, grammarChanges, dedupRemovals, score,
                          before: originalText, after: text });
      return { ...scene, text };

    } else {
      sceneReports.push({ scene: i + 1, purpose: "unknown", grammarChanges: 0, dedupRemovals: 0, score: 0 });
      return scene;
    }
  });

  // Score AFTER fix
  const afterScore = scoreScript(fixedScenes);

  const report = {
    overallScore:        afterScore.overallScore,
    overallScoreBefore:  beforeScore.overallScore,
    totalGrammarChanges,
    totalDedupRemovals,
    totalIssuesBefore:   beforeScore.totalIssues.length,
    totalIssuesAfter:    afterScore.totalIssues.length,
    scenes:              sceneReports,
    summary: [
      `Score: ${afterScore.overallScore}/10`,
      `(was ${beforeScore.overallScore}/10)`,
      `| Grammar fixed: ${totalGrammarChanges}`,
      `| Dedup removed: ${totalDedupRemovals}`,
      `| Remaining issues: ${afterScore.totalIssues.length}`,
    ].join(" "),
  };

  // Debug log
  if (totalGrammarChanges > 0 || totalDedupRemovals > 0 || afterScore.totalIssues.length > 0) {
    console.log(`[ScriptQuality] ${report.summary}`);
    if (afterScore.totalIssues.length > 0) {
      console.log(`[ScriptQuality] Remaining issues: ${afterScore.totalIssues.slice(0, 5).join(" | ")}`);
    }
  } else {
    console.log(`[ScriptQuality] ✓ Score ${afterScore.overallScore}/10 — no issues found`);
  }

  return { scenes: fixedScenes, report };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIGHT QUALITY CHECK  (used by generate.js — detect only, never patch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * lightQualityCheck(scenes) → { passed, score, reason, issues }
 *
 * Runs 5 fast checks against the generated scenes.
 * Returns passed:true (score >= 8) or false (trigger whole-script regeneration).
 * NEVER modifies any scene text. Detection only.
 *
 * Checks:
 *   1. Broken grammar patterns (critical forbidden — from FORBIDDEN_PATTERNS)
 *   2. Duplicate scene texts
 *   3. Hook scene exists and is non-trivial
 *   4. Scene count within acceptable range
 *   5. No scene text grotesquely over-long (> 25 words)
 */
function lightQualityCheck(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { passed: false, score: 0, reason: "No scenes returned", issues: ["Empty script"] };
  }

  let score = 10;
  const issues = [];

  // Critical forbidden patterns (each hit -2 pts)
  const CRITICAL = [
    { pattern: /\bho\s+goes?\s+hain?\b/i,          desc: "ho goes hai" },
    { pattern: /\bgrows?\s+hain?\b/i,               desc: "grows hai" },
    { pattern: /\bworks?\s+hain?\b/i,               desc: "works hai" },
    { pattern: /\bdid\s+kiya\b/i,                   desc: "did kiya" },
    { pattern: /\bgrow\s+huaa?\b/i,                 desc: "grow hua" },
    { pattern: /\bhuaed\b/i,                        desc: "huaed" },
    { pattern: /\bkar\s+raha\s+was\b/i,             desc: "kar raha was" },
    { pattern: /\bevery\s*[- ]?day\s+aaj\b/i,       desc: "every day aaj" },
    { pattern: /\btoday\s+aaj\b/i,                  desc: "today aaj" },
    { pattern: /\bsilent(?:ly)?\s+chupke\b/i,       desc: "silently chupke" },
    { pattern: /\bchupke\s+silent(?:ly)?\b/i,       desc: "chupke silently" },
    { pattern: /\bhota\s+is\b/i,                    desc: "hota is" },
    { pattern: /\bhain\s+are\b/i,                   desc: "hain are" },
    { pattern: /\btha\s+was\b/i,                    desc: "tha was" },
    { pattern: /\bkiya\s+to\s+\w+s?\s+hain?\b/i,   desc: "kiya to X hai" },
  ];

  const seenTexts = new Set();

  for (const scene of scenes) {
    const text = (typeof scene === "string" ? scene : (scene.text || "")).trim();

    // Check forbidden grammar patterns
    for (const { pattern, desc } of CRITICAL) {
      if (pattern.test(text)) {
        issues.push(`Broken grammar: "${desc}" in "${text.slice(0, 45)}"`);
        score -= 2;
      }
    }

    // Check duplicate texts
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (key.length > 3) {
      if (seenTexts.has(key)) {
        issues.push(`Duplicate scene: "${text.slice(0, 40)}"`);
        score -= 2;
      }
      seenTexts.add(key);
    }

    // Check grotesque length
    const wordCount = text.split(/\s+/).length;
    if (wordCount > 25) {
      issues.push(`Scene too long: ${wordCount} words — "${text.slice(0, 40)}"`);
      score -= 1;
    }
  }

  // Check scene count
  if (scenes.length < 4) {
    issues.push(`Too few scenes: ${scenes.length} (need ≥ 4)`);
    score -= 3;
  }

  // Check hook (scene 1) is meaningful
  const hookText = (typeof scenes[0] === "string" ? scenes[0] : (scenes[0]?.text || "")).trim();
  if (hookText.length < 10) {
    issues.push(`Hook too short: "${hookText}"`);
    score -= 2;
  }

  score = Math.max(0, Math.min(10, score));
  const passed = score >= 8 && issues.length === 0;

  console.log(`[ScriptQuality] light-check: ${score}/10 ${passed ? "✓ PASS" : "✗ FAIL"} | issues: ${issues.length}`);
  if (issues.length > 0) {
    console.log(`[ScriptQuality] issues: ${issues.slice(0, 3).join(" | ")}`);
  }

  return {
    passed,
    score,
    reason: issues.slice(0, 3).join("; ") || "OK",
    issues,
  };
}

module.exports = {
  lightQualityCheck,
  // ── Heavy pipeline (kept for reference, not used in main pipeline) ─────────
  applyGrammarFixes,
  applyMeaningDedup,
  scoreScene,
  scoreScript,
  fixScene,
  validateAndFixScript,
  GRAMMAR_FIXES,
  MEANING_DEDUP_RULES,
  FORBIDDEN_PATTERNS,
};
