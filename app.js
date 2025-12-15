// WebGazer + Kopf姿态小幅修正，5点校准，眨眼通过视线丢失间隙检测
const grid = document.getElementById("grid");
const statusEl = document.getElementById("status");
const resetBtn = document.getElementById("reset");
const doneEl = document.getElementById("done");
const gazeDot = document.getElementById("gaze-dot");
const debugPanel = document.getElementById("debug");
const toggleDebugBtn = document.getElementById("toggle-debug");
const calibrateBtn = document.getElementById("calibrate");
const calOverlay = document.getElementById("calibration");
const calTargetEl = document.getElementById("cal-target");
const calProgressEl = document.getElementById("cal-progress");

const BLINK_MIN_MS = 80;
const BLINK_MAX_MS = 450;
const BLINK_EAR_THRESHOLD = 0.22;
const BLINK_EAR_MIN_FRAMES = 2;
const FOCUS_LOCK_MS = 140;
const HEAD_GAIN_X = 0; // bei Bedarf erhöhen (z.B. 200-400)
const HEAD_GAIN_Y = 0; // bei Bedarf erhöhen (z.B. 200-400)
const CAL_POINTS = [
  { x: 0.12, y: 0.08 },
  { x: 0.88, y: 0.08 },
  { x: 0.5, y: 0.5 },
  { x: 0.12, y: 0.92 },
  { x: 0.88, y: 0.92 },
];
const CAL_SAMPLES_PER_POINT = 28;
let MANUAL_SCALE_X = 1.0;
let MANUAL_SCALE_Y = 1.35;

let cellBounds = new Map();
let activeCells = new Set();
let lastTargetId = null;
let lockedTargetId = null;
let targetStartMs = null;
let missingSince = null;
let debugEnabled = false;
let blinkCount = 0;
let lastBlinkAt = null;
let predictionCache = null;
let calibrationActive = false;
let calIndex = 0;
let calSamples = [];
let biasX = 0;
let biasY = 0;
let scaleX = 1;
let scaleY = 1;
let lastStats = null;
let headOffsetX = 0;
let headOffsetY = 0;
let faceMesh = null;
let blinkEarFrames = 0;

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function randomHue(index) {
  const base = (index * 37 + Math.random() * 25) % 360;
  return `hsl(${base}, 70%, 58%)`;
}

function buildGrid() {
  grid.innerHTML = "";
  activeCells.clear();
  const ids = shuffle(Array.from({ length: 9 }, (_, i) => i));

  ids.forEach((id, idx) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.id = String(id);
    cell.style.background = `linear-gradient(145deg, rgba(255,255,255,0.12), rgba(255,255,255,0.02)), ${randomHue(idx)}`;

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = id + 1;
    cell.appendChild(label);

    grid.appendChild(cell);
    activeCells.add(String(id));
  });

  queueMicrotask(updateCellBounds);
  doneEl.classList.add("hidden");
}

function updateCellBounds() {
  cellBounds = new Map();
  const cells = grid.querySelectorAll(".cell");
  cells.forEach((cell) => {
    if (cell.classList.contains("cleared")) return;
    const rect = cell.getBoundingClientRect();
    cellBounds.set(cell.dataset.id, rect);
  });
}

function findTarget(prediction) {
  if (!prediction) return null;
  for (const [id, rect] of cellBounds.entries()) {
    if (
      prediction.x >= rect.left &&
      prediction.x <= rect.right &&
      prediction.y >= rect.top &&
      prediction.y <= rect.bottom
    ) {
      return id;
    }
  }
  return null;
}

function clearFocus() {
  grid.querySelectorAll(".cell.focused").forEach((cell) => {
    cell.classList.remove("focused");
  });
  grid.querySelectorAll(".cell.locked").forEach((cell) => {
    cell.classList.remove("locked");
  });
}

function markFocus(id, locked) {
  clearFocus();
  if (!id) return;
  const cell = grid.querySelector(`[data-id="${id}"]`);
  if (cell) {
    cell.classList.add("focused");
    if (locked) cell.classList.add("locked");
  }
}

function handleBlink(targetId) {
  const chosenId = targetId || lockedTargetId || lastTargetId;
  if (!chosenId || !activeCells.has(chosenId)) return;
  const cell = grid.querySelector(`[data-id="${chosenId}"]`);
  if (!cell) return;
  cell.classList.add("cleared");
  activeCells.delete(chosenId);
  statusEl.textContent = `Quadrat ${Number(chosenId) + 1} gelöscht`;
  lockedTargetId = null;
  targetStartMs = null;
  blinkCount += 1;
  lastBlinkAt = performance.now();

  setTimeout(() => {
    updateCellBounds();
    if (activeCells.size === 0) {
      doneEl.classList.remove("hidden");
      statusEl.textContent = "Alles gelöscht. Sie können zurücksetzen.";
    }
  }, 180);
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function mapPrediction(prediction) {
  return {
    x: clamp((prediction.x + headOffsetX) * scaleX * MANUAL_SCALE_X + biasX, 0, window.innerWidth),
    y: clamp((prediction.y + headOffsetY) * scaleY * MANUAL_SCALE_Y + biasY, 0, window.innerHeight),
  };
}

function earFromLandmarks(ls) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const L_top = ls[159];
  const L_bottom = ls[145];
  const L_left = ls[33];
  const L_right = ls[133];
  const R_top = ls[386];
  const R_bottom = ls[374];
  const R_left = ls[362];
  const R_right = ls[263];
  const L_vert = dist(L_top, L_bottom);
  const L_hori = dist(L_left, L_right) + 1e-6;
  const R_vert = dist(R_top, R_bottom);
  const R_hori = dist(R_left, R_right) + 1e-6;
  const L_ear = L_vert / L_hori;
  const R_ear = R_vert / R_hori;
  return (L_ear + R_ear) / 2;
}

function setupFaceMesh(videoEl) {
  try {
    faceMesh = new FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    faceMesh.onResults(onFaceMeshResults);

    const pump = async () => {
      if (videoEl.readyState >= 2) {
        try {
          await faceMesh.send({ image: videoEl });
        } catch (err) {
          // avoid flooding console on transient errors
        }
      }
      requestAnimationFrame(pump);
    };
    pump();
  } catch (err) {
    console.warn("FaceMesh init failed", err);
  }
}

function onFaceMeshResults(results) {
  if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) return;
  const ls = results.multiFaceLandmarks[0];
  const nose = ls[1];
  const leftEye = ls[33];
  const rightEye = ls[263];
  const mouth = ls[13];
  const eyeCenter = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
  const faceCenter = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + mouth.y) / 2 };
  const yawRaw = nose.x - faceCenter.x;
  const pitchRaw = nose.y - eyeCenter.y;
  headOffsetX = yawRaw * HEAD_GAIN_X;
  headOffsetY = pitchRaw * HEAD_GAIN_Y;
  
    const ear = earFromLandmarks(ls);
    if (ear < BLINK_EAR_THRESHOLD) {
      blinkEarFrames += 1;
    } else {
      if (blinkEarFrames >= BLINK_EAR_MIN_FRAMES) {
        handleBlink(lockedTargetId || lastTargetId);
      }
      blinkEarFrames = 0;
    }
}

async function startWebgazer() {
  try {
    await webgazer
      .setRegression("weightedRidge")
      .setGazeListener((data) => {
        predictionCache = data;
      })
      .showFaceOverlay(false)
      .showFaceFeedbackBox(false)
      .showPredictionPoints(false)
      .saveDataAcrossSessions(false)
      .begin();
    const video = document.getElementById("webgazerVideoFeed");
    if (video) {
      video.style.display = "none";
      setupFaceMesh(video);
    }
    const overlay = document.getElementById("webgazerFaceOverlay");
    if (overlay) overlay.style.display = "none";
    statusEl.textContent = "Blick wird verfolgt. Anblicken und blinzeln zum Löschen.";
  } catch (err) {
    statusEl.textContent = "Kamera konnte nicht gestartet werden. Bitte Berechtigung prüfen.";
    console.warn("WebGazer start failed", err);
  }
}

function getPrediction() {
  const p = predictionCache || webgazer.getCurrentPrediction?.();
  if (!p) return null;
  return { x: p.x, y: p.y };
}

function detectBlink(now, hasPrediction) {
  if (hasPrediction) {
    missingSince = null;
    return;
  }

  if (missingSince === null) {
    missingSince = now;
    return;
  }

  const gap = now - missingSince;
  if (gap >= BLINK_MIN_MS && gap <= BLINK_MAX_MS) {
    handleBlink(lockedTargetId || lastTargetId);
  }
  if (gap > BLINK_MAX_MS) missingSince = now;
}

function trackLoop() {
  const now = performance.now();
  const rawPrediction = getPrediction();

  if (calibrationActive) {
    if (rawPrediction) {
      handleCalibration(rawPrediction);
      gazeDot.style.left = `${rawPrediction.x}px`;
      gazeDot.style.top = `${rawPrediction.y}px`;
      gazeDot.classList.toggle("hidden", !debugEnabled);
    }
    requestAnimationFrame(trackLoop);
    return;
  }

  const prediction = rawPrediction ? mapPrediction(rawPrediction) : null;

  if (prediction) {
    gazeDot.style.left = `${prediction.x}px`;
    gazeDot.style.top = `${prediction.y}px`;
    gazeDot.classList.toggle("hidden", !debugEnabled);

    const target = findTarget(prediction);
    if (target !== lastTargetId) {
      lastTargetId = target;
      targetStartMs = target ? now : null;
      lockedTargetId = null;
    } else if (target && targetStartMs !== null && now - targetStartMs >= FOCUS_LOCK_MS) {
      lockedTargetId = target;
    }

    markFocus(target, target && target === lockedTargetId);
    if (target && target === lockedTargetId) {
      statusEl.textContent = `Sie schauen auf Quadrat ${Number(target) + 1}. Blinzeln zum Löschen.`;
    }
  } else {
    gazeDot.classList.toggle("hidden", true);
  }

  detectBlink(now, !!prediction);

  if (debugEnabled) {
    const dbgTarget = lockedTargetId || lastTargetId || "-";
    const blinkText = blinkCount
      ? `${blinkCount}x, zuletzt vor ${(lastBlinkAt ? Math.round(now - lastBlinkAt) : "-")} ms`
      : "0x";
    debugPanel.textContent = [
      `Vorhersage: ${prediction ? `${Math.round(prediction.x)}, ${Math.round(prediction.y)}` : "Keine"}`,
      `Aktuelles Feld: ${dbgTarget}`,
      `Blinzeln: ${blinkText}`,
      `Offset: ${Math.round(biasX)}, ${Math.round(biasY)}`,
      `Skalierung: ${scaleX.toFixed(3)}, ${scaleY.toFixed(3)}`,
      `Kopf-Offset: ${headOffsetX.toFixed(2)}, ${headOffsetY.toFixed(2)}`,
      lastStats
        ? `Span gx: ${(lastStats.gx.max - lastStats.gx.min).toFixed(1)}, gy: ${(lastStats.gy.max - lastStats.gy.min).toFixed(1)}, tx: ${(lastStats.tx.max - lastStats.tx.min).toFixed(1)}, ty: ${(lastStats.ty.max - lastStats.ty.min).toFixed(1)}`
        : "Span: -"
    ].join("\n");
  }

  requestAnimationFrame(trackLoop);
}

function resetGrid() {
  buildGrid();
  lastTargetId = null;
  missingSince = null;
  statusEl.textContent = "Zurückgesetzt. Quadrat anblicken und blinzeln zum Löschen.";
  blinkCount = 0;
  lastBlinkAt = null;
}

resetBtn.addEventListener("click", resetGrid);
window.addEventListener("resize", updateCellBounds);

toggleDebugBtn.addEventListener("click", () => {
  debugEnabled = !debugEnabled;
  toggleDebugBtn.setAttribute("aria-pressed", String(debugEnabled));
  toggleDebugBtn.textContent = debugEnabled ? "Debug ausblenden" : "Debug anzeigen";
  debugPanel.classList.toggle("hidden", !debugEnabled);
  gazeDot.classList.toggle("hidden", !debugEnabled);
});

function setCalTargetPosition() {
  const p = CAL_POINTS[calIndex];
  const x = window.innerWidth * p.x;
  const y = window.innerHeight * p.y;
  calTargetEl.style.left = `${x}px`;
  calTargetEl.style.top = `${y}px`;
  calProgressEl.textContent = `${calIndex + 1} / ${CAL_POINTS.length}`;
}

function startCalibration() {
  calibrationActive = true;
  calIndex = 0;
  calSamples = [];
  biasX = 0;
  biasY = 0;
  scaleX = 1;
  scaleY = 1;
  lastStats = null;
  calOverlay.classList.remove("hidden");
  setCalTargetPosition();
  statusEl.textContent = "Kalibrierung: Bitte auf den Punkt blicken";
}

function linearFit(samples, gKey, tKey) {
  const n = samples.length;
  if (n < 3) return { slope: 1, intercept: 0 };
  let sumG = 0;
  let sumT = 0;
  let sumGG = 0;
  let sumGT = 0;
  for (const s of samples) {
    const g = s[gKey];
    const t = s[tKey];
    sumG += g;
    sumT += t;
    sumGG += g * g;
    sumGT += g * t;
  }
  const denom = n * sumGG - sumG * sumG;
  if (Math.abs(denom) < 1e-6) return { slope: 1, intercept: 0 };
  const slope = (n * sumGT - sumG * sumT) / denom;
  const intercept = (sumT - slope * sumG) / n;
  return { slope, intercept };
}

function computeStats(samples, key) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const s of samples) {
    const v = s[key];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / samples.length;
  return { min, max, mean };
}

function adjustScaleToRange({ slope, intercept }, gStats, tStats) {
  const gSpan = gStats.max - gStats.min;
  const tSpan = tStats.max - tStats.min;
  if (gSpan < 1e-3 || tSpan < 1e-3) return { slope, intercept };
  const predMin = slope * gStats.min + intercept;
  const predMax = slope * gStats.max + intercept;
  const predSpan = predMax - predMin;
  if (Math.abs(predSpan) < 1e-3) return { slope, intercept };
  const ratio = tSpan / predSpan;
  const newSlope = slope * ratio;
  const targetMid = (tStats.max + tStats.min) / 2;
  const newIntercept = targetMid - newSlope * gStats.mean;
  return { slope: newSlope, intercept: newIntercept };
}

function finishCalibration() {
  if (calSamples.length === 0) {
    calibrationActive = false;
    calOverlay.classList.add("hidden");
    statusEl.textContent = "Kalibrierung fehlgeschlagen: keine Daten erfasst";
    return;
  }

  const completedSamples = calSamples.slice(0, calIndex * CAL_SAMPLES_PER_POINT || calSamples.length);
  const samples = completedSamples.length ? completedSamples : calSamples;
  if (!samples.length) {
    calibrationActive = false;
    calOverlay.classList.add("hidden");
    statusEl.textContent = "Kalibrierung fehlgeschlagen: keine Daten erfasst";
    return;
  }

  const gxStats = computeStats(samples, "gx");
  const gyStats = computeStats(samples, "gy");
  const txStats = computeStats(samples, "tx");
  const tyStats = computeStats(samples, "ty");
  ({ slope: scaleX, intercept: biasX } = adjustScaleToRange(linearFit(samples, "gx", "tx"), gxStats, txStats));
  ({ slope: scaleY, intercept: biasY } = adjustScaleToRange(linearFit(samples, "gy", "ty"), gyStats, tyStats));
  lastStats = { gx: gxStats, gy: gyStats, tx: txStats, ty: tyStats };
  calibrationActive = false;
  calOverlay.classList.add("hidden");
  statusEl.textContent = "Kalibrierung abgeschlossen. Blinzeln zum Löschen.";
}

function handleCalibration(rawPrediction) {
  const p = CAL_POINTS[calIndex];
  const targetX = window.innerWidth * p.x;
  const targetY = window.innerHeight * p.y;
  calSamples.push({ tx: targetX, ty: targetY, gx: rawPrediction.x, gy: rawPrediction.y });

  if (calSamples.length >= (calIndex + 1) * CAL_SAMPLES_PER_POINT) {
    calIndex += 1;
    if (calIndex >= CAL_POINTS.length) {
      finishCalibration();
    } else {
      setCalTargetPosition();
    }
  }
}

calibrateBtn.addEventListener("click", () => {
  startCalibration();
});

const scaleYInput = document.getElementById("scaleYInput");
const scaleXInput = document.getElementById("scaleXInput");

scaleYInput.addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  if (isFinite(v)) {
    MANUAL_SCALE_Y = v;
    statusEl.textContent = `Vertikale Skalierung: ${MANUAL_SCALE_Y.toFixed(2)}`;
  }
});

scaleXInput.addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  if (isFinite(v)) {
    MANUAL_SCALE_X = v;
    statusEl.textContent = `Horizontale Skalierung: ${MANUAL_SCALE_X.toFixed(2)}`;
  }
});

document.addEventListener("DOMContentLoaded", () => {
  buildGrid();
  startWebgazer();
  requestAnimationFrame(trackLoop);
});
