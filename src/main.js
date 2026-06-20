/*
 * SoundPointer – Milestone 1: Sensorstabile AR-Markierung
 * ------------------------------------------------------------------
 * Ziel: Validierung der räumlichen Orientierung. Der Benutzer tippt auf
 * das Kamerabild; statt der Bildschirmkoordinate wird die zugehörige
 * RAUMRICHTUNG (Azimut / Elevation) gespeichert. Dreht sich das Gerät
 * weg, verschwindet der Marker; beim Zurückdrehen erscheint er wieder an
 * derselben realen Position.
 *
 * Funktionsweise:
 *   1. Die Geräteorientierung (alpha/beta/gamma + Bildschirmwinkel) wird
 *      in ein Quaternion umgerechnet, das die Blickrichtung der Kamera im
 *      Weltkoordinatensystem beschreibt (Y = oben/Schwerkraft).
 *   2. Ein Tipp wird über das geschätzte Sichtfeld (FOV) in einen
 *      Strahl im Kamerakoordinatensystem umgewandelt und mit dem
 *      Quaternion in eine Weltrichtung transformiert -> Azimut/Elevation.
 *   3. Zum Rendern wird die gespeicherte Weltrichtung mit dem invertierten
 *      aktuellen Quaternion zurück ins Kamerakoordinatensystem projiziert
 *      und auf den Bildschirm abgebildet.
 *
 * Audio wird in diesem Meilenstein bewusst NICHT verwendet.
 */

'use strict';

import './style.css';
import { View3D } from './view3d.js';
import { TargetTone } from './audio.js';
import { LevelMeter } from './audioLevel.js';
import { initModeD } from './modeD.js';

/* ============================================================= *
 *  Minimale Vektor-/Quaternion-Mathematik
 * ============================================================= */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// Quaternion als [x, y, z, w]
const Quat = {
  identity() { return [0, 0, 0, 1]; },

  // Multiplikation a * b
  multiply(a, b) {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },

  fromAxisAngle(ax, ay, az, angle) {
    const h = angle / 2;
    const s = Math.sin(h);
    return [ax * s, ay * s, az * s, Math.cos(h)];
  },

  // Euler-Reihenfolge 'YXZ' (entspricht der Geräteorientierung, siehe THREE.js)
  fromEulerYXZ(x, y, z) {
    const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
    const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
    const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
    return [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 - s1 * s2 * c3,
      c1 * c2 * c3 + s1 * s2 * s3,
    ];
  },

  conjugate(q) { return [-q[0], -q[1], -q[2], q[3]]; },

  // Rotiert Vektor v=[x,y,z] mit Quaternion q
  rotateVec(q, v) {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    // v + qw * t + cross(q.xyz, t)
    return [
      vx + qw * tx + (qy * tz - qz * ty),
      vy + qw * ty + (qz * tx - qx * tz),
      vz + qw * tz + (qx * ty - qy * tx),
    ];
  },
};

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

// Winkel (Grad) zwischen zwei Orientierungs-Quaternionen.
function quatAngleDeg(a, b) {
  let d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  d = Math.min(1, d);
  return 2 * Math.acos(d) * RAD;
}

/* ============================================================= *
 *  Geräteorientierung -> Quaternion (Kamera-Blickrichtung)
 * ============================================================= */

// -90° um die X-Achse: Kamera blickt aus der Rückseite, nicht aus der Oberkante.
const Q_SCREEN_TO_CAMERA = Quat.fromAxisAngle(1, 0, 0, -Math.PI / 2);

/**
 * Liefert ein Quaternion, das ein Objekt (Kamera, Blick entlang -Z) so
 * ausrichtet, dass es der Geräteorientierung entspricht.
 */
function deviceQuaternion(alpha, beta, gamma, screenAngle) {
  const e = Quat.fromEulerYXZ(beta * DEG, alpha * DEG, -gamma * DEG);
  let q = Quat.multiply(e, Q_SCREEN_TO_CAMERA);
  // Bildschirmrotation (Hoch-/Querformat) kompensieren – Drehung um Z (Welt-Up nach q1)
  q = Quat.multiply(q, Quat.fromAxisAngle(0, 0, 1, -screenAngle * DEG));
  return q;
}

/**
 * Geräte-zu-Welt-Orientierung für die Beschleunigung. Nutzt DIESELBE
 * -90°-x-Korrektur (Q_SCREEN_TO_CAMERA) wie die Marker-Richtung, damit Pfad
 * und Marker im gleichen Weltkoordinatensystem liegen. KEINE Bildschirm-
 * Rotation, da die Beschleunigung im Geräte- und nicht im Bildschirm-Frame
 * geliefert wird.
 */
function deviceWorldQuaternion(alpha, beta, gamma) {
  const e = Quat.fromEulerYXZ(beta * DEG, alpha * DEG, -gamma * DEG);
  return Quat.multiply(e, Q_SCREEN_TO_CAMERA);
}

/* ============================================================= *
 *  Welt-Richtung  <->  Azimut / Elevation
 * ============================================================= *
 *  Weltkoordinaten (nach obiger Transformation): Y zeigt nach oben.
 *  azimuth  = Drehung in der horizontalen Ebene
 *  elevation = Winkel über/unter dem Horizont
 */

function vectorToSpherical(v) {
  const [x, y, z] = normalize3(v);
  const elevation = Math.asin(Math.max(-1, Math.min(1, y))) * RAD;
  let azimuth = Math.atan2(x, -z) * RAD; // -Z = "vorne" bei neutraler Haltung
  if (azimuth < 0) azimuth += 360;
  return { azimuth, elevation };
}

function sphericalToVector(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  const cosEl = Math.cos(el);
  return [
    cosEl * Math.sin(az),   // x
    Math.sin(el),           // y (oben)
    -cosEl * Math.cos(az),  // z (-z = vorne)
  ];
}

/* ============================================================= *
 *  Sichtfeld (FOV)
 * ============================================================= *
 *  Das genaue FOV ist für die Wiederauffindbarkeit unkritisch: Bei
 *  identischer Orientierung kürzt es sich beim Setzen/Rendern heraus.
 *  Es beeinflusst nur die Genauigkeit während der Drehung. Ein
 *  realistischer Standardwert genügt für Milestone 1.
 */
const HFOV_DEG = 65; // horizontales Sichtfeld der Rückkamera (Schätzwert)

function getFov() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // tan der halben Winkel pro Achse
  const tanX = Math.tan((HFOV_DEG * DEG) / 2);
  // vertikal anhand des Seitenverhältnisses ableiten
  const tanY = tanX * (h / w);
  return { w, h, tanX, tanY };
}

/* Bildschirmpunkt (px) -> Strahl im Kamerakoordinatensystem (-Z = vorne) */
function screenToCameraRay(px, py) {
  const { w, h, tanX, tanY } = getFov();
  const ndcX = (px / w) * 2 - 1;        // rechts positiv
  const ndcY = -((py / h) * 2 - 1);     // oben positiv
  return normalize3([ndcX * tanX, ndcY * tanY, -1]);
}

/* Strahl im Kamerakoordinatensystem -> Bildschirmpunkt (oder null, wenn hinten/außerhalb) */
function cameraRayToScreen(dir) {
  const { w, h, tanX, tanY } = getFov();
  if (dir[2] >= 0) return null; // hinter der Kamera
  const ndcX = (dir[0] / -dir[2]) / tanX;
  const ndcY = (dir[1] / -dir[2]) / tanY;
  const px = (ndcX + 1) * 0.5 * w;
  const py = (1 - ndcY) * 0.5 * h;
  return { px, py, ndcX, ndcY };
}

/* ============================================================= *
 *  App-Zustand
 * ============================================================= */

const state = {
  alpha: 0, beta: 0, gamma: 0,
  screenAngle: 0,
  hasOrientation: false,
  isAbsolute: false,
  lastAbsoluteT: 0,   // Zeitpunkt des letzten absoluten Orientierungsevents
  source: '–',
  quat: Quat.identity(),       // Kamera -> Welt (für die Darstellung)
  devQuat: Quat.identity(),    // Gerät  -> Welt (für die Beschleunigung)
  // Experimentelles 6DoF: Position des Handys relativ zum Startpunkt (Kugelmittelpunkt),
  // durch doppelte Integration der Beschleunigung. WARNUNG: driftet (siehe Debug).
  position: [0, 0, 0],         // Meter
  velocity: [0, 0, 0],         // m/s
  hasMotion: false,
  motionSupported: false,
  gravityFree: false,          // liefert das Gerät schwerkraftfreie Beschleunigung?
  accMag: 0,                   // aktueller Betrag |a| (m/s²) – zur Überprüfung
  motionHz: 0,                 // gemessene Lieferrate des Beschleunigungssensors (Hz)
  motionInterval: 0,           // gemeldetes Sample-Intervall (ms)
  motionSource: 'DeviceMotion',// 'Sensor-API 60Hz' oder 'DeviceMotion'
  lastMotionT: 0,
  stillTime: 0,                // wie lange die Beschleunigung schon klein ist (s)
  zupt: false,                 // Stillstand erkannt -> Geschwindigkeit genullt
  // Kalibrierung: gemittelter Sensor-Offset (Bias) bei stillem Handy.
  accBias: [0, 0, 0],
  calibrating: false,
  calSamples: [],
  calEndT: 0,
  markers: [],   // { id, pos:[x,y,z], azimuth, elevation, timestamp, el(DOM) }
  nextId: 1,
  // Aufgezeichneter Weg des Handys (Trajektorie) für die 3D-Ansicht / spätere Array-Verarbeitung.
  path: [],      // [{ t, p:[x,y,z] }]
  lastPathT: 0,
  recording: true, // zeichnet der Pfad gerade auf? (nach einer Messung eingefroren)
  // Geführte Messung + Drift-Korrektur (Loop Closure).
  measuring: false,
  measEndT: 0,
  correctedPath: [], // [[x,y,z]] nach Drift-Korrektur
  closeError: 0,     // Schließfehler |Ende - Start| (m)
  startFrame: null,  // Kamerabild am Start der Messung
  endFrame: null,    // Kamerabild am Ende
  frameMatch: 0,     // Bildähnlichkeit Start↔Ende (-1..1)
  startQuat: null,   // Blickrichtung am Start
  endQuat: null,     // Blickrichtung am Ende
  orientDelta: 0,    // Winkelunterschied Start↔Ende (Grad)
  orientFit: false,  // Orientierung am Ende ~ wie am Start?
  positionFrozen: false, // Positions-Integration nach der Messung pausiert?
  view: 'ar',    // 'ar' | '3d'
  parallax: false, // Marker mit Positions-Parallaxe (6DoF) statt reiner Richtung (3DoF)?
  modeB: false,  // Variante-B-Modus aktiv?
  showDebug: true,
  running: false,
  sensorsInitialized: false,
  absoluteSupported: false,
  stream: null,
};

/* --- Parameter für das Positions-Experiment (zum Tunen) --- */
const MARKER_RADIUS = 2.0;   // angenommene Entfernung des Markers (Meter)
const ACC_DEADZONE = 0.02;   // Beschleunigung darunter wird als 0 gewertet (m/s²) – klein halten,
                             // damit langsame/kleine Bewegungen erfasst werden (Kompromiss mit Drift)
const VEL_TAU = 0.5;         // Zeitkonstante der Geschwindigkeits-Dämpfung (s);
                             // kleiner = stärker bremsen (gegen Rest-Geschwindigkeit/Weglaufen)
const MAX_DT = 0.05;         // max. Zeitschritt pro Sample (s), gegen Sprünge
const PATH_INTERVAL = 33;    // Abtastrate des Wegs (ms) ~30 Hz
const PATH_MAX = 6000;       // max. gespeicherte Wegpunkte (Ringpuffer)
const ZUPT_ACC = 0.10;       // Beschleunigung darunter gilt als "ruhig" (m/s²)
const ZUPT_HOLD = 0.20;      // so lange ruhig -> Geschwindigkeit nullen (s)
const MEAS_DURATION = 5;     // Dauer der geführten Messung (s)
const ORIENT_FIT_DEG = 12;   // max. Winkelunterschied Start↔Ende für "Fit" (Grad)

/* ============================================================= *
 *  Kamera
 * ============================================================= */

async function startCamera(video) {
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' }, // rückseitige Kamera
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.stream = stream;
  video.srcObject = stream;
  await video.play().catch(() => {});
  return stream;
}

function stopCamera(video) {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  if (video) video.srcObject = null;
}

/* ============================================================= *
 *  Sensoren
 * ============================================================= */

function updateScreenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') {
    state.screenAngle = screen.orientation.angle;
  } else if (typeof window.orientation === 'number') {
    state.screenAngle = window.orientation;
  } else {
    state.screenAngle = 0;
  }
}

function onOrientation(ev, absolute) {
  if (ev.alpha == null && ev.beta == null && ev.gamma == null) return;

  const eventIsAbsolute = absolute || ev.absolute === true;
  const now = performance.now();

  // Absolute Orientierung (Magnetometer) ist autoritativ. Ein relatives Event
  // darf eine kürzlich erhaltene absolute Orientierung NICHT überschreiben.
  if (eventIsAbsolute) {
    state.lastAbsoluteT = now;
    state.isAbsolute = true;
    state.source = 'Magnetometer (absolut)';
  } else {
    if (now - state.lastAbsoluteT < 1500) return; // absolute liegt vor -> relatives ignorieren
    if (!state.isAbsolute) state.source = 'Gyroskop (relativ)';
  }

  state.alpha = ev.alpha || 0;
  state.beta = ev.beta || 0;
  state.gamma = ev.gamma || 0;

  state.quat = deviceQuaternion(state.alpha, state.beta, state.gamma, state.screenAngle);
  state.devQuat = deviceWorldQuaternion(state.alpha, state.beta, state.gamma);
  state.hasOrientation = true;
}

// Gemeinsame Verarbeitung einer Beschleunigungsmessung (Geräteachsen, m/s²).
// gravityFree = true: Schwerkraft bereits entfernt (für Positionsintegration nutzbar).
function processAccel(ax, ay, az, gravityFree, intervalMs) {
  // Tatsächliche Sensorrate messen.
  const tnow = performance.now();
  state._hzCount = (state._hzCount || 0) + 1;
  if (!state._hzT) state._hzT = tnow;
  if (tnow - state._hzT >= 1000) {
    state.motionHz = (state._hzCount * 1000) / (tnow - state._hzT);
    state._hzCount = 0; state._hzT = tnow;
  }
  if (intervalMs) state.motionInterval = intervalMs;

  state.motionSupported = true;
  if (!gravityFree) {
    // Werte enthalten die Schwerkraft -> Position nicht zuverlässig trackbar.
    state.gravityFree = false;
    state.accMag = Math.hypot(ax, ay, az);
    return;
  }
  state.gravityFree = true;
  state.hasMotion = true;

  const raw = [ax, ay, az];
  state.accMag = Math.hypot(raw[0], raw[1], raw[2]); // sollte bei Ruhe ~0 sein

  // Kalibrierung: bei stillem Handy Messwerte sammeln -> Mittelwert = Bias.
  if (state.calibrating) {
    state.calSamples.push(raw);
    state.lastMotionT = performance.now();
    if (performance.now() >= state.calEndT) finishCalibration();
    return; // während der Kalibrierung nicht integrieren
  }

  // Nach einer Messung ist die Position eingefroren (kein Weiterdriften).
  if (state.positionFrozen) {
    state.lastMotionT = performance.now();
    return;
  }

  const now = performance.now();
  let dt = state.lastMotionT ? (now - state.lastMotionT) / 1000 : 0;
  state.lastMotionT = now;
  if (dt <= 0) return;
  if (dt > MAX_DT) dt = MAX_DT;

  // Bias abziehen (Vorzeichen bleibt erhalten!).
  const b = state.accBias;
  const corr = [raw[0] - b[0], raw[1] - b[1], raw[2] - b[2]];
  const corrMag = Math.hypot(corr[0], corr[1], corr[2]);

  // ZUPT (Zero-Velocity Update): bleibt die Beschleunigung lange genug klein,
  // steht das Handy -> Geschwindigkeit auf 0 zwingen.
  if (corrMag < ZUPT_ACC) state.stillTime += dt; else state.stillTime = 0;
  state.zupt = state.stillTime >= ZUPT_HOLD;

  // Totzone (nur kleine Rest-Rausch-Werte auf 0), Vorzeichen bleibt erhalten.
  const dz = (v) => (Math.abs(v) < ACC_DEADZONE ? 0 : v);
  const aDev = [dz(corr[0]), dz(corr[1]), dz(corr[2])];

  // In Weltkoordinaten drehen, doppelt integrieren, Geschwindigkeit dämpfen.
  const damp = Math.exp(-dt / VEL_TAU);
  const aW = Quat.rotateVec(state.devQuat, aDev);
  for (let i = 0; i < 3; i++) {
    state.position[i] += state.velocity[i] * dt + 0.5 * aW[i] * dt * dt;
    state.velocity[i] = (state.velocity[i] + aW[i] * dt) * damp;
  }
  if (state.zupt) state.velocity = [0, 0, 0];
}

// Fallback-Quelle: DeviceMotionEvent (z. B. iOS Safari). Rate ~60 Hz, vom Browser gedeckelt.
function onMotion(ev) {
  const acc = ev.acceleration;                  // OHNE Schwerkraft (vom OS entfernt)
  const accG = ev.accelerationIncludingGravity; // MIT Schwerkraft (roh)
  if (acc && (acc.x != null || acc.y != null || acc.z != null)) {
    processAccel(acc.x || 0, acc.y || 0, acc.z || 0, true, ev.interval || 0);
  } else if (accG && (accG.x != null || accG.y != null || accG.z != null)) {
    processAccel(accG.x || 0, accG.y || 0, accG.z || 0, false, ev.interval || 0);
  }
}

function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS
}

// Bevorzugte Quelle auf Nicht-iOS: Generic Sensor API mit EXPLIZIT 60 Hz,
// schwerkraftfrei. Fällt bei Fehlern/iOS auf DeviceMotionEvent zurück.
let accelSensor = null;
function startMotionSource() {
  if (!isIOS() && typeof window.LinearAccelerationSensor === 'function') {
    try {
      accelSensor = new LinearAccelerationSensor({ frequency: 60 });
      accelSensor.addEventListener('reading', () => {
        processAccel(accelSensor.x || 0, accelSensor.y || 0, accelSensor.z || 0, true, 1000 / 60);
      });
      accelSensor.addEventListener('error', (e) => {
        console.warn('LinearAccelerationSensor error:', e.error && e.error.name);
        accelSensor = null;
        state.motionSource = 'DeviceMotion';
        if (window.DeviceMotionEvent) window.addEventListener('devicemotion', onMotion);
      });
      accelSensor.start();
      state.motionSource = 'Sensor-API 60Hz';
      return;
    } catch (e) {
      console.warn('LinearAccelerationSensor unavailable:', e);
      accelSensor = null;
    }
  }
  // Fallback (iOS Safari oder keine Sensor-API)
  state.motionSource = 'DeviceMotion';
  if (window.DeviceMotionEvent) window.addEventListener('devicemotion', onMotion);
}

// Bias-Kalibrierung: 2 s lang stillhalten, Offset mitteln und künftig abziehen.
function startCalibration() {
  if (!('DeviceMotionEvent' in window)) {
    setStatus('Kein Bewegungssensor verfügbar.');
    return;
  }
  state.calibrating = true;
  state.calSamples = [];
  state.calEndT = performance.now() + 2000;
  setStatus('Kalibriere … Handy 2 s ruhig halten.');
}

function finishCalibration() {
  const n = state.calSamples.length;
  if (n > 0) {
    const sum = [0, 0, 0];
    for (const s of state.calSamples) { sum[0] += s[0]; sum[1] += s[1]; sum[2] += s[2]; }
    state.accBias = [sum[0] / n, sum[1] / n, sum[2] / n];
  }
  state.calibrating = false;
  state.calSamples = [];
  state.velocity = [0, 0, 0];
  state.position = [0, 0, 0];
  state.lastMotionT = 0;
  state.positionFrozen = false;
  const b = state.accBias;
  setStatus(`Kalibriert · Offset ${Math.hypot(b[0], b[1], b[2]).toFixed(3)} m/s² entfernt.`);
}

// Position & Geschwindigkeit auf 0 setzen ("Kugel" neu auf das Handy zentrieren).
// Marker behalten ihre relative Lage, indem sie um die alte Position verschoben werden.
function recenter() {
  const p = state.position;
  for (const m of state.markers) m.pos = sub3(m.pos, p);
  state.position = [0, 0, 0];
  state.velocity = [0, 0, 0];
  clearPath();
  state.correctedPath = [];
  state.closeError = 0;
  state.recording = true; // frische Live-Aufzeichnung
  state.positionFrozen = false;
  setStatus('Neu zentriert · Position auf 0 zurückgesetzt.');
}

async function initSensors() {
  updateScreenAngle();
  // Listener nur einmal registrieren (Start-Stopp-Stopp-Start darf nicht doppeln).
  if (state.sensorsInitialized) return state.absoluteSupported;

  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', updateScreenAngle);
  }
  window.addEventListener('orientationchange', updateScreenAngle);

  // iOS 13+ verlangt explizite Freigabe – für Orientierung UND Bewegung.
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    const res = await DOE.requestPermission();
    if (res !== 'granted') {
      throw new Error('Zugriff auf Bewegungssensoren verweigert.');
    }
  }
  const DME = window.DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === 'function') {
    try { await DME.requestPermission(); } catch (e) { /* optional */ }
  }

  // Absolute Orientierung bevorzugen, falls verfügbar.
  if ('ondeviceorientationabsolute' in window) {
    state.absoluteSupported = true;
    window.addEventListener('deviceorientationabsolute', (e) => onOrientation(e, true));
  }
  window.addEventListener('deviceorientation', (e) => onOrientation(e, false));

  // Bewegung: bevorzugt Generic Sensor API mit 60 Hz, sonst DeviceMotion (iOS).
  startMotionSource();

  state.sensorsInitialized = true;
  return state.absoluteSupported;
}

/* ============================================================= *
 *  Marker setzen / verwalten
 * ============================================================= */

function placeMarker(px, py) {
  if (!state.hasOrientation) return;
  // 1) Bildschirmpunkt -> Strahl im Kamerasystem
  const camRay = screenToCameraRay(px, py);
  // 2) Strahl -> Weltrichtung über aktuelles Quaternion
  const worldDir = Quat.rotateVec(state.quat, camRay);
  // 3) Richtung für die Debug-Anzeige
  const { azimuth, elevation } = vectorToSpherical(worldDir);
  // 4) 3D-Weltposition des Markers: aktuelle Handy-Position + Radius * Richtung.
  //    Dadurch bleibt der Punkt im Raum stehen und zeigt Parallaxe bei Bewegung.
  const pos = [
    state.position[0] + MARKER_RADIUS * worldDir[0],
    state.position[1] + MARKER_RADIUS * worldDir[1],
    state.position[2] + MARKER_RADIUS * worldDir[2],
  ];

  const el = document.createElement('div');
  el.className = 'marker';
  document.getElementById('markers').appendChild(el);

  state.markers.push({
    id: state.nextId++,
    pos,
    azimuth,
    elevation,
    timestamp: Date.now(),
    el,
  });
  setStatus(`Marker ${state.markers.length} gesetzt · Azimut ${azimuth.toFixed(1)}° · Elev ${elevation.toFixed(1)}°`);
}

function clearMarkers() {
  for (const m of state.markers) m.el.remove();
  state.markers.length = 0;
  setStatus('Alle Marker gelöscht.');
}

function clearPath() {
  state.path.length = 0;
  state.lastPathT = 0;
}

// Aktuelle Handy-Position zeitgetaktet in die Trajektorie schreiben (Ringpuffer).
function samplePath() {
  if (!state.hasMotion || !state.recording) return;
  const now = performance.now();
  if (state.lastPathT && now - state.lastPathT < PATH_INTERVAL) return;
  state.lastPathT = now;
  state.path.push({ t: now, p: state.position.slice() });
  if (state.path.length > PATH_MAX) state.path.shift();
}

/* ---- Geführte Messung mit Drift-Korrektur (Loop Closure) ---- */

// Aktuelles Kamerabild als Thumbnail (zum Anzeigen) + Graustufen-Array (zum Vergleich).
function captureFrame() {
  const video = document.getElementById('camera');
  if (!video || !video.videoWidth) return null;
  const tw = 160, th = Math.round((160 * video.videoHeight) / video.videoWidth) || 120;
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  c.getContext('2d').drawImage(video, 0, 0, tw, th);
  // Grobe Graustufen-Version (32xN) für die Ähnlichkeitsberechnung.
  const gw = 32, gh = Math.max(1, Math.round((32 * th) / tw));
  const gc = document.createElement('canvas');
  gc.width = gw; gc.height = gh;
  const gcx = gc.getContext('2d');
  gcx.drawImage(c, 0, 0, gw, gh);
  const px = gcx.getImageData(0, 0, gw, gh).data;
  const gray = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }
  return { canvas: c, gray };
}

// Normierte Kreuzkorrelation (-1..1): robust gegen Helligkeitsunterschiede.
function frameSimilarity(a, b) {
  if (!a || !b || a.gray.length !== b.gray.length) return 0;
  const n = a.gray.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a.gray[i]; mb += b.gray[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a.gray[i] - ma, db = b.gray[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return cov / (Math.sqrt(va * vb) || 1);
}

function startMeasurement() {
  if (!state.motionSupported) { setStatus('Kein Bewegungssensor verfügbar.'); return; }
  // Frisch zentrieren und Pfad/Korrektur zurücksetzen.
  recenter();
  state.correctedPath = [];
  state.closeError = 0;
  state.startFrame = captureFrame(); // Foto am Start
  state.endFrame = null;
  state.frameMatch = 0;
  state.startQuat = state.quat.slice(); // Blickrichtung am Start
  state.endQuat = null;
  state.orientDelta = 0;
  state.orientFit = false;
  state.positionFrozen = false;
  state.measuring = true;
  state.measEndT = performance.now() + MEAS_DURATION * 1000;
  document.getElementById('countdown').classList.remove('hidden');
}

// Pro Frame: Countdown anzeigen / Messfenster beenden.
function updateMeasurement() {
  if (!state.measuring) return;
  const remain = (state.measEndT - performance.now()) / 1000;
  const cd = document.getElementById('countdown');
  if (remain > 0) {
    const n = Math.ceil(remain);
    cd.querySelector('.cd-num').textContent = String(n);
    cd.querySelector('.cd-hint').textContent =
      remain <= MEAS_DURATION * 0.5 ? '… zurück zum Start' : 'im Kreis bewegen';
  } else {
    // Messfenster zu Ende -> automatisch stoppen, korrigieren, 3D-Ansicht öffnen.
    state.measuring = false;
    state.recording = false;
    cd.classList.add('hidden');
    finalizeMeasurement();
  }
}

// Drift linear über die Zeit verteilen (Annahme: Ende = Start) und 3D zeigen.
function finalizeMeasurement() {
  // Foto am Ende + Ähnlichkeit zum Startfoto (Gültigkeitsprüfung der Schleife).
  state.endFrame = captureFrame();
  state.frameMatch = frameSimilarity(state.startFrame, state.endFrame);
  // Orientierungs-Fit: Winkelunterschied der Blickrichtung Start↔Ende.
  state.endQuat = state.quat.slice();
  if (state.startQuat) {
    state.orientDelta = quatAngleDeg(state.startQuat, state.endQuat);
    state.orientFit = state.orientDelta <= ORIENT_FIT_DEG;
  }
  // Position einfrieren, damit "Versatz" nicht weiterdriftet.
  state.positionFrozen = true;

  const path = state.path;
  if (path.length >= 2) {
    const t0 = path[0].t, tN = path[path.length - 1].t;
    const span = (tN - t0) || 1;
    const start = path[0].p;
    const end = path[path.length - 1].p;
    const err = sub3(end, start); // aufsummierter Drift (Ende soll = Start sein)
    state.closeError = Math.hypot(err[0], err[1], err[2]);
    // korrigiert(i) = (p_i - start) - err * (t_i - t0)/span  -> Start und Ende bei 0
    state.correctedPath = path.map((s) => {
      const f = (s.t - t0) / span;
      return [
        s.p[0] - start[0] - err[0] * f,
        s.p[1] - start[1] - err[1] * f,
        s.p[2] - start[2] - err[2] * f,
      ];
    });
    setStatus(`Messung fertig · Schließfehler ${state.closeError.toFixed(2)} m über ${(span / 1000).toFixed(1)} s.`);
  } else {
    setStatus('Zu wenig Wegdaten für eine Korrektur.');
  }
  open3D();
}

// Kennzahlen des aufgezeichneten Wegs.
function pathStats() {
  const path = state.path;
  let duration = 0, length = 0;
  if (path.length >= 1) {
    duration = (path[path.length - 1].t - path[0].t) / 1000;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1].p, b = path[i].p;
      length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
  }
  const p = state.position;
  return { duration, length, dist: Math.hypot(p[0], p[1], p[2]) };
}

// Szene für das 3D-Modul.
function getScene() {
  const stats = pathStats();
  stats.closeError = state.closeError;
  return {
    path: state.path.map((s) => s.p),
    corrected: state.correctedPath,
    markers: state.markers.map((m) => m.pos),
    phone: state.position.slice(),
    stats,
    frames: (state.startFrame && state.endFrame)
      ? {
          start: state.startFrame.canvas, end: state.endFrame.canvas,
          match: state.frameMatch, orientDelta: state.orientDelta, fit: state.orientFit,
        }
      : null,
  };
}

/* ============================================================= *
 *  Render-Schleife: Marker projizieren bzw. 3D-Ansicht zeichnen
 * ============================================================= */

function render() {
  if (!state.running) return;
  samplePath();
  updateMeasurement();

  if (state.view === '3d') {
    if (view3d) view3d.draw(getScene());
    requestAnimationFrame(render);
    return;
  }

  const invQ = Quat.conjugate(state.quat); // Welt -> Kamera

  for (const m of state.markers) {
    // Standard: reine Richtung (3DoF) -> beim Kippen bleibt der Punkt fest.
    // Parallaxe-Modus (6DoF, experimentell): Richtung vom aktuellen Standort zum Marker.
    const worldVec = state.parallax
      ? sub3(m.pos, state.position)
      : sphericalToVector(m.azimuth, m.elevation);
    const camDir = Quat.rotateVec(invQ, worldVec);
    const proj = cameraRayToScreen(camDir);

    if (!proj) {
      m.el.style.opacity = '0';
      continue;
    }
    const { px, py, ndcX, ndcY } = proj;
    // Nur anzeigen, wenn innerhalb des sichtbaren Bereichs (mit kleiner Reserve).
    const visible = Math.abs(ndcX) <= 1.05 && Math.abs(ndcY) <= 1.05;
    m.el.style.opacity = visible ? '1' : '0';
    m.el.style.transform = `translate(${px}px, ${py}px)`;
  }

  updateDebug();
  requestAnimationFrame(render);
}

/* ============================================================= *
 *  Debug / Status
 * ============================================================= */

const dbg = {};
function cacheDom() {
  ['source', 'azimuth', 'pitch', 'roll', 'amag', 'rate', 'speed', 'pos', 'dist', 'time', 'count'].forEach((k) => {
    dbg[k] = document.getElementById('dbg-' + k);
  });
}

function updateDebug() {
  if (!state.showDebug) return;
  // Aktuelle Blickrichtung in Azimut/Elevation für die Anzeige.
  const fwd = Quat.rotateVec(state.quat, [0, 0, -1]);
  const { azimuth } = vectorToSpherical(fwd);
  dbg.source.textContent = state.source;
  dbg.azimuth.textContent = state.hasOrientation ? azimuth.toFixed(1) + '°' : '–';
  dbg.pitch.textContent = state.hasOrientation ? state.beta.toFixed(1) + '°' : '–';
  dbg.roll.textContent = state.hasOrientation ? state.gamma.toFixed(1) + '°' : '–';

  // Beschleunigungsbetrag + Schwerkraft-Status (zur Überprüfung).
  if (state.motionSupported) {
    const tag = state.gravityFree ? 'g-frei ✓' : 'mit g!';
    dbg.amag.textContent = state.accMag.toFixed(3) + ' m/s² · ' + tag;
    const src = state.motionSource === 'Sensor-API 60Hz' ? ' · API' : ' · DM';
    dbg.rate.textContent = state.motionHz ? state.motionHz.toFixed(0) + ' Hz' + src : '–';
  } else {
    dbg.amag.textContent = 'n/a';
    dbg.rate.textContent = 'n/a';
  }

  // Geschwindigkeit + ZUPT-Status (zur Beurteilung der Stillstandserkennung).
  if (state.motionSupported) {
    const v = state.velocity;
    const sp = Math.hypot(v[0], v[1], v[2]) * 100;
    dbg.speed.textContent = sp.toFixed(1) + ' cm/s' + (state.zupt ? ' · still ✓' : '');
  } else {
    dbg.speed.textContent = 'n/a';
  }

  // Positions-Experiment: Versatz vom Startpunkt (in cm) + Gesamtdistanz.
  const p = state.position;
  if (state.hasMotion) {
    const cm = (v) => (v * 100).toFixed(1);
    dbg.pos.textContent = `${cm(p[0])},${cm(p[1])},${cm(p[2])}`;
    dbg.dist.textContent = (Math.hypot(p[0], p[1], p[2]) * 100).toFixed(1) + ' cm';
  } else {
    dbg.pos.textContent = state.motionSupported ? '0,0,0' : 'n/a';
    dbg.dist.textContent = state.motionSupported ? '0 cm' : 'n/a';
  }
  // Aufnahmedauer des Wegs.
  if (state.path.length >= 1) {
    const dur = (state.path[state.path.length - 1].t - state.path[0].t) / 1000;
    dbg.time.textContent = dur.toFixed(1) + ' s';
  } else {
    dbg.time.textContent = '0 s';
  }
  dbg.count.textContent = String(state.markers.length);
}

let statusTimer = null;
function setStatus(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ============================================================= *
 *  Initialisierung / Event-Verdrahtung
 * ============================================================= */

function wireTapToPlace() {
  const overlay = document.getElementById('overlay');
  overlay.addEventListener('pointerdown', (e) => {
    // Tippen auf Bedienelemente nicht als Marker werten.
    if (e.target.closest('#controls')) return;
    placeMarker(e.clientX, e.clientY);
  });
}

async function start() {
  const gate = document.getElementById('gate');
  const gateErr = document.getElementById('gate-error');
  const video = document.getElementById('camera');

  try {
    gateErr.textContent = '';
    // Kamera + Sensoren benötigen eine Nutzergeste (dieser Klick).
    await startCamera(video);
    const absolute = await initSensors();

    // Kugel frisch auf das Handy zentrieren (Startpunkt = Position 0).
    state.position = [0, 0, 0];
    state.velocity = [0, 0, 0];
    state.lastMotionT = 0;
    clearPath();
    state.recording = true;

    gate.classList.add('hidden');
    document.getElementById('overlay').classList.remove('hidden');
    setStatus(absolute
      ? 'Bereit · absolute Orientierung verfügbar. Tippe zum Markieren.'
      : 'Bereit · relative Orientierung (Gyroskop). Tippe zum Markieren.');

    // Render-Schleife nur einmal starten.
    if (!state.running) {
      state.running = true;
      requestAnimationFrame(render);
    }
  } catch (err) {
    console.error(err);
    gateErr.textContent = (err && err.message) ? err.message
      : 'Start fehlgeschlagen. Kamera-/Sensorzugriff prüfen (HTTPS erforderlich).';
  }
}

// Kamera stoppen und zurück zur Startseite. Marker bleiben erhalten und sind
// nach erneutem Start wieder da; Sensor-Listener laufen weiter.
function stop() {
  state.running = false;
  stopCamera(document.getElementById('camera'));
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('gate').classList.remove('hidden');
}

let view3d = null;

/* ============================================================= *
 *  Variante B: Audio-Lokalisierung (AR-Modus)
 * ============================================================= *
 *  Pipeline: kurze Messfenster (Phase+Amplitude der Zielfrequenz) ->
 *  virtuelle Mikrofonpaare (Phasendifferenz, korrigiert um 2π·f·Δt) ->
 *  Richtungsschätzung -> raumstabile, verblassende Konfidenzbänder.
 *  Bewusst eine erste, vereinfachte Version zur Visualisierung des Prinzips.
 */
let tone = null;
let modeBRaf = 0;
let bCtx = null;

const SOUND_C = 343;            // Schallgeschwindigkeit (m/s)
const B_WIN_MS = 160;           // Abstand der Messfenster (ms)
const B_SNR_THRESH = 0.45;      // Verhältnis Ziel/Gesamt – Ton gilt als erkannt (distanzunabhängig)
const B_MAG_FLOOR = 2e-4;       // absolute Untergrenze (~ -74 dB) gegen Stille/Numerik
const B_MIN_BASELINE = 0.04;    // Mindest-Bewegungsabstand für ein Paar (m)
const B_MAX_BASELINE = 1.5;     // unplausibel großer Abstand (z. B. nach Zentrieren) -> verwerfen
const B_MAX_PAIR_DT = 1800;     // max. Zeitabstand eines Paares (ms)
const B_BAND_LIFE = 6000;       // Lebensdauer eines Bandes (ms)
const B_MAX_BANDS = 60;

function bTonePresent(l) {
  return !!l && l.snr > B_SNR_THRESH && l.magnitude > B_MAG_FLOOR;
}

const bState = {
  windows: [],   // { t, fwd:[x,y,z], pos:[x,y,z], amp, phase, db }
  bands: [],     // { az, el, halfWidth(rad), quality, t0 }
  lastWinT: 0,
};

function anyPerp(a) {
  // ein beliebiger zu a senkrechter Einheitsvektor
  const ref = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = [a[1] * ref[2] - a[2] * ref[1], a[2] * ref[0] - a[0] * ref[2], a[0] * ref[1] - a[1] * ref[0]];
  return normalize3(x);
}

// Kalibrieren/Zentrieren im B-Modus: Funktionen sind geteilt; Fensterpuffer leeren,
// damit Positionssprünge keine Geister-Bänder erzeugen.
function bCalibrate() { bState.windows.length = 0; startCalibration(); }
function bRecenter() { recenter(); bState.windows.length = 0; }

function bCollectWindow(now, l) {
  if (state.calibrating) return; // während der Kalibrierung keine Fenster sammeln
  if (now - bState.lastWinT < B_WIN_MS) return;
  bState.lastWinT = now;
  const present = bTonePresent(l);
  const fwd = Quat.rotateVec(state.quat, [0, 0, -1]);
  bState.windows.push({ t: now, fwd, pos: state.position.slice(), amp: l.magnitude, phase: l.phase, snr: l.snr, present });
  while (bState.windows.length > 80) bState.windows.shift();
  if (present) bFormPair(now, l);
}

// Aus dem neuesten Fenster + einem geeigneten früheren Fenster ein Band bilden.
function bFormPair(now, cur) {
  const A = bState.windows[bState.windows.length - 1];
  let best = null, bestBase = 0;
  for (let i = bState.windows.length - 2; i >= 0; i--) {
    const w = bState.windows[i];
    if (now - w.t > B_MAX_PAIR_DT) break;
    if (!w.present) continue;
    const base = Math.hypot(A.pos[0] - w.pos[0], A.pos[1] - w.pos[1], A.pos[2] - w.pos[2]);
    if (base > bestBase) { bestBase = base; best = w; }
  }
  if (!best || bestBase < B_MIN_BASELINE || bestBase > B_MAX_BASELINE) return;

  const f = tone.freq;
  const lambda = SOUND_C / f;
  const dt = (A.t - best.t) / 1000;
  // Phasendifferenz um die normale Zeit-Schwingung des Tons korrigieren.
  let dphi = A.phase - best.phase - 2 * Math.PI * f * dt;
  dphi = Math.atan2(Math.sin(dphi), Math.cos(dphi)); // auf [-π, π]
  const d = (dphi / (2 * Math.PI)) * lambda;          // Laufzeitdifferenz-Strecke (m)
  if (Math.abs(d) > bestBase) return;                 // physikalisch unmöglich -> verwerfen

  const bvec = [A.pos[0] - best.pos[0], A.pos[1] - best.pos[1], A.pos[2] - best.pos[2]];
  const bhat = normalize3(bvec);
  const cosT = Math.max(-1, Math.min(1, d / bestBase));
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));

  // Aus dem Lösungs-Kegel die Richtung nahe der Blickrichtung wählen.
  const fwd = A.fwd;
  const dotfa = fwd[0] * bhat[0] + fwd[1] * bhat[1] + fwd[2] * bhat[2];
  let fperp = [fwd[0] - dotfa * bhat[0], fwd[1] - dotfa * bhat[1], fwd[2] - dotfa * bhat[2]];
  const fpl = Math.hypot(fperp[0], fperp[1], fperp[2]);
  fperp = fpl < 1e-4 ? anyPerp(bhat) : [fperp[0] / fpl, fperp[1] / fpl, fperp[2] / fpl];
  const u = [
    cosT * bhat[0] + sinT * fperp[0],
    cosT * bhat[1] + sinT * fperp[1],
    cosT * bhat[2] + sinT * fperp[2],
  ];
  const { azimuth, elevation } = vectorToSpherical(u);

  // Qualität: längere Basis und klareres Signal (SNR) -> schmaleres, sichereres Band.
  const baseQ = Math.min(1, bestBase / (lambda * 0.5));
  const sigQ = Math.min(1, Math.max(0, (cur.snr - B_SNR_THRESH) / (1.4 - B_SNR_THRESH)));
  const quality = Math.max(0.08, baseQ * sigQ);
  const halfWidth = (10 + 35 * (1 - quality)) * DEG; // 10°..45°

  bState.bands.push({ az: azimuth, el: elevation, halfWidth, quality, t0: now });
  while (bState.bands.length > B_MAX_BANDS) bState.bands.shift();
}

function bClear() {
  bState.bands.length = 0;
  bState.windows.length = 0;
}

// Raumstabile Konfidenzbänder über dem Kamerabild zeichnen (Überlagerung = Heatmap).
function bRenderBands(now) {
  const cv = document.getElementById('b-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth, H = window.innerHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  bCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bCtx.clearRect(0, 0, W, H);

  const { tanX } = getFov();
  const invQ = Quat.conjugate(state.quat);
  bCtx.globalCompositeOperation = 'lighter'; // additive Überlagerung -> Hotspots
  for (let i = bState.bands.length - 1; i >= 0; i--) {
    const band = bState.bands[i];
    const age = now - band.t0;
    if (age > B_BAND_LIFE) { bState.bands.splice(i, 1); continue; }
    const fade = 1 - age / B_BAND_LIFE;
    const dir = sphericalToVector(band.az, band.el);
    const cam = Quat.rotateVec(invQ, dir);
    const proj = cameraRayToScreen(cam);
    if (!proj) continue;
    // Radius aus Winkelbreite, aber begrenzt, damit unsichere Bänder nicht zerlaufen.
    let rpx = (Math.tan(band.halfWidth) / tanX) * (W / 2);
    rpx = Math.max(24, Math.min(rpx, W * 0.45));
    // Deckkraft mit Mindestwert, damit auch unsichere Bänder sichtbar bleiben.
    const alpha = Math.min(0.5, (0.16 + 0.34 * band.quality) * fade);
    const g = bCtx.createRadialGradient(proj.px, proj.py, 0, proj.px, proj.py, rpx);
    g.addColorStop(0, `rgba(255,110,50,${alpha})`);
    g.addColorStop(0.6, `rgba(255,90,40,${alpha * 0.5})`);
    g.addColorStop(1, 'rgba(255,90,40,0)');
    bCtx.fillStyle = g;
    bCtx.beginPath();
    bCtx.arc(proj.px, proj.py, rpx, 0, Math.PI * 2);
    bCtx.fill();
  }
  // Sichtbarer Rand des hellsten Bereichs (nicht additiv), für klare Abgrenzung.
  bCtx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < bState.bands.length; i++) {
    const band = bState.bands[i];
    const fade = 1 - (now - band.t0) / B_BAND_LIFE;
    if (fade <= 0) continue;
    const dir = sphericalToVector(band.az, band.el);
    const proj = cameraRayToScreen(Quat.rotateVec(invQ, dir));
    if (!proj) continue;
    let rpx = (Math.tan(band.halfWidth) / tanX) * (W / 2);
    rpx = Math.max(24, Math.min(rpx, W * 0.45));
    bCtx.strokeStyle = `rgba(255,140,80,${0.35 * fade})`;
    bCtx.lineWidth = 1.5;
    bCtx.beginPath();
    bCtx.arc(proj.px, proj.py, rpx, 0, Math.PI * 2);
    bCtx.stroke();
  }
}

async function startModeB() {
  const gate = document.getElementById('gate');
  const modeB = document.getElementById('modeB');
  const overlay = document.getElementById('overlay');
  const err = document.getElementById('b-error');
  const video = document.getElementById('camera');
  err.textContent = '';
  gate.classList.add('hidden');
  overlay.classList.add('hidden');
  modeB.classList.remove('hidden');
  bCtx = document.getElementById('b-canvas').getContext('2d');
  try {
    const freq = parseFloat(document.getElementById('b-freq').value) || 3000;
    await startCamera(video);
    await initSensors();
    // Position frisch & frei laufend (für die Bewegungsbasis der Paare).
    state.position = [0, 0, 0];
    state.velocity = [0, 0, 0];
    state.lastMotionT = 0;
    state.positionFrozen = false;
    bClear();
    tone = new TargetTone();
    await tone.start(freq); // Mikrofon-Freigabe (Nutzergeste vom Button-Klick)
    state.modeB = true;
    modeBLoop();
  } catch (e) {
    console.error(e);
    err.textContent = (e && e.message) ? e.message
      : 'Kamera-/Mikrofonzugriff fehlgeschlagen (HTTPS + Freigabe erforderlich).';
  }
}

function modeBLoop() {
  if (!state.modeB) return;
  const now = performance.now();
  const l = tone ? tone.analyze() : null;
  if (l) {
    bCollectWindow(now, l);
    document.getElementById('b-db').textContent =
      (l.db <= -119 ? '–' : l.db.toFixed(1)) + ' dB · SNR ' + l.snr.toFixed(1);
    const det = document.getElementById('b-detect');
    if (state.calibrating) {
      const rem = Math.max(0, (state.calEndT - now) / 1000);
      det.textContent = 'Kalibriere … ' + rem.toFixed(1) + ' s';
      det.classList.remove('on');
    } else {
      const on = bTonePresent(l);
      det.textContent = on ? 'Ton erkannt' : 'kein Ton';
      det.classList.toggle('on', on);
    }
  }
  bRenderBands(now);
  document.getElementById('b-count').textContent = String(bState.bands.length);
  document.getElementById('b-rate').textContent =
    state.motionHz ? state.motionHz.toFixed(0) + ' Hz' + (state.motionSource === 'Sensor-API 60Hz' ? ' · API' : ' · DM') : '–';
  modeBRaf = requestAnimationFrame(modeBLoop);
}

function stopModeB() {
  state.modeB = false;
  cancelAnimationFrame(modeBRaf);
  if (tone) { tone.stop(); tone = null; }
  stopCamera(document.getElementById('camera'));
  bClear();
  document.getElementById('modeB').classList.add('hidden');
  document.getElementById('gate').classList.remove('hidden');
}

/* ============================================================= *
 *  Mode C: Akustische Taschenlampe
 * ============================================================= *
 *  Gerichtetes (USB-)Mikrofon misst den Zielpegel; die aktuelle
 *  Blickrichtung (Orientierung, KEINE Position) gewichtet die Richtung.
 *  Verblassende Heatmap + akustisches Zentrum = Suchrichtung.
 */
let meterC = null;
let modeCRaf = 0;
let cCtx = null;
let cDotSprite = null;

const mc = {
  active: false,
  frozen: false,
  samples: [],        // { t, direction:[x,y,z], score, quality, levelDb }
  fadeTauMs: 4500,
  maxSamples: 600,
  minQuality: 0.15,
  centerVec: null,
  centerQ01: 0,       // 0..1
  selectedDeviceId: null,
  lastSampleT: 0,
  last: null,         // letzte Messung
};

function cGetDot() {
  if (cDotSprite) return cDotSprite;
  const s = 64;
  const c = document.createElement('canvas'); c.width = s; c.height = s;
  const cx = c.getContext('2d');
  const g = cx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,180,80,0.95)');
  g.addColorStop(0.5, 'rgba(255,120,40,0.45)');
  g.addColorStop(1, 'rgba(255,110,40,0)');
  cx.fillStyle = g; cx.fillRect(0, 0, s, s);
  cDotSprite = c; return c;
}

function cMicDirection() {
  // Mikrofonachse = Kamera-Blickrichtung (Offset später kalibrierbar).
  return Quat.rotateVec(state.quat, [0, 0, -1]);
}

async function cPopulateInputs() {
  const sel = document.getElementById('c-input');
  const list = await LevelMeter.listInputs();
  sel.innerHTML = '';
  let preferred = null, preferredLabel = '';
  for (const d of list) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    const ext = LevelMeter.isExternal(d.label);
    o.textContent = (ext ? '⭐ ' : '') + d.label;
    sel.appendChild(o);
    if (!preferred && ext) { preferred = d.deviceId; preferredLabel = d.label; }
  }
  mc.selectedDeviceId = preferred || (list[0] && list[0].deviceId) || null;
  if (mc.selectedDeviceId) sel.value = mc.selectedDeviceId;
  // USB-Badge sofort anzeigen wenn externes Mikro gefunden
  const badge = document.getElementById('c-usb-badge');
  if (preferred) {
    badge.textContent = '🎙 USB-Mikrofon erkannt: ' + preferredLabel;
    badge.className = 'usb-ok';
  } else {
    badge.textContent = '⚠ Kein USB-Mikrofon – internes Mikrofon aktiv';
    badge.className = 'usb-warn';
  }
}

function cApplyTarget() {
  if (!meterC) return;
  const f = parseFloat(document.getElementById('c-freq').value) || 0;
  meterC.setTarget(f);
}

async function cSetInput(deviceId) {
  mc.selectedDeviceId = deviceId;
  if (meterC) meterC.stop();
  meterC = new LevelMeter();
  await meterC.start(deviceId);
  cApplyTarget();
  cClear();
}

async function startModeC() {
  const err = document.getElementById('c-error');
  err.textContent = '';
  document.getElementById('gate').classList.add('hidden');
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('modeC').classList.remove('hidden');
  cCtx = document.getElementById('c-canvas').getContext('2d');
  try {
    await startCamera(document.getElementById('camera'));
    await initSensors();
    // Erststart: Berechtigung holen, dann Geräte mit Labels listen, extern bevorzugen.
    meterC = new LevelMeter();
    await meterC.start(null);
    await cPopulateInputs();
    if (mc.selectedDeviceId && mc.selectedDeviceId !== '') {
      try { await cSetInput(mc.selectedDeviceId); } catch (e) { /* behalte Default */ }
    }
    cApplyTarget(); // evtl. vorausgefüllte Zielfrequenz übernehmen
    mc.active = true; mc.frozen = false;
    cClear();
    modeCLoop();
  } catch (e) {
    console.error(e);
    err.textContent = (e && e.message) ? e.message
      : 'Mikrofon-/Kamerazugriff fehlgeschlagen (HTTPS + Freigabe erforderlich).';
  }
}

function cClear() { mc.samples = []; mc.centerVec = null; mc.centerQ01 = 0; }

function cSample(now, lv) {
  // Nur sammeln, wenn ein Ton wirklich heraussticht (kein Hotspot aus Rauschen).
  if (lv.quality < mc.minQuality || lv.score < 0.08) return;
  mc.samples.push({ t: now, direction: cMicDirection(), score: lv.score, quality: lv.quality, levelDb: lv.levelDb });
  // Alte/überzählige Samples entfernen.
  const cutoff = now - mc.fadeTauMs * 3;
  while (mc.samples.length && (mc.samples[0].t < cutoff || mc.samples.length > mc.maxSamples)) mc.samples.shift();
}

function cComputeCenter(now) {
  let v = [0, 0, 0], wsum = 0, fsum = 0;
  for (const s of mc.samples) {
    const fade = Math.exp(-(now - s.t) / mc.fadeTauMs);
    const w = s.score * s.quality * fade;
    v[0] += s.direction[0] * w; v[1] += s.direction[1] * w; v[2] += s.direction[2] * w;
    wsum += w; fsum += fade;
  }
  mc.centerVec = wsum > 1e-6 ? normalize3(v) : null;
  mc.centerQ01 = Math.min(1, wsum / (fsum + 1e-6));
}

function cRender(now) {
  const cv = document.getElementById('c-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth, H = window.innerHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  cCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cCtx.clearRect(0, 0, W, H);

  const invQ = Quat.conjugate(state.quat);
  // Heatmap-Blobs mit ABSOLUTEM Gewicht (kein relatives Maximum -> bei Stille nichts).
  const dot = cGetDot();
  const r = Math.max(26, W * 0.08);
  cCtx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < mc.samples.length; i++) {
    const s = mc.samples[i];
    const w = s.score * s.quality * Math.exp(-(now - s.t) / mc.fadeTauMs); // 0..1
    if (w < 0.06) continue;
    const cam = Quat.rotateVec(invQ, s.direction);
    if (cam[2] >= -0.02) continue;
    const proj = cameraRayToScreen(cam);
    if (!proj) continue;
    cCtx.globalAlpha = Math.min(0.6, 0.12 + 0.7 * w);
    cCtx.drawImage(dot, proj.px - r, proj.py - r, 2 * r, 2 * r);
  }
  cCtx.globalAlpha = 1;
  cCtx.globalCompositeOperation = 'source-over';

  // Akustisches Zentrum bzw. Randpfeil.
  if (mc.centerVec && mc.centerQ01 > 0.12) {
    const cam = Quat.rotateVec(invQ, mc.centerVec);
    const proj = cam[2] < -0.02 ? cameraRayToScreen(cam) : null;
    const onScreen = proj && proj.px > 0 && proj.px < W && proj.py > 0 && proj.py < H;
    if (onScreen) {
      cCtx.strokeStyle = 'rgba(25,227,106,0.95)'; cCtx.lineWidth = 3;
      cCtx.beginPath(); cCtx.arc(proj.px, proj.py, 26, 0, Math.PI * 2); cCtx.stroke();
      cCtx.fillStyle = 'rgba(25,227,106,0.95)';
      cCtx.beginPath(); cCtx.arc(proj.px, proj.py, 6, 0, Math.PI * 2); cCtx.fill();
      cCtx.font = '13px -apple-system, sans-serif';
      cCtx.fillText('akust. Zentrum', proj.px + 32, proj.py + 4);
    } else {
      // Randpfeil zur Richtung.
      let dx = cam[0], dy = -cam[1];
      if (cam[2] >= 0) { dx = -dx; dy = -dy; } // hinter der Kamera
      const ang = Math.atan2(dy, dx);
      const cx = W / 2, cy = H / 2, rr = Math.min(W, H) * 0.38;
      const ax = cx + Math.cos(ang) * rr, ay = cy + Math.sin(ang) * rr;
      cCtx.save();
      cCtx.translate(ax, ay); cCtx.rotate(ang);
      cCtx.fillStyle = 'rgba(25,227,106,0.95)';
      cCtx.beginPath(); cCtx.moveTo(18, 0); cCtx.lineTo(-12, 10); cCtx.lineTo(-12, -10); cCtx.closePath(); cCtx.fill();
      cCtx.restore();
    }
  }
}

function modeCLoop() {
  if (!mc.active) return;
  const now = performance.now();
  const lv = meterC ? meterC.read() : null;
  if (lv) {
    mc.last = lv;
    if (!mc.frozen) {
      if (now - mc.lastSampleT >= 60) { mc.lastSampleT = now; cSample(now, lv); }
      cComputeCenter(now);
    }
    // HUD
    document.getElementById('c-bar').style.width = (lv.score * 100).toFixed(0) + '%';
    document.getElementById('c-score').textContent =
      lv.score.toFixed(2) + ' · ' + lv.promDb.toFixed(1) + ' dB Prom.';
    // Auto-Frequenz anzeigen (nur im Breitband-Modus relevant)
    const afEl = document.getElementById('c-autofreq');
    if (lv.targetFreq > 0) {
      afEl.textContent = lv.targetFreq.toFixed(0) + ' Hz (Ziel)';
    } else if (lv.autoFreq > 0) {
      afEl.textContent = (lv.autoFreq / 1000).toFixed(1) + ' kHz (auto)';
    } else {
      afEl.textContent = '–';
    }
    document.getElementById('c-quality').textContent = (lv.quality * 100).toFixed(0) + ' %';
    const ext = LevelMeter.isExternal(lv.label);
    const micEl = document.getElementById('c-mic');
    micEl.textContent = (lv.label ? lv.label.slice(0, 26) : 'Standard') + (ext ? ' ✓' : ' · intern');
    micEl.style.color = ext ? '#19e36a' : '#ffb24a';
    document.getElementById('c-ch').textContent = String(lv.channels);
    document.getElementById('c-center').textContent = (mc.centerVec && mc.centerQ01 > 0.12)
      ? (mc.centerQ01 * 100).toFixed(0) + ' %' : 'Scan weiterführen';
    const warn = [];
    if (lv.clip) warn.push('Übersteuert!');
    if (lv.agc) warn.push('Pegel evtl. automatisch geregelt');
    if (lv.targetFreq > 0 && lv.promDb < 4) warn.push('kein Zielton erkannt');
    if (!ext) warn.push('USB-Mikrofon empfohlen für HF');
    document.getElementById('c-warn').textContent = warn.join(' · ');
  }
  cRender(now);
  modeCRaf = requestAnimationFrame(modeCLoop);
}

function stopModeC() {
  mc.active = false;
  cancelAnimationFrame(modeCRaf);
  if (meterC) { meterC.stop(); meterC = null; }
  stopCamera(document.getElementById('camera'));
  cClear();
  document.getElementById('modeC').classList.add('hidden');
  document.getElementById('gate').classList.remove('hidden');
}

function open3D() {
  state.view = '3d';
  document.getElementById('view3d').classList.remove('hidden');
}

function close3D() {
  state.view = 'ar';
  document.getElementById('view3d').classList.add('hidden');
}

function init() {
  cacheDom();
  wireTapToPlace();
  view3d = new View3D(document.getElementById('view3d-canvas'));

  document.getElementById('btn-start').addEventListener('click', start);
  document.getElementById('btn-start-b').addEventListener('click', startModeB);
  document.getElementById('b-close').addEventListener('click', stopModeB);
  document.getElementById('b-calibrate').addEventListener('click', bCalibrate);
  document.getElementById('b-center').addEventListener('click', bRecenter);
  document.getElementById('b-clear').addEventListener('click', bClear);
  document.getElementById('b-freq').addEventListener('input', (e) => {
    if (tone) tone.setFreq(parseFloat(e.target.value) || 0);
    bClear(); // bei Frequenzwechsel alte Bänder verwerfen
  });

  // Mode C: Akustische Taschenlampe
  initModeD(); // Modus D: VIO-Array + Triangulation (eigenständiges Modul)

  document.getElementById('btn-start-c').addEventListener('click', startModeC);
  document.getElementById('c-close').addEventListener('click', stopModeC);
  document.getElementById('c-clear').addEventListener('click', cClear);
  const cFreezeBtn = document.getElementById('c-freeze');
  cFreezeBtn.addEventListener('click', () => {
    mc.frozen = !mc.frozen;
    cFreezeBtn.textContent = mc.frozen ? 'Weiter' : 'Einfrieren';
    cFreezeBtn.classList.toggle('armed', mc.frozen);
  });
  document.getElementById('c-input').addEventListener('change', (e) => {
    cSetInput(e.target.value).catch((err) => {
      document.getElementById('c-error').textContent = 'Eingang fehlgeschlagen: ' + (err && err.message || '');
    });
  });
  document.getElementById('c-freq').addEventListener('input', () => { cApplyTarget(); cClear(); });

  document.getElementById('btn-stop').addEventListener('click', stop);
  document.getElementById('btn-calibrate').addEventListener('click', startCalibration);
  document.getElementById('btn-center').addEventListener('click', recenter);
  document.getElementById('btn-measure').addEventListener('click', startMeasurement);
  document.getElementById('btn-clear').addEventListener('click', clearMarkers);
  document.getElementById('btn-3d').addEventListener('click', open3D);
  document.getElementById('btn-view-close').addEventListener('click', close3D);
  document.getElementById('btn-view-reset').addEventListener('click', () => view3d.resetView());

  const btnParallax = document.getElementById('btn-parallax');
  btnParallax.addEventListener('click', () => {
    state.parallax = !state.parallax;
    btnParallax.textContent = 'Parallaxe: ' + (state.parallax ? 'an' : 'aus');
    setStatus(state.parallax
      ? 'Parallaxe an (6DoF) – Marker reagiert auf Bewegung (driftet beim Kippen).'
      : 'Parallaxe aus (3DoF) – Marker bleibt beim Kippen fest.');
  });

  const btnDebug = document.getElementById('btn-debug');
  btnDebug.addEventListener('click', () => {
    state.showDebug = !state.showDebug;
    document.getElementById('debug').style.display = state.showDebug ? '' : 'none';
    btnDebug.textContent = state.showDebug ? 'Debug aus' : 'Debug an';
  });

  // Service Worker für PWA / Offline-Fähigkeit registrieren.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW:', e));
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
