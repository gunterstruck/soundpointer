/*
 * SoundPointer – Modus D: VIO-gestütztes virtuelles Array + Triangulation
 * ------------------------------------------------------------------
 * Position der virtuellen Mikrofone kommt aus WebXR/ARCore-Pose (NICHT aus
 * Beschleunigungs-Integration). Pro geführtem Kreis (~5 s) entsteht aus
 * VIO-Positionen + kohärenten Phasen eine Richtungsschätzung (Beamforming via
 * lineare Kleinste-Quadrate auf die ebene-Wellen-Hypothese). Aus 2–4 Kreisen
 * von verschiedenen Standorten wird per Strahlenschnitt (Triangulation) ein
 * Quellpunkt + Unsicherheits-Ellipsoid geschätzt und als persistenter Marker
 * gehalten. AR-Overlay + frei drehbare 3D-Ansicht.
 *
 * Android-only (Chrome, WebXR immersive-ar / ARCore).
 */

'use strict';

import { CoherentTone } from './coherent.js';

const C_SOUND = 343;
const TWO_PI = Math.PI * 2;
const MEAS_MS = 5000;        // Dauer eines Kreises
const MID_LO = 1500, MID_HI = 4200; // Mittelbogen-Fenster (ms ab Kreisstart)
const MIN_SAMPLES = 12;
const TARGET_CIRCLES = 3;

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
  phase: 'idle',          // 'idle' | 'countdown' | 'measuring'
  countdownEnd: 0,
  measEndT: 0, measStartT: 0,
  cur: null,              // aktuelle Kreismessung: { samples:[{t,pos,phase,amp,snr}] }
  circles: [],            // [{ center, dir, coh, sigTheta, deltaF, samples }]
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
  // Mess-Timing
  const now = performance.now();
  if (md.phase === 'countdown' && now >= md.countdownEnd) {
    md.cur = { samples: [] };
    md.phase = 'measuring';
    md.measStartT = now;
    md.measEndT = now + MEAS_MS;
  }
  if (md.phase === 'measuring' && now >= md.measEndT) finishCircle();
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

/* ---------- Audio-Sample-Erfassung ---------- */
function onAudioWindow(wnd) {
  if (md.phase !== 'measuring' || !md.cur) return;
  // Audio-Aufnahmezeit = Callback-Zeit minus geschätzte Eingangslatenz
  const tAudio = wnd.t - md.audioLatency;
  const pos = interpolatePose(tAudio);
  if (!pos) return;
  md.cur.samples.push({ t: wnd.t, pos: pos.slice(), phase: wnd.phase, amp: wnd.amp, snr: wnd.snr });
}

/* ---------- Pro Kreis: Richtungsschätzung ---------- */
function fitDirection(samplesAll) {
  const t0 = md.measStartT;
  const s = samplesAll.filter((x) => (x.t - t0) >= MID_LO && (x.t - t0) <= MID_HI);
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
  const cs = md.circles.filter((c) => c && c.dir && c.coh > 0.1);
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

/* ---------- Messablauf ---------- */
function startCircle() {
  if (!md.session) return;
  md.phase = 'countdown';
  md.countdownEnd = performance.now() + 3000; // 3-Sek-Vorlauf
  md.cur = null;
}
function finishCircle() {
  md.phase = 'idle';
  const fit = md.cur ? fitDirection(md.cur.samples) : null;
  if (fit) {
    fit.samples = md.cur.samples; md.circles.push(fit); triangulate();
    const dfStr = Math.abs(fit.deltaF) < 5 ? (fit.deltaF > 0 ? '+' : '') + fit.deltaF.toFixed(2) + ' Hz Drift' : '⚠ Δf=' + fit.deltaF.toFixed(1) + ' Hz';
    setStatus('Kreis ' + md.circles.length + ' ok · ' + dfStr + ' · Standort wechseln');
  } else setStatus('Kreis verworfen (instabiles Signal oder |k|-Plausibilität) – wiederholen');
  md.cur = null;
}
function resetD() { md.circles = []; md.source = null; md.cur = null; md.phase = 'idle'; md.countdownEnd = 0; md.poseHistory = []; setStatus('zurückgesetzt'); }

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

  // Vorbereitungs-Countdown (3-2-1)
  if (md.phase === 'countdown') {
    const remain = Math.ceil((md.countdownEnd - performance.now()) / 1000);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(W / 2 - 90, H / 2 - 80, 180, 130);
    ctx.fillStyle = 'rgba(255,180,80,0.97)'; ctx.font = '700 96px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(remain, W / 2, H / 2 + 30);
    ctx.font = '16px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText('Kreis vorbereiten …', W / 2, H / 2 + 70);
    ctx.textAlign = 'start';
  }
  // Guidance-Kreis + Countdown während der Messung
  if (md.phase === 'measuring') {
    const remain = (md.measEndT - performance.now()) / 1000;
    ctx.strokeStyle = 'rgba(54,198,255,0.8)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.min(W, H) * 0.28, 0, TWO_PI); ctx.stroke();
    ctx.fillStyle = 'rgba(54,198,255,0.95)'; ctx.font = '700 64px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(Math.ceil(remain), W / 2, H / 2 + 20);
    ctx.font = '15px -apple-system, sans-serif';
    ctx.fillText('im Kreis bewegen (Ø ~0,5 m)', W / 2, H / 2 + 60);
    ctx.textAlign = 'start';
  }
  // Quellpunkt
  if (md.source) {
    const proj = projectWorld(md.source.point, W, H);
    if (proj) {
      ctx.strokeStyle = 'rgba(25,227,106,0.95)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(proj.x, proj.y, 26, 0, TWO_PI); ctx.stroke();
      ctx.fillStyle = 'rgba(25,227,106,0.95)';
      ctx.beginPath(); ctx.arc(proj.x, proj.y, 6, 0, TWO_PI); ctx.fill();
      ctx.font = '13px -apple-system, sans-serif';
      ctx.fillText('Quelle ±' + md.source.depthSigma.toFixed(1) + ' m', proj.x + 32, proj.y + 4);
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
  for (const c of md.circles) for (const s of c.samples) pts.push(s.pos);
  for (const c of md.circles) pts.push(c.center);
  if (md.source) pts.push(md.source.point);
  if (md.posePos) pts.push(md.posePos);
  if (!pts.length) return;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i]; }
  const ctr = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 0.5);
  const scale = (0.4 * Math.min(W, H) / ext) * md.orbit.zoom;
  const pr = (p) => { const r = rot(sub(p, ctr), md.orbit.yaw, md.orbit.pitch); return [W / 2 + scale * r[0], H / 2 - scale * r[1]]; };

  // Kreis-Pfade
  ctx.lineWidth = 2;
  for (const c of md.circles) {
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
function updateHud() {
  const now = performance.now();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  // Ampel: VIO-Fehler über Apertur (~3 cm) vs λ/8
  const lambda = C_SOUND / md.freq, budget = lambda / 8, vioErr = 0.03;
  const amp = vioErr <= budget * 0.7 ? '🟢' : vioErr <= budget ? '🟡' : '🔴';
  set('md-budget', `${amp} λ/8=${(budget * 100).toFixed(1)}cm · VIO~${(vioErr * 100).toFixed(0)}cm · Lat ${md.audioLatency.toFixed(0)}ms`);
  set('md-circles', md.circles.length + ' / ' + TARGET_CIRCLES);
  // Basislinie zwischen Kreiszentren
  let baseline = 0;
  for (let i = 0; i < md.circles.length; i++) for (let j = i + 1; j < md.circles.length; j++) baseline = Math.max(baseline, dist(md.circles[i].center, md.circles[j].center));
  set('md-baseline', baseline.toFixed(2) + ' m');
  if (md.source) {
    let r = 0, c = 0; for (const cc of md.circles) { r += dist(md.source.point, cc.center); c++; }
    r = c ? r / c : 0;
    set('md-dist', r.toFixed(1) + ' m · Tiefe ±' + md.source.depthSigma.toFixed(1) + ' m');
    const cohAvg = md.circles.reduce((a, x) => a + x.coh, 0) / md.circles.length;
    set('md-coh', (cohAvg * 100).toFixed(0) + ' %');
  } else { set('md-dist', '–'); set('md-coh', '–'); }
  // Konditionierungs-Warnung
  const warn = [];
  if (md.source) { let r = 0, c = 0; for (const cc of md.circles) { r += dist(md.source.point, cc.center); c++; } r = c ? r / c : 0; if (baseline < 0.4 * r) warn.push('Basislinie zu klein – weiter versetzt messen'); }
  if (md.circles.length < 2) warn.push('≥ 2 Kreise nötig für einen Punkt');
  set('md-warn', warn.join(' · '));
  const statusIdle = md.phase === 'countdown' ? 'Vorbereitung …' : md.phase === 'measuring' ? 'Messung läuft …' : 'bereit – „Kreis aufnehmen"';
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
  document.getElementById('md-capture').addEventListener('click', () => { if (md.phase === 'idle') startCircle(); });
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
    setStatus('Session aktiv – Kreis 1 aufnehmen');
  } catch (e) {
    console.error(e);
    if (md.tone) { md.tone.stop(); md.tone = null; }
    document.getElementById('modeD').classList.add('hidden');
    document.getElementById('gate').classList.remove('hidden');
    err.textContent = 'Start fehlgeschlagen: ' + ((e && e.message) || 'WebXR-AR (ARCore) nötig, nur Android/Chrome.');
    document.getElementById('gate-error').textContent = err.textContent;
  }
}
