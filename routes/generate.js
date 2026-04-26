"use strict";

const express    = require("express");
const router     = express.Router();
const path       = require("path");
const fs         = require("fs");
const { v4: uuidv4 } = require("uuid");

const { generateScript, generateCaption } = require("../services/gemini");
const { generateAudio, buildNarration  } = require("../services/elevenlabs");
// renderFrames now handles both rendering AND encoding via JPEG→stdin pipe
const { renderFrames         } = require("../services/renderer");
const { lightQualityCheck    } = require("../services/scriptQualityEngine");
const { convertNarration     } = require("../services/devanagariConverter");

const ROOT       = path.join(__dirname, "..");
const TEMP_BASE  = path.join(ROOT, "temp");
const OUTPUT_DIR = path.join(ROOT, "output");
const JOBS_FILE  = path.join(ROOT, "jobs.json");

// ─── Structured logging ───────────────────────────────────────────────────────
function log(jobId, msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const id = jobId ? jobId.slice(0, 8) : "system ";
  console.log(`[${ts}] [${id}] ${msg}`);
}

// ─── Job store ────────────────────────────────────────────────────────────────
const MAX_JOBS      = 60;
const STALE_MS      = 5 * 60 * 1000;   // 5 min with no update → failed
const jobs          = new Map();

/**
 * @typedef {{
 *   id: string, topic: string,
 *   status: 'queued'|'processing'|'completed'|'failed',
 *   progress: number, step: string,
 *   videoUrl: string|null, caption: string|null, hashtags: string[],
 *   error: string|null, createdAt: string, updatedAt: string
 * }} Job
 */

// ─── Persistence ──────────────────────────────────────────────────────────────
//
// jobs.json lives next to server.js so it survives ephemeral /tmp wipes on
// Render.  On every meaningful state-change we serialise the whole Map.
// During frame rendering we skip the write to avoid hammering the disk.

function persistJobs() {
  try {
    fs.mkdirSync(ROOT, { recursive: true });  // noop if exists
    const entries = Array.from(jobs.entries()).slice(-MAX_JOBS);
    fs.writeFileSync(JOBS_FILE, JSON.stringify(entries, null, 2), "utf8");
  } catch (err) {
    log(null, `persist failed: ${err.message}`);
  }
}

function loadPersistedJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const entries = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
    let restored = 0, failed = 0;
    for (const [id, job] of entries) {
      // Any job that was mid-flight when the server died can never be resumed.
      // Mark it failed so the frontend gets a clear signal instead of spinning.
      if (job.status === "processing" || job.status === "queued") {
        job.status    = "failed";
        job.step      = "Failed.";
        job.error     = "Server restarted while this job was running. Please generate again.";
        job.updatedAt = new Date().toISOString();
        failed++;
      } else {
        restored++;
      }
      jobs.set(id, job);
    }
    log(null, `startup — restored ${restored} completed, marked ${failed} stale as failed`);
  } catch (err) {
    log(null, `load persisted jobs failed: ${err.message}`);
  }
}

// Run once at module load (i.e. server start)
loadPersistedJobs();

// ─── Stale-job watchdog ───────────────────────────────────────────────────────
// Any processing/queued job that has not had a progress update in 5 minutes
// is declared failed. This catches runaway renders and hung API calls.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "processing" && job.status !== "queued") continue;
    const age = now - new Date(job.updatedAt).getTime();
    if (age >= STALE_MS) {
      log(id, `watchdog: no progress for ${Math.round(age / 1000)}s — marking failed`);
      patch(id, {
        status: "failed",
        step:   "Timed out.",
        error:  "No progress for 5 minutes. The server may be overloaded — please try again.",
      });
    }
  }
}, 60_000).unref();  // .unref() → won't keep the process alive on clean shutdown

// ─── CRUD helpers ─────────────────────────────────────────────────────────────
function createJob(topic) {
  if (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value);

  const job = {
    id:        uuidv4(),
    topic,
    status:    "queued",
    progress:  0,
    step:      "Queued…",
    videoUrl:  null,
    caption:   null,
    hashtags:  [],
    error:     null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  persistJobs();     // persist immediately so a crash after POST still records the job
  return job;
}

/**
 * Update a job in-place.
 * @param {boolean} [persist=true]  Pass false for high-frequency frame-tick updates
 *                                  to avoid hammering the disk during rendering.
 */
function patch(jobId, updates, persist = true) {
  const job = jobs.get(jobId);
  if (!job) return;
  const prevStatus = job.status;
  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
  // Always persist on meaningful changes; skip during rapid frame-tick updates
  if (persist || job.status !== prevStatus) persistJobs();
}

// ─── History ──────────────────────────────────────────────────────────────────
function getHistory() {
  return Array.from(jobs.values())
    .filter(j  => j.status === "completed")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10)
    .map(j => ({
      id:         j.id,
      topic:      j.topic,
      video_url:  j.videoUrl,
      caption:    j.caption,
      hashtags:   j.hashtags,
      created_at: j.createdAt,
    }));
}

// ─── Background job runner ────────────────────────────────────────────────────
//
// Progress milestones (render + encode are now a single streaming step):
//   0          queued
//   2          processing start
//   10         script complete
//   12         audio/caption started
//   25         audio complete
//   30         render+encode stream start
//   30 → 95    render+encode (frame-driven; map 0→100 % render to 30→95 %)
//   100        done (FFmpeg finalised MP4)
//
// There is NO separate frames directory.  Frames are JPEG-encoded and piped
// directly to FFmpeg stdin — no intermediate files touch the disk.
//
async function runJob(jobId) {
  // Only a jobTemp dir is needed — audio goes here; no frames dir required
  const jobTemp   = path.join(TEMP_BASE, jobId);
  const audioPath = path.join(jobTemp, "audio.mp3");
  const videoFile = `reel_${Date.now()}.mp4`;
  const videoPath = path.join(OUTPUT_DIR, videoFile);
  const videoUrl  = `/output/${videoFile}`;

  try {
    fs.mkdirSync(jobTemp,    { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const job = jobs.get(jobId);
    if (!job) return;

    // ── 1 / 3  Script — generate → light quality check → regenerate once if needed
    patch(jobId, { status: "processing", progress: 2, step: "Generating script…" });
    log(jobId, `script start — "${job.topic}"`);

    const rawScenes = await generateScript(job.topic);
    const quality   = lightQualityCheck(rawScenes);
    let scenes      = rawScenes;
    let scriptPass  = 1;

    if (!quality.passed) {
      log(jobId, `script pass 1: ${quality.score}/10 — ${quality.reason} — regenerating…`);
      patch(jobId, { step: "Improving script quality…" });
      try {
        const retryScenes   = await generateScript(job.topic);
        const retryQuality  = lightQualityCheck(retryScenes);
        scenes     = retryScenes;
        scriptPass = 2;
        log(jobId, `script pass 2: ${retryQuality.score}/10`);
      } catch (retryErr) {
        log(jobId, `pass 2 error (${retryErr.message}) — using pass 1 scenes`);
      }
    } else {
      log(jobId, `script pass 1: ${quality.score}/10 ✓`);
    }

    log(jobId, `script done — pass: ${scriptPass} | scenes: ${scenes.length}`);
    patch(jobId, { progress: 10, step: "Script ready…" });

    // ── 2 / 3  Audio + Caption (parallel) ────────────────────────────────────
    patch(jobId, { progress: 12, step: "Creating voiceover…" });
    log(jobId, "audio + caption start");

    // Build two versions of the narration:
    //   ttsNarration  — Devanagari-converted (Hindi words in native script) → TTS
    //   scenes        — unchanged Roman Hinglish → renderer (slide text on screen)
    //
    // WHY: ElevenLabs multilingual_v2 reads Devanagari with perfect Hindi
    // pronunciation — no phonetic hacks needed. Slides stay in Roman Hindi
    // because viewers read it faster on screen.
    const rawNarration = buildNarration(scenes);
    const ttsNarration = convertNarration(rawNarration);
    log(jobId, `narration: ${rawNarration.split(/\s+/).length} words → Devanagari converted`);

    const [, captionData] = await Promise.all([
      generateAudio(ttsNarration, audioPath),
      generateCaption(job.topic, scenes).catch(() => ({
        caption:  `${job.topic} ke baare mein yeh jaanna zaroori hai! 💰\nFollow karo tips ke liye! 🚀`,
        hashtags: ["#finance","#money","#SIP","#investing","#personalfinance",
                   "#wealth","#IndianFinance","#moneymanagement","#financetips","#paisa"],
      })),
    ]);

    log(jobId, "audio + caption done");
    patch(jobId, { progress: 25, step: "Audio ready…" });

    // ── 3 / 3  Render + encode (streaming — no frames on disk) ───────────────
    patch(jobId, { progress: 30, step: "Rendering & encoding…" });
    log(jobId, "render+encode start (streaming JPEG→ffmpeg pipe)");

    let lastLoggedFrame = -1;
    await renderFrames(
      scenes,
      videoPath,
      job.topic,
      audioPath,
      (pct, frame, total) => {
        // Map render 0–100 % → job progress 30–95 %
        const overall = 30 + Math.round(pct * 0.65);
        patch(jobId, { progress: overall, step: "Rendering & encoding…" }, false);

        // Log every ~10 % of total frames
        const threshold = Math.max(1, Math.round(total * 0.10));
        if (frame - lastLoggedFrame >= threshold) {
          log(jobId, `frame ${frame}/${total} (${pct}%) → job ${overall}%`);
          lastLoggedFrame = frame;
        }
      }
    );

    log(jobId, `render+encode complete → ${videoFile}`);

    // ── Done ──────────────────────────────────────────────────────────────────
    patch(jobId, {
      status:   "completed",
      progress: 100,
      step:     "Done!",
      videoUrl,
      caption:  captionData.caption,
      hashtags: captionData.hashtags,
    });
    log(jobId, "✅ complete");

  } catch (err) {
    log(jobId, `❌ failed: ${err.message}`);
    patch(jobId, { status: "failed", step: "Failed.", error: err.message });

  } finally {
    // Remove per-job temp dir (audio only — no frames were written)
    try { fs.rmSync(jobTemp, { recursive: true, force: true }); } catch (_) {}
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /generate
 * Creates a job and starts async processing.
 * Returns { jobId, status } immediately — client polls /status/:jobId.
 */
router.post("/", (req, res) => {
  const topic = (req.body.topic || "").trim();
  if (!topic) return res.status(400).json({ error: "topic is required" });

  const job = createJob(topic);
  log(job.id, `job created: "${topic}"`);

  // Fire-and-forget — never await this
  runJob(job.id).catch(err => log(job.id, `unhandled: ${err.message}`));

  return res.json({ jobId: job.id, status: job.status });
});

/**
 * GET /generate/status/:jobId
 * Polled by the frontend every 3 s.
 */
router.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  return res.json({
    jobId:    job.id,
    status:   job.status,    // queued | processing | completed | failed
    progress: job.progress,  // 0–100
    step:     job.step,
    videoUrl: job.videoUrl,
    caption:  job.caption,
    hashtags: job.hashtags,
    error:    job.error,
  });
});

/**
 * GET /generate/history
 * Returns last 10 completed reels.
 */
router.get("/history", (_req, res) => res.json(getHistory()));

module.exports = router;
