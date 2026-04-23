"use strict";

const axios  = require("axios");
const fs     = require("fs");
const path   = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegBin = require("ffmpeg-static");

const BASE_URL      = "https://api.elevenlabs.io/v1";
const FALLBACK_VOICE = "21m00Tcm4TlvDq8ikWAM";  // Rachel (clear, warm, works well for Hindi)
const DEFAULT_SPEED  = 1.15;   // slightly brisker pace — sync still intact via word-count proportional timing
const MIN_TARGET_SECS = 35;
const MAX_TARGET_SECS = 48;
const CTA_LINE = "Aise aur smart money reels chahiye? Follow kar lo.";
const INTRO_SILENCE_MS = 600;  // ↓ shorter intro silence (was 1000)
const OUTRO_SILENCE_S  = 3;

ffmpeg.setFfmpegPath(ffmpegBin);

// ── Text preprocessing ────────────────────────────────────────────────────────
// ElevenLabs multilingual_v2 handles Hinglish well, but needs help with:
//  • currency symbols  • abbreviations  • numbers  • words that split wrong
function preprocessText(text) {
  return String(text || "")
    // ─── Currency ───
    .replace(/₹\s*(\d[\d,.]*)\s*(lakh|crore|k|L|Cr)?/gi, (_, amt, sfx) =>
      `${amt}${sfx ? " " + sfx.trim() : ""} rupaye`
    )
    .replace(/₹/g, "rupaye")

    // ─── Common finance abbreviations → phonetic Hindi ───
    .replace(/\bSIP\b/g,   "es aa ee pee")
    .replace(/\bFD\b/g,    "ef dee")
    .replace(/\bEMI\b/g,   "ee em aa ee")
    .replace(/\bGST\b/g,   "jee es tee")
    .replace(/\bPPF\b/g,   "pee pee ef")
    .replace(/\bNPS\b/g,   "en pee es")
    .replace(/\bELSS\b/g,  "ee el es es")
    .replace(/\bRD\b/g,    "aar dee")
    .replace(/\bROI\b/g,   "aar o aa ee")
    .replace(/\bXIRR\b/g,  "ex aa ee aar aar")
    .replace(/\bNFO\b/g,   "en ef o")

    // ─── Common English terms → natural Hindi pronunciation hint ───
    .replace(/\bmutual fund\b/gi,       "myuchual fund")
    .replace(/\bcompound interest\b/gi, "compound interest")
    .replace(/\bstock market\b/gi,      "stock market")
    .replace(/\bterm insurance\b/gi,    "term insurance")

    // ─── Percentages → spoken form ───
    .replace(/\b90\s*%/g, "nabbe percent")
    .replace(/\b80\s*%/g, "assi percent")
    .replace(/\b70\s*%/g, "sattar percent")
    .replace(/\b50\s*%/g, "pachaas percent")
    .replace(/\b(\d+)\s*%/g, (_, n) => `${n} percent`)

    // ─── Hinglish words that TTS often mispronounces ───
    // Add a soft "h" hint so the model uses the correct Hindustani vowel
    .replace(/\bkyun\b/gi,    "kyoon")
    .replace(/\bkyu\b/gi,     "kyoon")
    .replace(/\bnahi\b/gi,    "nahin")
    .replace(/\bnah\b/gi,     "nahin")
    .replace(/\bhoga\b/gi,    "hoga")
    .replace(/\bkarna\b/gi,   "karna")
    .replace(/\bkarega\b/gi,  "karega")
    .replace(/\bkarte\b/gi,   "karte")
    .replace(/\blagta\b/gi,   "lagta")
    .replace(/\blagti\b/gi,   "lagti")
    .replace(/\bsamajh\b/gi,  "samajh")
    .replace(/\bsaath\b/gi,   "saath")
    .replace(/\bpaisa\b/gi,   "paisa")
    .replace(/\bpaise\b/gi,   "paise")
    .replace(/\baane\b/gi,    "aane")
    .replace(/\bbaad\b/gi,    "baad")
    .replace(/\bsoch\b/gi,    "soch")
    .replace(/\bjaanta\b/gi,  "jaanta")
    .replace(/\bjaanti\b/gi,  "jaanti")
    .replace(/\bmahina\b/gi,  "mahina")
    .replace(/\bmahine\b/gi,  "mahine")
    .replace(/\bdikhta\b/gi,  "dikhta")
    .replace(/\bdikhti\b/gi,  "dikhti")
    .replace(/\blekin\b/gi,   "lekin")
    .replace(/\bwarna\b/gi,   "warna")
    .replace(/\bphir\b/gi,    "phir")
    .replace(/\bkabhi\b/gi,   "kabhi")
    .replace(/\bsirf\b/gi,    "sirf")
    .replace(/\bbhul\b/gi,    "bhool")
    .replace(/\bbhool\b/gi,   "bhool")
    .replace(/\bzehan\b/gi,   "zehan")
    .replace(/\bwaqt\b/gi,    "waqt")
    .replace(/\bkharcha\b/gi, "kharcha")
    .replace(/\bkharche\b/gi, "kharche")

    // ─── Feminine voice corrections (safety net — prompt already asks for feminine) ───
    // Masculine future-tense (unga/unga endings) → feminine (ungi)
    .replace(/\bkarunga\b/gi,    "karungi")
    .replace(/\bkahunga\b/gi,    "kahungi")
    .replace(/\bbolunga\b/gi,    "bolungi")
    .replace(/\bdunga\b/gi,      "dungi")
    .replace(/\blunga\b/gi,      "lungi")
    .replace(/\baaunga\b/gi,     "aaungi")
    .replace(/\bjaunga\b/gi,     "jaungi")
    .replace(/\bjaaunga\b/gi,    "jaungi")
    .replace(/\bsochunga\b/gi,   "sochungi")
    .replace(/\blikhunga\b/gi,   "likhungi")
    .replace(/\bpadhunga\b/gi,   "padhungi")
    .replace(/\bsiikhunga\b/gi,  "siikhungi")
    .replace(/\bsikhlunga\b/gi,  "sikhlungi")
    .replace(/\bkhelunga\b/gi,   "khelungi")
    .replace(/\bpuchunga\b/gi,   "puchungi")
    .replace(/\bdehunga\b/gi,    "dehungi")
    .replace(/\bkhounga\b/gi,    "khoungi")
    .replace(/\bsamjhunga\b/gi,  "samjhungi")
    .replace(/\bbachunga\b/gi,   "bachungi")
    .replace(/\bbanaunga\b/gi,   "banaungi")
    .replace(/\bkharaabunga\b/gi,"kharaabungi")
    // Masculine raha → rahi (narrator self-reference)
    .replace(/\bmain\s+(\w+)\s+raha\s+hoon\b/gi, "main $1 rahi hoon")
    .replace(/\bmain\s+(\w+)\s+raha\s+hu\b/gi,   "main $1 rahi hu")

    // ─── Clean up whitespace ───
    .replace(/\s+/g, " ")
    .trim();
}

// ── Narration humaniser ───────────────────────────────────────────────────────
function humanizeNarration(text) {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s*([,.;:!?])\s*/g, "$1 ")
    .trim();

  if (!cleaned) return CTA_LINE;

  // Normalise common informal spellings for consistent TTS behaviour
  const softened = cleaned
    .replace(/\bmatlab\b/gi,        "matlab")
    .replace(/\bkyun\b/gi,          "kyoon")
    .replace(/\bkyu\b/gi,           "kyoon")
    .replace(/\bkarna chahiye\b/gi, "karna chahiye")
    .replace(/\bfollow kar lo\b/gi, "follow kar lo");

  // Append CTA if not already present
  return softened.toLowerCase().includes("follow kar lo")
    ? softened
    : `${softened}. ${CTA_LINE}`;
}

// ── Speed tuning ──────────────────────────────────────────────────────────────
function estimateSpeechSeconds(text, speed) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  const wps   = (150 * speed) / 60;   // ~150 WPM base rate
  return words > 0 ? words / wps : 0;
}

function tuneSpeed(text) {
  const envSpeed = Number(process.env.ELEVENLABS_SPEED || DEFAULT_SPEED);
  let speed = Number.isFinite(envSpeed) ? clamp(envSpeed, 1.0, 1.25) : DEFAULT_SPEED;

  const est = estimateSpeechSeconds(text, speed);
  if (est > MAX_TARGET_SECS) speed = Math.min(1.25, speed * (est / MAX_TARGET_SECS));
  else if (est < MIN_TARGET_SECS) speed = Math.max(1.0,  speed * Math.max(0.92, est / MIN_TARGET_SECS));

  return Number(speed.toFixed(2));
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function synthesizeToFile(body, outputPath, apiKey, voiceId) {
  return axios
    .post(`${BASE_URL}/text-to-speech/${voiceId}`, body, {
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      responseType: "stream",
      timeout: 90_000,
    })
    .then(async (res) => {
      if (res.status !== 200) throw new Error(`ElevenLabs HTTP ${res.status}`);
      await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(outputPath);
        res.data.pipe(w);
        w.on("finish", resolve);
        w.on("error",  reject);
        res.data.on("error", reject);
      });
    });
}

// ── FFmpeg post-processing ────────────────────────────────────────────────────
function applyAtempo(inputPath, outputPath, speed) {
  const tmp = `${outputPath}.tmp.mp3`;
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters([
        // Remove leading/trailing silence first
        "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-44dB" +
          ":stop_periods=-1:stop_duration=0.15:stop_threshold=-44dB",
        // Speed adjustment — atempo range is 0.5-2.0; chain for >2×
        `atempo=${speed.toFixed(2)}`,
      ])
      .audioCodec("libmp3lame")
      .audioBitrate("160k")
      .format("mp3")
      .save(tmp)
      .on("end", () => { try { fs.renameSync(tmp, outputPath); resolve(); } catch (e) { reject(e); } })
      .on("error", (e) => { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {} reject(e); });
  });
}

function applySilencePadding(inputPath, outputPath) {
  const tmp = `${outputPath}.pad.mp3`;
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters([
        `adelay=${INTRO_SILENCE_MS}|${INTRO_SILENCE_MS}`,
        `apad=pad_dur=${OUTRO_SILENCE_S}`,
      ])
      .audioCodec("libmp3lame")
      .audioBitrate("160k")
      .format("mp3")
      .save(tmp)
      .on("end", () => { try { fs.renameSync(tmp, outputPath); resolve(); } catch (e) { reject(e); } })
      .on("error", (e) => { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {} reject(e); });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────
async function generateAudio(text, outputPath) {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is missing from .env");

  const voiceId   = process.env.ELEVENLABS_VOICE_ID || FALLBACK_VOICE;
  const narration = humanizeNarration(preprocessText(text));
  const speed     = tuneSpeed(narration);

  const dir       = path.dirname(outputPath);
  const base      = path.basename(outputPath);
  const rawPath   = path.join(dir, `raw_${base}`);
  const spdPath   = path.join(dir, `speed_${base}`);

  console.log(`      Narration speed: ${speed}x  |  ${narration.split(/\s+/).length} words`);

  try {
    await synthesizeToFile(
      {
        text:     narration,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability:        0.50,  // ↑ slightly for clearer Hindi consonants
          similarity_boost: 0.75,
          style:            0.22,  // ↓ less stylisation → cleaner pronunciation
          use_speaker_boost: true,
        },
      },
      rawPath, apiKey, voiceId
    );

    await applyAtempo(rawPath, spdPath, speed);
    await applySilencePadding(spdPath, outputPath);
  } finally {
    for (const fp of [rawPath, spdPath]) {
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
    }
  }
}

module.exports = { generateAudio };
