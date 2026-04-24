"use strict";

const { createCanvas } = require("canvas");
const fs   = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ffmpegBin = require("ffmpeg-static");

const {
  W, H, COLORS, SCENE_THEMES,
  clamp, lerp, easeOutCubic,
  normalizeElements, generateSceneLayout, renderScene,
} = require("./drawingEngine");

const FPS               = 30;
const INTRO_SECONDS     = 0.6;   // short branded intro
const MICRO_PAUSE       = 0.08;  // tiny gap between scenes
const TEXT_REVEAL_MAX   = 0.38;  // seconds: text fully drawn in ≤ 0.38s
const AUDIO_PATH        = path.join(__dirname, "..", "temp", "audio.mp3");

// ── Audio duration probe ──────────────────────────────────────────────────────
function parseDurationFromProbeOutput(output) {
  const m = String(output || "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const [h, min, sec] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![h, min, sec].every(Number.isFinite)) return null;
  return h * 3600 + min * 60 + sec;
}

function getAudioDurationSeconds(audioPath = AUDIO_PATH) {
  try {
    if (!ffmpegBin || !fs.existsSync(audioPath)) return null;
    const r = spawnSync(ffmpegBin, ["-i", audioPath], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
    });
    return parseDurationFromProbeOutput(r.stderr) || parseDurationFromProbeOutput(r.stdout);
  } catch (_) {
    return null;
  }
}

// ── Timeline builder (word-count proportional — the only reliable sync) ───────
//
// Why word-count? ElevenLabs speaks each scene's text at a pace proportional
// to its word count. By allotting video time in the same proportion we ensure
// scene boundaries in the video match those in the audio.
//
// Text reveal is capped at TEXT_REVEAL_MAX so words are already visible when
// the voice reaches them — solving the "text lags behind voice" complaint.
//
function buildSceneTimeline(scenes, totalAudioSeconds) {
  const normalised = scenes.map((scene) => ({
    ...scene,
    elements: normalizeElements(scene),
    wordCount: String(scene.text || "").split(/\s+/).filter(Boolean).length,
  }));

  const totalWords    = Math.max(1, normalised.reduce((s, sc) => s + sc.wordCount, 0));
  const contentSecs   = Math.max(1, totalAudioSeconds - INTRO_SECONDS);

  let cursor = INTRO_SECONDS;

  return normalised.map((scene, index) => {
    // Each scene gets time proportional to its word count
    const fraction     = scene.wordCount / totalWords;
    const sceneDur     = fraction * contentSecs;
    const sceneStart   = cursor;

    // Text appears fast — no longer than TEXT_REVEAL_MAX or 12 % of scene
    const textReveal   = Math.min(TEXT_REVEAL_MAX, sceneDur * 0.12);
    const textStart    = sceneStart;
    const textEnd      = sceneStart + textReveal;

    // Emoji/visuals animate for the remaining time
    const drawStart    = textEnd;
    const drawEnd      = sceneStart + sceneDur - MICRO_PAUSE;
    const sceneEnd     = sceneStart + sceneDur;

    // Word windows (for keyword-triggered visual sync, kept for API compat)
    const words       = String(scene.text || "").split(/\s+/).filter(Boolean);
    const wordWindows = words.map((_, wi) => ({
      start: textStart + (textReveal * wi)       / Math.max(1, words.length),
      end:   textStart + (textReveal * (wi + 1)) / Math.max(1, words.length),
    }));

    const layout = generateSceneLayout(scene, index);
    cursor = sceneEnd;

    return {
      scene,
      layout,
      timings: {
        sceneStart,
        sceneEnd,
        textStart,
        textEnd,
        drawStart,
        drawEnd,
        highlightStart: drawStart,
        highlightEnd:   drawEnd,
        wordWindows,
        sceneIndex: index,   // ← drives SCENE_THEMES colour selection
      },
    };
  });
}

function findActiveScene(plans, t) {
  for (const p of plans) {
    if (t >= p.timings.sceneStart && t <= p.timings.sceneEnd) return p;
  }
  return plans[plans.length - 1] || null;
}

// ── Intro frame ───────────────────────────────────────────────────────────────
function drawIntroFrame(ctx, frame) {
  const p     = clamp(frame / Math.max(1, INTRO_SECONDS * FPS), 0, 1);
  const eased = easeOutCubic(p);
  const theme = SCENE_THEMES[0];

  // Background matches first scene theme
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = theme.accent;
  ctx.fillRect(0, 0, W, 14);

  // Centred intro emoji + tagline
  ctx.save();
  ctx.globalAlpha  = eased;
  ctx.font         = `${Math.round(200 * eased)}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("💰", W / 2, H / 2 - 100);

  ctx.font         = `900 ${Math.round(lerp(30, 64, eased))}px "Arial Black", Impact, sans-serif`;
  ctx.fillStyle    = theme.text;
  ctx.textBaseline = "top";
  ctx.fillText("Smart Money Tips", W / 2, H / 2 + 80);
  ctx.restore();
}

// ── Progress bar drawn over every frame ──────────────────────────────────────
function drawProgressBar(ctx, fraction, theme) {
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.lineWidth   = 10;
  ctx.lineCap     = "round";
  ctx.beginPath();
  ctx.moveTo(80, H - 32);
  ctx.lineTo(W - 80, H - 32);
  ctx.stroke();

  ctx.strokeStyle = theme ? theme.accent : COLORS.blue;
  ctx.lineWidth   = 10;
  ctx.beginPath();
  ctx.moveTo(80, H - 32);
  ctx.lineTo(80 + (W - 160) * clamp(fraction, 0, 1), H - 32);
  ctx.stroke();
  ctx.restore();
}

// ── Main render entry ─────────────────────────────────────────────────────────
// audioPath  – path to the generated mp3; defaults to legacy global path
// onProgress – optional (pct: number) => void  called every ~30 frames
async function renderFrames(
  scenes,
  framesDir,
  topic      = "Finance",
  onProgress = null,
  audioPath  = AUDIO_PATH
) {
  const audioDuration   = getAudioDurationSeconds(audioPath);
  const fallback        = INTRO_SECONDS + scenes.reduce((s, sc) => s + (Number(sc.duration) || 4), 0);
  const totalAudioSecs  = Math.max(20, audioDuration || fallback);
  const scenePlans      = buildSceneTimeline(scenes, totalAudioSecs);
  const totalFrames     = Math.max(1, Math.ceil(totalAudioSecs * FPS));
  const canvas          = createCanvas(W, H);
  const ctx             = canvas.getContext("2d");
  const REPORT_EVERY    = 30; // report progress every N frames

  for (let frame = 0; frame < totalFrames; frame++) {
    const currentTime = frame / FPS;
    const overall     = clamp(
      (currentTime - INTRO_SECONDS) / Math.max(0.1, totalAudioSecs - INTRO_SECONDS),
      0, 1
    );

    if (frame < INTRO_SECONDS * FPS) {
      drawIntroFrame(ctx, frame);
      drawProgressBar(ctx, 0, SCENE_THEMES[0]);
    } else {
      const active = findActiveScene(scenePlans, currentTime);
      if (active) {
        renderScene(ctx, active, currentTime, frame);
        const theme = SCENE_THEMES[active.timings.sceneIndex % SCENE_THEMES.length];
        drawProgressBar(ctx, overall, theme);
      } else {
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, W, H);
        drawProgressBar(ctx, 1, SCENE_THEMES[0]);
      }
    }

    const name = `frame_${String(frame).padStart(4, "0")}.png`;
    fs.writeFileSync(path.join(framesDir, name), canvas.toBuffer("image/png"));

    // Report render progress periodically (0–100 %)
    if (onProgress && (frame % REPORT_EVERY === 0 || frame === totalFrames - 1)) {
      onProgress(Math.round((frame / totalFrames) * 100));
    }
  }

  return totalFrames;
}

module.exports = { renderFrames };
