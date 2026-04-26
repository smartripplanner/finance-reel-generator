"use strict";

const { createCanvas } = require("canvas");
const fs               = require("fs");
const path             = require("path");
const { spawnSync, spawn } = require("child_process");
const ffmpegBin        = require("ffmpeg-static");

const {
  W, H,
  SCENE_THEMES, PURPOSE_THEMES,
  clamp, lerp, easeOutCubic,
  normalizeElements, generateSceneLayout, renderScene,
  drawIntroFrame, drawProgressBar, logMemory,
  getThemeForScene,
} = require("./drawingEngine");

// ── Render constants ──────────────────────────────────────────────────────────
const FPS            = 20;     // 20 fps — 33 % fewer frames vs 30 fps
const MIN_DURATION   = 20;     // seconds
const MAX_DURATION   = 30;     // hard cap — keeps peak RAM predictable on 512 MB
const INTRO_SECONDS  = 0.5;    // brief branded intro — content starts ≤0.5 s in
const INTRO_FRAMES   = Math.round(INTRO_SECONDS * FPS);   // passed to drawIntroFrame
const MICRO_PAUSE    = 0.08;   // gap between scenes
const TEXT_REVEAL_MAX= 0.38;   // text fully drawn in ≤ 0.38 s
const JPEG_QUALITY   = 0.85;

// Frame pacing / reporting
const YIELD_EVERY    = 20;     // yield to event loop every N frames
const REPORT_EVERY   = 20;     // progress callback every N frames
const MEM_LOG_EVERY  = 100;    // heap log every N frames

const AUDIO_PATH = path.join(__dirname, "..", "temp", "audio.mp3");

// ── Audio duration probe ──────────────────────────────────────────────────────
function parseDurationFromProbeOutput(output) {
  const m = String(output||"").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const [h,min,sec] = [Number(m[1]),Number(m[2]),Number(m[3])];
  if (![h,min,sec].every(Number.isFinite)) return null;
  return h*3600+min*60+sec;
}

function getAudioDurationSeconds(audioPath=AUDIO_PATH) {
  try {
    if (!ffmpegBin||!fs.existsSync(audioPath)) return null;
    const r=spawnSync(ffmpegBin,["-i",audioPath],{encoding:"utf8",windowsHide:true,timeout:15_000});
    return parseDurationFromProbeOutput(r.stderr)||parseDurationFromProbeOutput(r.stdout);
  } catch (_) { return null; }
}

// ── Timeline builder (word-count proportional) ────────────────────────────────
function buildSceneTimeline(scenes, totalAudioSeconds) {
  const normalised = scenes.map(scene => ({
    ...scene,
    elements:  normalizeElements(scene),
    wordCount: String(scene.text||"").split(/\s+/).filter(Boolean).length,
  }));

  const totalWords  = Math.max(1, normalised.reduce((s,sc)=>s+sc.wordCount,0));
  const contentSecs = Math.max(1, totalAudioSeconds-INTRO_SECONDS);
  let cursor = INTRO_SECONDS;

  return normalised.map((scene,index) => {
    const fraction   = scene.wordCount/totalWords;
    const sceneDur   = fraction*contentSecs;
    const sceneStart = cursor;
    const textReveal = Math.min(TEXT_REVEAL_MAX, sceneDur*0.12);
    const textStart  = sceneStart;
    const textEnd    = sceneStart+textReveal;
    const drawStart  = textEnd;
    const drawEnd    = sceneStart+sceneDur-MICRO_PAUSE;
    const sceneEnd   = sceneStart+sceneDur;

    const words = String(scene.text||"").split(/\s+/).filter(Boolean);
    const wordWindows = words.map((_,wi)=>({
      start: textStart+(textReveal*wi)      /Math.max(1,words.length),
      end:   textStart+(textReveal*(wi+1))  /Math.max(1,words.length),
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
    if (t>=p.timings.sceneStart && t<=p.timings.sceneEnd) return p;
  }
  return plans[plans.length-1]||null;
}

// ── Main entry: render frames → stream JPEG → FFmpeg ─────────────────────────
async function renderFrames(
  scenes,
  videoPath,
  topic      = "Finance",
  audioPath  = AUDIO_PATH,
  onProgress = null
) {
  const audioDuration  = getAudioDurationSeconds(audioPath);
  const fallback       = INTRO_SECONDS+scenes.reduce((s,sc)=>s+(Number(sc.duration)||3),0);
  const totalAudioSecs = Math.min(MAX_DURATION, Math.max(MIN_DURATION, audioDuration||fallback));
  const scenePlans     = buildSceneTimeline(scenes, totalAudioSecs);
  const totalFrames    = Math.max(1, Math.ceil(totalAudioSecs*FPS));

  // ── Spawn FFmpeg ──────────────────────────────────────────────────────────
  const ffmpegArgs = [
    "-y",
    "-f","image2pipe","-vcodec","mjpeg","-framerate",String(FPS),
    "-i","pipe:0",
    "-i",audioPath,
    "-map","0:v:0","-map","1:a:0",
    "-vcodec","libx264",
    "-preset","ultrafast",
    "-crf","28",
    "-pix_fmt","yuv420p",
    "-movflags","+faststart",
    "-threads","1",
    "-shortest",
    "-acodec","aac","-b:a","128k",
    videoPath,
  ];

  const ffproc = spawn(ffmpegBin, ffmpegArgs, { stdio:["pipe","ignore","pipe"] });

  let ffmpegStderr="";
  ffproc.stderr.on("data", chunk => {
    ffmpegStderr=(ffmpegStderr+chunk.toString()).slice(-800);
  });

  const ffmpegDone = new Promise((resolve,reject) => {
    ffproc.on("close", code => code===0 ? resolve() : reject(new Error(`FFmpeg exited ${code}: ${ffmpegStderr.slice(-400)}`)));
    ffproc.on("error", reject);
  });

  // ── Single shared canvas ──────────────────────────────────────────────────
  const canvas = createCanvas(W,H);
  const ctx    = canvas.getContext("2d");

  let renderError=null;

  try {
    for (let frame=0; frame<totalFrames; frame++) {
      const currentTime = frame/FPS;
      const overall     = clamp(
        (currentTime-INTRO_SECONDS)/Math.max(0.1,totalAudioSecs-INTRO_SECONDS),
        0, 1
      );

      // ── Draw frame ───────────────────────────────────────────────────────
      if (frame < INTRO_FRAMES) {
        // Intro animation — passes frame index and total intro frames
        drawIntroFrame(ctx, frame, INTRO_FRAMES);
        drawProgressBar(ctx, 0, PURPOSE_THEMES.hook);

      } else {
        const active = findActiveScene(scenePlans, currentTime);
        if (active) {
          renderScene(ctx, active, currentTime, frame);

          // Progress bar uses purpose-driven theme
          const theme = getThemeForScene(active.scene, active.timings.sceneIndex);
          drawProgressBar(ctx, overall, theme);

        } else {
          ctx.fillStyle="#FFFFFF"; ctx.fillRect(0,0,W,H);
          drawProgressBar(ctx, 1, PURPOSE_THEMES.payoff);
        }
      }

      // ── JPEG → FFmpeg stdin ───────────────────────────────────────────────
      const jpegBuf  = canvas.toBuffer("image/jpeg", { quality: JPEG_QUALITY });
      const canWrite = ffproc.stdin.write(jpegBuf);
      if (!canWrite) {
        await new Promise(resolve => ffproc.stdin.once("drain", resolve));
      }

      // Yield to event loop — keeps Express status-poll requests responsive
      if (frame % YIELD_EVERY === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }

      // Memory logging + optional GC hint
      if (frame % MEM_LOG_EVERY === 0) {
        logMemory(frame, totalFrames);
        if (typeof global.gc==="function") global.gc();
      }

      // Progress callback
      if (onProgress && (frame%REPORT_EVERY===0 || frame===totalFrames-1)) {
        onProgress(Math.round((frame/totalFrames)*100), frame, totalFrames);
      }
    }
  } catch (err) {
    renderError=err;
  } finally {
    if (renderError) {
      ffproc.stdin.destroy();
      try { ffproc.kill(); } catch (_) {}
    } else {
      ffproc.stdin.end();
    }
  }

  if (renderError) throw renderError;
  await ffmpegDone;
  return totalFrames;
}

module.exports = { renderFrames };
