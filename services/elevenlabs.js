"use strict";

const axios  = require("axios");
const fs     = require("fs");
const path   = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegBin = require("ffmpeg-static");

const pronunciationEngine = require("./pronunciationEngine");

const BASE_URL      = "https://api.elevenlabs.io/v1";
const FALLBACK_VOICE = "21m00Tcm4TlvDq8ikWAM";  // Rachel (clear, warm, works well for Hindi)
const DEFAULT_SPEED  = 1.20;   // brisker pace — matches 20-25 s audio window
const MIN_TARGET_SECS = 20;    // aligned with renderer MIN_DURATION (20 s)
const MAX_TARGET_SECS = 25;    // leaves 5 s headroom under the 30 s video cap
const CTA_LINE = "Aise aur tips chahiye? Toh abhi follow karo.";
const INTRO_SILENCE_MS = 450;  // matches INTRO_SECONDS in renderer.js (0.5 s)
const OUTRO_SILENCE_S  = 1;    // short tail — video cap is 30 s, don't waste it

ffmpeg.setFfmpegPath(ffmpegBin);

// ── Devanagari detection ──────────────────────────────────────────────────────
// If the narration already contains Devanagari script, the pronunciation is
// handled natively by the multilingual_v2 model — skip the pronunciation
// engine entirely to avoid it corrupting properly-encoded Hindi text.
function hasDevanagari(text) {
  return /[\u0900-\u097F]/.test(text);
}

// ── Text preprocessing — delegates to pronunciationEngine ─────────────────────
// Only called when the narration is pure Roman Hinglish (no Devanagari).
// When Devanagari is present, the devanagariConverter has already handled
// pronunciation — running the engine on top would corrupt the Devanagari.
function preprocessText(text, voiceId) {
  if (hasDevanagari(text)) {
    // Devanagari path: only do minimal numeric/symbol cleanup, skip phonetic engine
    return String(text || "")
      .replace(/₹/g, "rupees ")
      .replace(/Rs\.?\s*/gi, "rupees ")
      .replace(/%/g, " percent")
      .replace(/\s+/g, " ")
      .trim();
  }
  // Roman Hinglish path: full pronunciation engine (legacy / fallback)
  return pronunciationEngine.process(String(text || ""), voiceId);
}

// ── Narration humaniser ───────────────────────────────────────────────────────
//
// NOTE: Do NOT append a CTA here. The CTA scene is always the last item in the
// scene array and is included in the narration by buildNarration(). Adding a
// second CTA here would produce a duplicate at the end of every reel.
//
function humanizeNarration(text) {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s*([,.;:!?])\s*/g, "$1 ")
    .trim();

  if (!cleaned) return "";

  // Normalise common informal spellings for consistent TTS behaviour
  return cleaned
    .replace(/\bmatlab\b/gi,        "matlab")
    .replace(/\bkyun\b/gi,          "kyoon")
    .replace(/\bkyu\b/gi,           "kyoon")
    .replace(/\bkarna chahiye\b/gi, "karna chahiye")
    // Ensure any surviving CTA variants are normalised to the imperative form
    .replace(/\bfollow\s+kar\s+l[oa]\b/gi,     "follow karo")
    .replace(/\bfollow\s+kar\s+l[uo]ngi?\b/gi, "follow karo");
}

// ── Speed tuning ──────────────────────────────────────────────────────────────
function estimateSpeechSeconds(text, speed) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  const wps   = (150 * speed) / 60;   // ~150 WPM base rate
  return words > 0 ? words / wps : 0;
}

function tuneSpeed(text) {
  const envSpeed = Number(process.env.ELEVENLABS_SPEED || DEFAULT_SPEED);
  let speed = Number.isFinite(envSpeed) ? clamp(envSpeed, 1.0, 1.30) : DEFAULT_SPEED;

  const est = estimateSpeechSeconds(text, speed);
  if      (est > MAX_TARGET_SECS) speed = Math.min(1.30, speed * (est / MAX_TARGET_SECS));
  else if (est < MIN_TARGET_SECS) speed = Math.max(1.0,  speed * Math.max(0.95, est / MIN_TARGET_SECS));

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
  const narration = humanizeNarration(preprocessText(text, voiceId));
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

// ── Narration builder — scene-aware pause injection ───────────────────────────
//
// Scenes with scenePurpose "hook", "reveal", or "payoff" get a longer pause
// after them so the TTS has a beat of silence to let the line land.
// "pain" and "action" get a normal sentence break.
// "cta" gets no trailing pause (voice energy should drive straight through).
//
// ElevenLabs multilingual_v2 respects "..." as a meaningful pause and
// sentence-boundary punctuation ". " for a shorter beat.
//
function buildNarration(scenes) {
  if (!Array.isArray(scenes) || !scenes.length) return "";

  return scenes.map((scene, i) => {
    const purpose = (scene.scenePurpose || "action").toLowerCase();
    const text    = String(scene.text || "").trim().replace(/\s*[.!?]+\s*$/, ""); // strip trailing punct

    // Choose separator based on purpose
    let sep;
    switch (purpose) {
      case "hook":
        // Dramatic pause — let the hook land
        sep = i < scenes.length - 1 ? "... " : ".";
        break;
      case "reveal":
        // Longer beat — truth bomb needs a moment to sink in
        sep = i < scenes.length - 1 ? "... " : ".";
        break;
      case "payoff":
        // Short pause — empowering close, building to CTA
        sep = i < scenes.length - 1 ? ".. " : ".";
        break;
      case "cta":
        // No trailing pause — CTA ends the audio
        sep = ".";
        break;
      case "pain":
        // Normal sentence break — relatable, flowing
        sep = i < scenes.length - 1 ? ". " : ".";
        break;
      default:
        // "action" and everything else: standard break
        sep = i < scenes.length - 1 ? ". " : ".";
    }

    return text + sep;
  }).join("");
}

module.exports = { generateAudio, buildNarration };
