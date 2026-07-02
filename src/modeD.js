/*
 * SoundPointer – Modus D: VIO-gestütztes virtuelles Array + Triangulation
 * ------------------------------------------------------------------
 * Position der virtuellen Mikrofone kommt aus WebXR/ARCore-Pose (NICHT aus
 * Beschleunigungs-Integration). KEINE geführte Bewegung mehr: Der Nutzer
 * bewegt das Handy einfach frei; ein Hintergrund-Algorithmus prüft laufend
 * gleitende Zeitfenster und wählt SELBST die Abschnitte aus, deren Messwerte
 * geeignet sind (genug Bewegungs-Apertur, Ton hörbar, ebene-Welle-Fit
 * kohärent). Jeder akzeptierte Abschnitt liefert eine Richtungsschätzung
 * (lineare Kleinste-Quadrate); mehrere Abschnitte von verschiedenen
 * Standorten werden per Strahlenschnitt (Triangulation) zu einem Quellpunkt
 * + Unsicherheits-Ellipsoid verrechnet. Ein GRÜNER Bildschirmrand meldet dem
 * Nutzer live, dass seine aktuelle Bewegung gute Daten liefert.
 *
 * Android-only (Chrome, WebXR immersive-ar / ARCore).
 */

'use strict';

import { CoherentTone } from './coherent.js';

const C_SOUND = 343;
const TWO_PI = Math.PI * 2;
const FIT_WIN_MS = 1600;     // gleitendes Auswertefenster
const FIT_EVERY_MS = 450;    // Prüftakt des Auswahl-Algorithmus
const BUF_MS = 6000;         // Rohpuffer (Audio+Pose)
const MIN_SAMPLES = 12;
const SEG_MAX = 16;          // max. gehaltene Richtungs-Segmente
const COH_MIN = 0.25;        // Mindest-Kohärenz eines akzeptierten Segments

/* ---------- kleine Lineare Algebra ---------- */
function solveLinear(A, b, n) { // Gauß mit Teilpivotisierung; A: n*n (row-major), b: n
  const M = A.slice(), x = b.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r * n + col]) > Math.abs(M[piv * n + col])) piv = r;
    if (Math.abs(M[piv * n + col]) < 1e-12) return null;
    if (piv !== col) {
      for (let k = 0; k < n; k++) { const t = M[col * n + k]; M[col * n + k] = M[piv * n + k]; M[piv * n + k] = t; }
      const t = x[col]; x[col] = x[piv]; x[piv] = t;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r * n + col] / M[col * n + col];
      for (let k = col; k < n; k++) M[r * n + k] -= f * M[col * n + k];
      x[r] -= f * x[col];
    }
  }
  for (let i = 0; i < n; i++) x[i] /= M[i * n + i];
  return x;
}
function inv3(M) { // M row-major 9
  const a = M[0], b = M[1], c = M[2], d = M[3], e = M[4], f = M[5], g = M[6], h = M[7], i = M[8];
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc;
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    Cc * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ];
}
// Symmetrische 3x3-Eigenzerlegung (Jacobi) -> { val:[3], vec:[[3],[3],[3]] }
function eigSym3(m) {
  let a = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    let p = 0, q = 1, max = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > max) { max = Math.abs(a[0][2]); p = 0; q = 2; }
    if (Math.abs(a[1][2]) > max) { max = Math.abs(a[1][2]); p = 1; q = 2; }
    if (max < 1e-12) break;
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi), s = Math.sin(phi);
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p], akq = a[k][q];
      a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k], aqk = a[q][k];
      a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
  }
  return {
    val: [a[0][0], a[1][1], a[2][2]],
    vec: [[v[0][0], v[1][0], v[2][0]], [v[0][1], v[1][1], v[2][1]], [v[0][2], v[1][2], v[2][2]]],
  };
}
function norm3(v) { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function mat4v(m, v) { // col-major 4x4 * vec4
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

/* ---------- Modus-D-Zustand ---------- */
const md = {
  freq: 1200,
  session: null, refSpace: null, gl: null, xrLayer: null,
  posePos: null, viewMat: null, projMat: null,
  poseHistory: [],        // [{t, pos}] – Ringpuffer für Zeit-Alignment Audio↔Pose
  audioLatency: 150,      // ms – geschätzte Audio-Eingangslatenz (wird nach Start gesetzt)
  scanning: true,         // kontinuierliche Auswertung aktiv (Pause-Button)
  buf: [],                // Rohsamples [{t,pos,phase,amp,snr}] – gleitender Puffer
  lastFitT: 0,
  goodness: 0,            // 0..1 geglättet – "bewegt sich der Nutzer gut?"
  moveTone: 0, moveSpan: 0, // Teilmetriken für HUD-Hinweise
  segments: [],           // akzeptierte Abschnitte [{ t, center, dir, coh, sigTheta, deltaF, samples }]
  source: null,           // { point:[3], cov:[9], axes:[{dir,len}], depthSigma }
  tone: null,
  arCtx: null, inCtx: null,
  inspector: false,
  orbit: { yaw: 0.6, pitch: 0.5, zoom: 1, ptr: new Map(), lastPinch: 0 },
};

/* ---------- WebXR ---------- */
async function xrSupported() {
  return !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false));
}

async function startSession() {
  const root = document.getElementById('modeD');
  const cfgs = [
    { requiredFeatures: ['local-floor'], optionalFeatures: ['dom-overlay'], domOverlay: { root } },
    { requiredFeatures: ['local'], optionalFeatures: ['dom-overlay'], domOverlay: { root } },
    { optionalFeatures: ['dom-overlay'], domOverlay: { root } },
  ];
  let session = null, err = null;
  for (const c of cfgs) { try { session = await navigator.xr.requestSession('immersive-ar', c); break; } catch (e) { err = e; } }
  if (!session) throw err || new Error('WebXR-AR-Session nicht möglich');
  md.session = session;

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true });
  if (gl.makeXRCompatible) { try { await gl.makeXRCompatible(); } catch (e) { /* ignore */ } }
  md.gl = gl;
  md.xrLayer = new XRWebGLLayer(session, gl);
  session.updateRenderState({ baseLayer: md.xrLayer });

  md.refSpace = await session.requestReferenceSpace('local-floor')
    .catch(() => session.requestReferenceSpace('local'));

  session.addEventListener('end', () => onSessionEnd());
  session.requestAnimationFrame(onXRFrame);
}

function onSessionEnd() {
  md.session = null; md.refSpace = null;
  if (md.tone) { md.tone.stop(); md.tone = null; }
  document.getElementById('modeD').classList.add('hidden');
  document.getElementById('gate').classList.remove('hidden');
}

function onXRFrame(t, frame) {
  const session = md.session;
  if (!session) return;
  session.requestAnimationFrame(onXRFrame);

  // XR-GL-Framebuffer transparent leeren → ARCore-Kamera durchscheinen lassen
  const gl = md.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, md.xrLayer.framebuffer);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const pose = frame.getViewerPose(md.refSpace);
  if (pose && !pose.emulatedPosition) {
    const p = pose.transform.position;
    md.posePos = [p.x, p.y, p.z];
    const view = pose.views[0];
    md.projMat = view.projectionMatrix;
    md.viewMat = view.transform.inverse.matrix;
    // Pose in Ringpuffer schreiben (für Audio-Zeit-Alignment)
    md.poseHistory.push({ t: performance.now(), pos: md.posePos.slice() });
    if (md.poseHistory.length > 120) md.poseHistory.shift(); // ~2 s bei 60 fps
  }
  // Kontinuierlicher Auswahl-Algorithmus: prüft im Takt, ob das letzte
  // Zeitfenster brauchbare Messwerte enthält, und übernimmt es dann selbst.
  const now = performance.now();
  if (md.scanning && now - md.lastFitT >= FIT_EVERY_MS) {
    md.lastFitT = now;
    tryFit(now);
  }
  md.goodness *= 0.995; // sanfter Verfall zwischen den Prüfungen
  drawAR();
  if (md.inspector) drawInspector();
  updateHud();
}

/* ---------- Pose-Interpolation auf Audio-Aufnahmezeit ---------- */
function interpolatePose(tAudio) {
  const h = md.poseHistory;
  if (h.length === 0) return md.posePos;
  if (h.length === 1 || tAudio <= h[0].t) return h[0].pos;
  if (tAudio >= h[h.length - 1].t) return h[h.length - 1].pos;
  // Binäre Suche nach Bracket
  let lo = 0, hi = h.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (h[mid].t <= tAudio) lo = mid; else hi = mid;
  }
  const f = (tAudio - h[lo].t) / (h[hi].t - h[lo].t);
  const a = h[lo].pos, b = h[hi].pos;
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

/* ---------- Audio-Sample-Erfassung (läuft ständig) ---------- */
function onAudioWindow(wnd) {
  if (!md.session || !md.scanning) return;
  // Audio-Aufnahmezeit = Callback-Zeit minus geschätzte Eingangslatenz
  const tAudio = wnd.t - md.audioLatency;
  const pos = interpolatePose(tAudio);
  if (!pos) return;
  md.buf.push({ t: wnd.t, pos: pos.slice(), phase: wnd.phase, amp: wnd.amp, snr: wnd.snr });
  const cutoff = wnd.t - BUF_MS;
  while (md.buf.length && md.buf[0].t < cutoff) md.buf.shift();
}

/* ---------- Pro Zeitfenster: Richtungsschätzung ---------- */
function fitDirection(samplesAll) {
  const s = samplesAll.slice();
  if (s.length < MIN_SAMPLES) return null;
  s.sort((a, b) => a.t - b.t);
  // Phase entlang des Pfads entfalten (Nachbarn << λ/2)
  const ph = new Array(s.length);
  ph[0] = s[0].phase;
  for (let i = 1; i < s.length; i++) {
    let d = s[i].phase - s[i - 1].phase;
    d -= TWO_PI * Math.round(d / TWO_PI);
    ph[i] = ph[i - 1] + d;
  }
  // Orts- und Zeitzentrum
  const center = [0, 0, 0];
  for (const x of s) { center[0] += x.pos[0]; center[1] += x.pos[1]; center[2] += x.pos[2]; }
  center[0] /= s.length; center[1] /= s.length; center[2] /= s.length;
  const tCenter = s[Math.floor(s.length / 2)].t;
  // Lineare KQ mit Drift-Term:  phase_i = φ₀ + α·Δt − sx·px − sy·py − sz·pz
  // Δt in Sekunden (zentriert), p relativ zum Ortszentrum
  // Unbekannte: [φ₀, α, sx, sy, sz]  (n=5)
  const ATA = new Array(25).fill(0), ATb = new Array(5).fill(0);
  let spanMax = 0;
  for (let i = 0; i < s.length; i++) {
    const p = sub(s[i].pos, center);
    const dt = (s[i].t - tCenter) / 1000;
    const a = [1, dt, -p[0], -p[1], -p[2]];
    const w = Math.max(0.2, Math.min(3, s[i].snr));
    for (let r = 0; r < 5; r++) { for (let cc = 0; cc < 5; cc++) ATA[r * 5 + cc] += w * a[r] * a[cc]; ATb[r] += w * a[r] * ph[i]; }
    const sp = Math.hypot(p[0], p[1], p[2]); if (sp > spanMax) spanMax = sp;
  }
  const x = solveLinear(ATA, ATb, 5);
  if (!x) return null;
  const sVec = [x[2], x[3], x[4]]; // räumlicher Gradient
  const sMag = Math.hypot(sVec[0], sVec[1], sVec[2]);
  if (sMag < 1e-6) return null;
  const k = TWO_PI * md.freq / C_SOUND;
  const kRatio = sMag / k;
  // Plausibilitäts-Gate: |s|/k sollte nahe 1 sein (ebene Welle)
  if (kRatio < 0.4 || kRatio > 2.5) return null;
  const dir = [sVec[0] / sMag, sVec[1] / sMag, sVec[2] / sMag];
  const deltaF = x[1] / TWO_PI; // Frequenzabweichung in Hz
  // Residuum (nach Abzug beider Terme) -> Kohärenz, Winkelunsicherheit
  let res2 = 0;
  for (let i = 0; i < s.length; i++) {
    const p = sub(s[i].pos, center);
    const dt = (s[i].t - tCenter) / 1000;
    const pred = x[0] + x[1] * dt - (sVec[0] * p[0] + sVec[1] * p[1] + sVec[2] * p[2]);
    const r = ph[i] - pred; res2 += r * r;
  }
  const rmsRes = Math.sqrt(res2 / s.length);
  const coh = Math.max(0, Math.min(1, 1 - rmsRes / (Math.PI * 0.6)));
  const aperture = Math.max(0.1, 2 * spanMax);
  const sigTheta = Math.max(0.05, Math.min(0.8, rmsRes / (k * aperture + 1e-6)));
  return { center, dir, coh, sigTheta, deltaF, kRatio, n: s.length };
}

/* ---------- Triangulation ---------- */
function triangulate() {
  const cs = md.segments.filter((c) => c && c.dir && c.coh > 0.1);
  if (cs.length < 2) { md.source = null; return; }
  const M = new Array(9).fill(0), b = [0, 0, 0];
  for (const c of cs) {
    const d = c.dir, w = c.coh + 0.05;
    // P = I - d d^T
    const P = [
      1 - d[0] * d[0], -d[0] * d[1], -d[0] * d[2],
      -d[1] * d[0], 1 - d[1] * d[1], -d[1] * d[2],
      -d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2],
    ];
    for (let i = 0; i < 9; i++) M[i] += w * P[i];
    const o = c.center;
    b[0] += w * (P[0] * o[0] + P[1] * o[1] + P[2] * o[2]);
    b[1] += w * (P[3] * o[0] + P[4] * o[1] + P[5] * o[2]);
    b[2] += w * (P[6] * o[0] + P[7] * o[1] + P[8] * o[2]);
  }
  const x = solveLinear(M, b, 3);
  if (!x) { md.source = null; return; }
  // Kovarianz ~ sigPerp^2 * M^-1
  let sp2 = 0, cnt = 0;
  for (const c of cs) { const r = Math.hypot(x[0] - c.center[0], x[1] - c.center[1], x[2] - c.center[2]); sp2 += (r * c.sigTheta) ** 2; cnt++; }
  const sigPerp2 = sp2 / Math.max(1, cnt);
  const Minv = inv3(M) || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const cov = Minv.map((v) => v * sigPerp2);
  const eig = eigSym3(cov);
  const axes = [0, 1, 2].map((i) => ({ dir: eig.vec[i], len: Math.sqrt(Math.max(0, eig.val[i])) }));
  const depthSigma = Math.sqrt(Math.max(...eig.val.map((v) => Math.max(0, v))));
  md.source = { point: x, cov, axes, depthSigma };
}

/* ---------- Kontinuierlicher Auswahl-Algorithmus ---------- */
// Prüft das letzte Zeitfenster: Ton hörbar? Genug Bewegungs-Apertur? Fit
// kohärent? Nur dann wird der Abschnitt als Segment übernommen. Nebenbei
// entsteht die Bewegungs-Güte (0..1) für das grüne Live-Feedback.
function tryFit(now) {
  const s = md.buf.filter((x) => x.t >= now - FIT_WIN_MS);
  const lambda = C_SOUND / md.freq;

  // Teilmetrik 1: Ton vorhanden (Median-SNR des Lock-in)
  let tone = 0;
  if (s.length >= 4) {
    const snrs = s.map((x) => x.snr).sort((a, b) => a - b);
    const med = snrs[snrs.length >> 1];
    tone = Math.max(0, Math.min(1, (med - 0.2) / 0.5));
  }
  // Teilmetrik 2: Bewegungs-Apertur im Fenster (Durchmesser um den Schwerpunkt)
  let span = 0;
  if (s.length >= 4) {
    const c = [0, 0, 0];
    for (const x of s) { c[0] += x.pos[0]; c[1] += x.pos[1]; c[2] += x.pos[2]; }
    c[0] /= s.length; c[1] /= s.length; c[2] /= s.length;
    for (const x of s) { const d = Math.hypot(x.pos[0] - c[0], x.pos[1] - c[1], x.pos[2] - c[2]); if (d > span) span = d; }
    span *= 2;
  }
  const move = Math.max(0, Math.min(1, span / (0.5 * lambda)));
  md.moveTone = tone; md.moveSpan = span;

  // Fit nur versuchen, wenn die Vorprüfung überhaupt Chancen sieht.
  let fit = null;
  if (s.length >= MIN_SAMPLES && tone > 0.15 && span >= 0.25 * lambda) {
    fit = fitDirection(s);
    if (fit && fit.coh >= COH_MIN) acceptSegment(now, fit, s);
    else fit = null;
  }

  // Bewegungs-Güte fürs grüne Feedback: Ton × Bewegung × Fit-Qualität.
  const target = tone * move * (fit ? (0.35 + 0.65 * fit.coh) : 0.35);
  md.goodness += (target - md.goodness) * 0.35;
}

// Segment übernehmen; sehr ähnliche, kurz aufeinanderfolgende Segmente werden
// zusammengelegt (bestes behalten), damit Stillstand die Liste nicht flutet.
function acceptSegment(now, fit, samples) {
  fit.t = now;
  fit.samples = samples.filter((_, i) => (i & 1) === 0); // fürs 3D dezimieren
  const last = md.segments[md.segments.length - 1];
  if (last && now - last.t < 2200) {
    const dc = Math.hypot(fit.center[0] - last.center[0], fit.center[1] - last.center[1], fit.center[2] - last.center[2]);
    const dot = fit.dir[0] * last.dir[0] + fit.dir[1] * last.dir[1] + fit.dir[2] * last.dir[2];
    if (dc < 0.15 && dot > 0.975) { // gleicher Standort, gleiche Richtung
      if (fit.coh > last.coh) md.segments[md.segments.length - 1] = fit;
      triangulate();
      return;
    }
  }
  md.segments.push(fit);
  while (md.segments.length > SEG_MAX) md.segments.shift();
  triangulate();
  setStatus('Segment ' + md.segments.length + ' ✓ · gern auch Standort wechseln');
}

function togglePause() {
  md.scanning = !md.scanning;
  if (!md.scanning) { md.goodness = 0; md.buf = []; }
  const btn = document.getElementById('md-capture');
  btn.textContent = md.scanning ? 'Pause' : 'Weiter';
  btn.classList.toggle('armed', !md.scanning);
  setStatus(md.scanning ? 'Suche läuft – einfach frei bewegen' : 'pausiert');
}

function resetD() { md.segments = []; md.source = null; md.buf = []; md.goodness = 0; md.poseHistory = []; setStatus('zurückgesetzt'); }

let statusUntil = 0, statusMsg = '';
function setStatus(m) { statusMsg = m; statusUntil = performance.now() + 4000; }

/* ---------- AR-Overlay ---------- */
function projectWorld(p, W, H) {
  if (!md.viewMat || !md.projMat) return null;
  const eye = mat4v(md.viewMat, [p[0], p[1], p[2], 1]);
  const clip = mat4v(md.projMat, eye);
  if (clip[3] <= 0.0001) return null;
  const nx = clip[0] / clip[3], ny = clip[1] / clip[3];
  return { x: (nx * 0.5 + 0.5) * W, y: (1 - (ny * 0.5 + 0.5)) * H };
}
function drawAR() {
  const cv = document.getElementById('md-ar');
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth, H = window.innerHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = md.arCtx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

  // Grünes Bewegungs-Feedback: leuchtender Rand-Schleier, je besser die
  // aktuelle Bewegung Messwerte liefert, desto kräftiger. Bildmitte bleibt frei.
  if (md.scanning && md.goodness > 0.04) {
    const cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy);
    const a = Math.min(0.32, 0.36 * md.goodness);
    const g = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R);
    g.addColorStop(0, 'rgba(25,227,106,0)');
    g.addColorStop(1, `rgba(25,227,106,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  // Quellpunkt – im Bild: grüner Marker; außerhalb: Randpfeil
  if (md.source && md.viewMat && md.projMat) {
    const proj = projectWorld(md.source.point, W, H);
    const margin = 40;
    const inView = proj && proj.x >= margin && proj.x <= W - margin && proj.y >= margin && proj.y <= H - margin;
    if (inView) {
      ctx.strokeStyle = 'rgba(25,227,106,0.95)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(proj.x, proj.y, 26, 0, TWO_PI); ctx.stroke();
      ctx.fillStyle = 'rgba(25,227,106,0.95)';
      ctx.beginPath(); ctx.arc(proj.x, proj.y, 6, 0, TWO_PI); ctx.fill();
      ctx.font = '13px -apple-system, sans-serif';
      ctx.fillText('Quelle ±' + md.source.depthSigma.toFixed(1) + ' m', proj.x + 32, proj.y + 4);
    } else {
      // Richtungsvektor aus View-Matrix (Spalte 2 = Z-Achse der Kamera)
      const p = md.source.point;
      // Kamera-Koordinaten des Quellpunkts
      const vm = md.viewMat;
      const ex = vm[0] * p[0] + vm[4] * p[1] + vm[8]  * p[2] + vm[12];
      const ey = vm[1] * p[0] + vm[5] * p[1] + vm[9]  * p[2] + vm[13];
      const ez = vm[2] * p[0] + vm[6] * p[1] + vm[10] * p[2] + vm[14];
      let dx = ex, dy = -ey;
      if (ez >= 0) { dx = -dx; dy = -dy; } // hinter der Kamera
      const ang = Math.atan2(dy, dx);
      const cx = W / 2, cy = H / 2, rr = Math.min(W, H) * 0.38;
      const ax = cx + Math.cos(ang) * rr, ay = cy + Math.sin(ang) * rr;
      ctx.save();
      ctx.translate(ax, ay); ctx.rotate(ang);
      ctx.fillStyle = 'rgba(25,227,106,0.95)';
      ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(-13, 11); ctx.lineTo(-13, -11); ctx.closePath(); ctx.fill();
      ctx.restore();
      // Beschriftung: Distanz + Schwenk-Hinweis
      const d = Math.hypot(ex, ey, ez);
      const hint = ez >= 0 ? 'umdrehen' : 'hierhin schwenken';
      ctx.fillStyle = 'rgba(25,227,106,0.95)';
      ctx.font = '13px -apple-system, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Quelle ' + d.toFixed(1) + ' m · ' + hint, cx, cy);
      ctx.textAlign = 'start';
    }
  }
}

/* ---------- 3D-Inspektor ---------- */
function rot(p, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = p[0] * cy + p[2] * sy, z1 = -p[0] * sy + p[2] * cy, y1 = p[1];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [x1, y1 * cp - z1 * sp, y1 * sp + z1 * cp];
}
function drawInspector() {
  const cv = document.getElementById('md-inspector');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = md.inCtx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = 'rgba(11,20,24,0.72)'; ctx.fillRect(0, 0, W, H);

  // Punktwolke einsammeln
  const pts = [];
  for (const c of md.segments) for (const s of c.samples) pts.push(s.pos);
  for (const c of md.segments) pts.push(c.center);
  if (md.source) pts.push(md.source.point);
  if (md.posePos) pts.push(md.posePos);
  if (!pts.length) return;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i]; }
  const ctr = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 0.5);
  const scale = (0.4 * Math.min(W, H) / ext) * md.orbit.zoom;
  const pr = (p) => { const r = rot(sub(p, ctr), md.orbit.yaw, md.orbit.pitch); return [W / 2 + scale * r[0], H / 2 - scale * r[1]]; };

  // Segment-Pfade
  ctx.lineWidth = 2;
  for (const c of md.segments) {
    ctx.strokeStyle = 'rgba(54,198,255,0.7)'; ctx.beginPath();
    c.samples.forEach((s, i) => { const q = pr(s.pos); if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); });
    ctx.stroke();
    // Zentrum + Richtungsstrahl
    const oc = pr(c.center);
    ctx.fillStyle = '#36c6ff'; ctx.beginPath(); ctx.arc(oc[0], oc[1], 4, 0, TWO_PI); ctx.fill();
    const end = [c.center[0] + c.dir[0] * ext, c.center[1] + c.dir[1] * ext, c.center[2] + c.dir[2] * ext];
    const oe = pr(end);
    ctx.strokeStyle = `rgba(255,180,80,${0.4 + 0.5 * c.coh})`;
    ctx.beginPath(); ctx.moveTo(oc[0], oc[1]); ctx.lineTo(oe[0], oe[1]); ctx.stroke();
  }
  // Quellpunkt + Unsicherheitsachsen
  if (md.source) {
    const sp = pr(md.source.point);
    ctx.fillStyle = '#19e36a'; ctx.beginPath(); ctx.arc(sp[0], sp[1], 7, 0, TWO_PI); ctx.fill();
    ctx.strokeStyle = 'rgba(25,227,106,0.6)'; ctx.lineWidth = 1.5;
    for (const ax of md.source.axes) {
      const L = Math.min(ext, Math.max(0.05, ax.len)) * 1; // 1σ
      const a = pr([md.source.point[0] - ax.dir[0] * L, md.source.point[1] - ax.dir[1] * L, md.source.point[2] - ax.dir[2] * L]);
      const b = pr([md.source.point[0] + ax.dir[0] * L, md.source.point[1] + ax.dir[1] * L, md.source.point[2] + ax.dir[2] * L]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
  }
  // aktuelle Pose
  if (md.posePos) { const q = pr(md.posePos); ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(q[0], q[1], 5, 0, TWO_PI); ctx.fill(); }
}

/* ---------- HUD ---------- */
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
// Quellpunkt in Kamerakoordinaten (Blick = -Z, oben = +Y)
function eyeCoords(p) {
  const vm = md.viewMat; if (!vm) return null;
  return [
    vm[0] * p[0] + vm[4] * p[1] + vm[8] * p[2] + vm[12],
    vm[1] * p[0] + vm[5] * p[1] + vm[9] * p[2] + vm[13],
    vm[2] * p[0] + vm[6] * p[1] + vm[10] * p[2] + vm[14],
  ];
}
function updateHud() {
  const now = performance.now();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  // Ampel: VIO-Fehler über Apertur (~3 cm) vs λ/8
  const lambda = C_SOUND / md.freq, budget = lambda / 8, vioErr = 0.03;
  const amp = vioErr <= budget * 0.7 ? '🟢' : vioErr <= budget ? '🟡' : '🔴';
  set('md-budget', `${amp} λ/8=${(budget * 100).toFixed(1)}cm · VIO~${(vioErr * 100).toFixed(0)}cm · Lat ${md.audioLatency.toFixed(0)}ms`);
  set('md-circles', String(md.segments.length));
  // Bewegungs-Güte + konkreter Hinweis, was gerade fehlt
  const gPct = (md.goodness * 100).toFixed(0) + ' %';
  let gHint = '';
  if (md.scanning) {
    if (md.moveTone < 0.2) gHint = ' · Zielton fehlt';
    else if (md.moveSpan < 0.25 * (C_SOUND / md.freq)) gHint = ' · mehr bewegen';
    else if (md.goodness > 0.5) gHint = ' · gut ✓';
  }
  set('md-move', md.scanning ? gPct + gHint : 'pausiert');
  // Basislinie zwischen Segment-Zentren
  let baseline = 0;
  for (let i = 0; i < md.segments.length; i++) for (let j = i + 1; j < md.segments.length; j++) baseline = Math.max(baseline, dist(md.segments[i].center, md.segments[j].center));
  set('md-baseline', baseline.toFixed(2) + ' m');
  if (md.source) {
    let r = 0, c = 0; for (const cc of md.segments) { r += dist(md.source.point, cc.center); c++; }
    r = c ? r / c : 0;
    set('md-dist', r.toFixed(1) + ' m · Tiefe ±' + md.source.depthSigma.toFixed(1) + ' m');
    const cohAvg = md.segments.reduce((a, x) => a + x.coh, 0) / md.segments.length;
    set('md-coh', (cohAvg * 100).toFixed(0) + ' %');
    // Lage des Quellpunkts relativ zur aktuellen Blickrichtung (Diagnose)
    const e = eyeCoords(md.source.point);
    if (e) {
      const d = Math.hypot(e[0], e[1], e[2]);
      const front = e[2] < 0;
      const hAng = Math.atan2(e[0], -e[2]) * 180 / Math.PI; // + = rechts
      const vAng = Math.atan2(e[1], Math.hypot(e[0], e[2])) * 180 / Math.PI; // + = oben
      const hTxt = Math.abs(hAng) < 8 ? 'mittig' : (hAng > 0 ? hAng.toFixed(0) + '° rechts' : (-hAng).toFixed(0) + '° links');
      const vTxt = Math.abs(vAng) < 8 ? '' : (vAng > 0 ? ' · ' + vAng.toFixed(0) + '° hoch' : ' · ' + (-vAng).toFixed(0) + '° runter');
      set('md-src', `${d.toFixed(1)} m · ${front ? 'vorne' : 'HINTER dir'} · ${hTxt}${vTxt}`);
    } else set('md-src', '–');
  } else { set('md-dist', '–'); set('md-coh', '–'); set('md-src', '–'); }
  // Konditionierungs-Warnung
  const warn = [];
  if (md.source) { let r = 0, c = 0; for (const cc of md.segments) { r += dist(md.source.point, cc.center); c++; } r = c ? r / c : 0; if (baseline < 0.4 * r) warn.push('Basislinie zu klein – auch den Standort wechseln'); }
  if (md.segments.length < 2) warn.push('≥ 2 Segmente nötig für einen Punkt – frei bewegen');
  set('md-warn', warn.join(' · '));
  const statusIdle = md.scanning ? 'Suche läuft – frei bewegen' : 'pausiert';
  set('md-status', now < statusUntil ? statusMsg : statusIdle);
}

/* ---------- Inspector-Orbit-Eingabe ---------- */
function bindOrbit(cv) {
  const o = md.orbit;
  const pos = (e) => ({ x: e.clientX, y: e.clientY });
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); o.ptr.set(e.pointerId, pos(e)); });
  cv.addEventListener('pointermove', (e) => {
    if (!o.ptr.has(e.pointerId)) return;
    const prev = o.ptr.get(e.pointerId), cur = pos(e); o.ptr.set(e.pointerId, cur);
    if (o.ptr.size === 1) { o.yaw -= (cur.x - prev.x) * 0.01; o.pitch = Math.max(-1.5, Math.min(1.5, o.pitch - (cur.y - prev.y) * 0.01)); }
    else { const p = [...o.ptr.values()]; const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); if (o.lastPinch) o.zoom = Math.max(0.2, Math.min(8, o.zoom * d / o.lastPinch)); o.lastPinch = d; }
  });
  const end = (e) => { o.ptr.delete(e.pointerId); o.lastPinch = 0; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}

/* ---------- Öffentliche Anbindung ---------- */
export function initModeD() {
  const startBtn = document.getElementById('btn-start-d');
  if (!startBtn) return;
  // Verfügbarkeit prüfen -> Button (de)aktivieren
  xrSupported().then((ok) => {
    if (!ok) { startBtn.disabled = true; startBtn.textContent = '🛰️ Modus D (WebXR-AR nicht verfügbar)'; }
  });
  startBtn.addEventListener('click', startModeD);
  document.getElementById('md-capture').addEventListener('click', togglePause);
  document.getElementById('md-reset').addEventListener('click', resetD);
  document.getElementById('md-close').addEventListener('click', () => { if (md.session) md.session.end(); });
  const insBtn = document.getElementById('md-3d');
  insBtn.addEventListener('click', () => {
    md.inspector = !md.inspector;
    document.getElementById('md-inspector').classList.toggle('hidden', !md.inspector);
    insBtn.classList.toggle('armed', md.inspector);
  });
  document.getElementById('md-freq').addEventListener('input', (e) => { md.freq = parseFloat(e.target.value) || 1200; if (md.tone) md.tone.setFreq(md.freq); resetD(); });
  bindOrbit(document.getElementById('md-inspector'));
}

async function startModeD() {
  const err = document.getElementById('md-error');
  err.textContent = '';
  document.getElementById('gate').classList.add('hidden');
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('modeD').classList.remove('hidden');
  md.arCtx = document.getElementById('md-ar').getContext('2d');
  md.inCtx = document.getElementById('md-inspector').getContext('2d');
  // Inspector-State explizit zurücksetzen (persistiert sonst über Sessions)
  md.inspector = false;
  document.getElementById('md-inspector').classList.add('hidden');
  document.getElementById('md-3d').classList.remove('armed');
  try {
    md.freq = parseFloat(document.getElementById('md-freq').value) || 1200;
    md.tone = new CoherentTone();
    md.tone.onWindow = onAudioWindow;
    await md.tone.start(md.freq, null);   // internes Handy-Mikro (bewegtes Array)
    md.audioLatency = md.tone.getLatencyMs();
    await startSession();                 // WebXR/ARCore
    resetD();
    md.scanning = true;
    const capBtn = document.getElementById('md-capture');
    capBtn.textContent = 'Pause'; capBtn.classList.remove('armed');
    setStatus('Suche läuft – Handy einfach frei bewegen (grün = gute Daten)');
  } catch (e) {
    console.error(e);
    if (md.tone) { md.tone.stop(); md.tone = null; }
    document.getElementById('modeD').classList.add('hidden');
    document.getElementById('gate').classList.remove('hidden');
    err.textContent = 'Start fehlgeschlagen: ' + ((e && e.message) || 'WebXR-AR (ARCore) nötig, nur Android/Chrome.');
    document.getElementById('gate-error').textContent = err.textContent;
  }
}
