"use strict";

const { createCanvas } = require("canvas");
const fs              = require("fs");
const path            = require("path");
const { spawnSync, spawn } = require("child_process");
const ffmpegBin       = require("ffmpeg-static");

const {
  W, H, COLORS, SCENE_THEMES,
  clamp, lerp, easeOutCubic,
  normalizeElements, generateSceneLayout, renderScene,
} = require("./drawingEngine");

// ── Render constants ──────────────────────────────────────────────────────────
const FPS            = 20;    // 20 fps — 33 % fewer frames vs 30 fps
const MIN_DURATION   = 20;    // seconds
const MAX_DURATION   = 30;    // hard cap — keeps peak RAM predictable on 512 MB
const INTRO_SECONDS  = 0.6;   // short branded intro
const MICRO_PAUSE    = 0.08;  // gap between scenes
const TEXT_REVEAL_MAX = 0.38; // text fully drawn in ≤ 0.38 s
const JPEG_QUALITY   = 0.85;  // JPEG quality for intermediate frames piped to ffmpeg

// Frame batching / reporting
const YIELD_EVERY    = 20;    // yield to event loop every N frames (keeps Express responsive)
const REPORT_EVERY   = 20;    // call onProgress callback every N frames
const MEM_LOG_EVERY  = 100;   // log heap usage every N frames

const AUDIO_PATH = path.join(__dirname, "..", "temp", "audio.mp3");

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

// ── Timeline builder (word-count proportional) ────────────────────────────────
function buildSceneTimeline(scenes, totalAudioSeconds) {
  const normalised = scenes.map((scene) => ({
    ...scene,
    elements:  normalizeElements(scene),
    wordCount: String(scene.text || "").split(/\s+/).filter(Boolean).length,
  }));

  const totalWords  = Math.max(1, normalised.reduce((s, sc) => s + sc.wordCount, 0));
  const contentSecs = Math.max(1, totalAudioSeconds - INTRO_SECONDS);
  let cursor = INTRO_SECONDS;

  return normalised.map((scene, index) => {
    const fraction   = scene.wordCount / totalWords;
    const sceneDur   = fraction * contentSecs;
    const sceneStart = cursor;
    const textReveal = Math.min(TEXT_REVEAL_MAX, sceneDur * 0.12);
    const textStart  = sceneStart;
    const textEnd    = sceneStart + textReveal;
    const drawStart  = textEnd;
    const drawEnd    = sceneStart + sceneDur - MICRO_PAUSE;
    const sceneEnd   = sceneStart + sceneDur;

    const words = String(scene.text || "").split(/\s+/).filter(Boolean);
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
        sceneStart, sceneEnd,
        textStart,  textEnd,
        drawStart,  drawEnd,
        highlightStart: drawStart,
        highlightEnd:   drawEnd,
        wordWindows,
        sceneIndex: index,
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

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = theme.accent;
  ctx.fillRect(0, 0, W, 9);  // scaled accent bar

  ctx.save();
  ctx.globalAlpha  = eased;
  // emoji: 133 ← 200 × 2/3 ; y offset: -67 ← -100 × 2/3
  ctx.font         = `${Math.round(133 * eased)}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("💰", W / 2, H / 2 - 67);

  // tagline: lerp(20,43,…) ← lerp(30,64,…) × 2/3 ; y offset: +53 ← +80 × 2/3
  ctx.font      = `900 ${Math.round(lerp(20, 43, eased))}px "Arial Black", Impact, sans-serif`;
  ctx.fillStyle = theme.text;
  ctx.textBaseline = "top";
  ctx.fillText("Smart Money Tips", W / 2, H / 2 + 53);
  ctx.restore();
}

// ── Progress bar ─────────────────────────────────────────────────────────────
// Coordinates scaled 2/3 from original 1080p values.
function drawProgressBar(ctx, fraction, theme) {
  ctx.save();
  // Track (background)
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.lineWidth   = 7;   // 10 × 2/3
  ctx.lineCap     = "round";
  ctx.beginPath();
  ctx.moveTo(53, H - 21);          // 80→53, 32→21
  ctx.lineTo(W - 53, H - 21);
  ctx.stroke();
  // Fill
  ctx.strokeStyle = theme ? theme.accent : COLORS.blue;
  ctx.lineWidth   = 7;
  ctx.beginPath();
  ctx.moveTo(53, H - 21);
  ctx.lineTo(53 + (W - 106) * clamp(fraction, 0, 1), H - 21);  // 160→106
  ctx.stroke();
  ctx.restore();
}

// ── Memory logging helper ─────────────────────────────────────────────────────
function logMemory(frame, totalFrames) {
  const m  = process.memoryUsage();
  const mb = (b) => Math.round(b / 1024 / 1024);
  console.log(
    `[renderer] frame ${frame}/${totalFrames}` +
    ` | heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} MB` +
    ` | rss ${mb(m.rss)} MB`
  );
}

// ── Main entry: render frames and stream them directly into FFmpeg ─────────────
//
// Architecture: instead of writing PNG/JPEG files to disk and then running
// FFmpeg in a second pass, we:
//   1. Spawn FFmpeg reading JPEG frames from its stdin (image2pipe/mjpeg).
//   2. For each frame, render to canvas → toBuffer("image/jpeg") → stdin.write().
//   3. When all frames are written, close stdin → FFmpeg finalises the MP4.
//
// This eliminates the frames directory completely.  Peak extra RAM is one
// JPEG buffer (~70 KB at 720p) plus FFmpeg's internal encode buffers (~30 MB).
//
// Signature change vs. old renderer:
//   OLD: renderFrames(scenes, framesDir, topic, onProgress, audioPath)
//   NEW: renderFrames(scenes, videoPath, topic, audioPath,  onProgress)
//
async function renderFrames(
  scenes,
  videoPath,
  topic      = "Finance",
  audioPath  = AUDIO_PATH,
  onProgress = null
) {
  const audioDuration  = getAudioDurationSeconds(audioPath);
  const fallback       = INTRO_SECONDS + scenes.reduce((s, sc) => s + (Number(sc.duration) || 4), 0);
  // Clamp to MAX_DURATION so we never generate more frames than 512 MB can handle
  const totalAudioSecs = Math.min(MAX_DURATION, Math.max(MIN_DURATION, audioDuration || fallback));
  const scenePlans     = buildSceneTimeline(scenes, totalAudioSecs);
  const totalFrames    = Math.max(1, Math.ceil(totalAudioSecs * FPS));

  // ── Spawn FFmpeg ────────────────────────────────────────────────────────────
  //
  // -f image2pipe -vcodec mjpeg   read JPEG frames from stdin (boundaries
  //                                detected automatically by SOI/EOI markers)
  // -preset ultrafast              lowest CPU + RAM usage during encode
  // -crf 28                        slightly lower quality than default (22)
  //                                but imperceptible on mobile reel screens
  // -threads 1                     one encode thread keeps RAM usage flat
  //
  const ffmpegArgs = [
    "-y",
    "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", String(FPS),
    "-i", "pipe:0",
    "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vcodec", "libx264",
    "-preset", "ultrafast",
    "-crf", "28",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-threads", "1",
    "-shortest",
    "-acodec", "aac", "-b:a", "128k",
    videoPath,
  ];

  const ffproc = spawn(ffmpegBin, ffmpegArgs, {
    stdio: ["pipe", "ignore", "pipe"],
  });

  let ffmpegStderr = "";
  ffproc.stderr.on("data", (chunk) => {
    // Keep only the last 800 chars — avoids unbounded string growth
    ffmpegStderr = (ffmpegStderr + chunk.toString()).slice(-800);
  });

  // Promise that resolves when FFmpeg exits cleanly
  const ffmpegDone = new Promise((resolve, reject) => {
    ffproc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}: ${ffmpegStderr.slice(-400)}`));
    });
    ffproc.on("error", reject);
  });

  // ── Single shared canvas — reused across all frames ──────────────────────
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  let renderError = null;

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      const currentTime = frame / FPS;
      const overall     = clamp(
        (currentTime - INTRO_SECONDS) / Math.max(0.1, totalAudioSecs - INTRO_SECONDS),
        0, 1
      );

      // Draw frame
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

      // Encode as JPEG and pipe to FFmpeg
      const jpegBuf = canvas.toBuffer("image/jpeg", { quality: JPEG_QUALITY });
      const canWrite = ffproc.stdin.write(jpegBuf);
      if (!canWrite) {
        // Back-pressure: FFmpeg can't keep up — wait for drain before writing more
        await new Promise((resolve) => ffproc.stdin.once("drain", resolve));
      }

      // Yield to event loop so Express can serve status-poll requests mid-render
      if (frame % YIELD_EVERY === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Memory logging + GC hint
      if (frame % MEM_LOG_EVERY === 0) {
        logMemory(frame, totalFrames);
        // Hint the garbage collector if exposed via --expose-gc
        if (typeof global.gc === "function") global.gc();
      }

      // Progress callback
      if (onProgress && (frame % REPORT_EVERY === 0 || frame === totalFrames - 1)) {
        onProgress(Math.round((frame / totalFrames) * 100), frame, totalFrames);
      }
    }
  } catch (err) {
    renderError = err;
  } finally {
    if (renderError) {
      // Kill FFmpeg — don't await its exit since we're about to throw
      ffproc.stdin.destroy();
      try { ffproc.kill(); } catch (_) {}
    } else {
      // Signal end-of-stream; FFmpeg will write the moov atom and exit cleanly
      ffproc.stdin.end();
    }
  }

  if (renderError) throw renderError;

  // Wait for FFmpeg to finalise the MP4 (moov atom write, container close)
  await ffmpegDone;

  return totalFrames;
}

module.exports = { renderFrames };
