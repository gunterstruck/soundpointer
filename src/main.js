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

// Beschleunigung -> Position (experimentelles 6DoF, doppelte Integration).
function onMotion(ev) {
  const acc = ev.acceleration;                  // OHNE Schwerkraft (vom OS entfernt)
  const accG = ev.accelerationIncludingGravity; // MIT Schwerkraft (roh)

  if (acc && (acc.x != null || acc.y != null || acc.z != null)) {
    state.gravityFree = true; // gut: Schwerkraft ist bereits herausgerechnet
  } else if (accG && (accG.x != null || accG.y != null || accG.z != null)) {
    // Gerät liefert nur Werte MIT Schwerkraft -> Position nicht zuverlässig trackbar.
    state.motionSupported = true;
    state.gravityFree = false;
    state.accMag = Math.hypot(accG.x || 0, accG.y || 0, accG.z || 0);
    return;
  } else {
    return;
  }

  state.motionSupported = true;
  state.hasMotion = true;

  const raw = [acc.x || 0, acc.y || 0, acc.z || 0];
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
  // steht das Handy -> Geschwindigkeit auf 0 zwingen. Das verhindert, dass nach
  // Beschleunigen/Bremsen eine Rest-Geschwindigkeit den Punkt weiterlaufen lässt.
  if (corrMag < ZUPT_ACC) state.stillTime += dt; else state.stillTime = 0;
  state.zupt = state.stillTime >= ZUPT_HOLD;

  // Totzone (nur kleine Rest-Rausch-Werte auf 0), Vorzeichen bleibt erhalten.
  const dz = (v) => (Math.abs(v) < ACC_DEADZONE ? 0 : v);
  const aDev = [dz(corr[0]), dz(corr[1]), dz(corr[2])];

  // In Weltkoordinaten drehen und doppelt integrieren.
  // Geschwindigkeits-Dämpfung (zeitbasiert): ohne anhaltende Beschleunigung
  // zerfällt die Geschwindigkeit Richtung 0 -> stoppt das Weiterlaufen, auch
  // wenn ZUPT (wegen Hand-Zittern) nicht auslöst.
  const damp = Math.exp(-dt / VEL_TAU);
  const aW = Quat.rotateVec(state.devQuat, aDev);
  for (let i = 0; i < 3; i++) {
    state.position[i] += state.velocity[i] * dt + 0.5 * aW[i] * dt * dt;
    state.velocity[i] = (state.velocity[i] + aW[i] * dt) * damp;
  }
  if (state.zupt) state.velocity = [0, 0, 0];
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

  // Bewegung (Beschleunigung) für das Positions-Experiment.
  if (window.DeviceMotionEvent) {
    window.addEventListener('devicemotion', onMotion);
  }

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
  ['source', 'azimuth', 'pitch', 'roll', 'amag', 'speed', 'pos', 'dist', 'time', 'count'].forEach((k) => {
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
  } else {
    dbg.amag.textContent = 'n/a';
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
const B_DB_THRESH = -50;        // Mindestpegel, damit ein Fenster zählt (dB)
const B_MIN_BASELINE = 0.04;    // Mindest-Bewegungsabstand für ein Paar (m)
const B_MAX_PAIR_DT = 1800;     // max. Zeitabstand eines Paares (ms)
const B_BAND_LIFE = 6000;       // Lebensdauer eines Bandes (ms)
const B_MAX_BANDS = 60;

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

function bCollectWindow(now, l) {
  if (now - bState.lastWinT < B_WIN_MS) return;
  bState.lastWinT = now;
  const fwd = Quat.rotateVec(state.quat, [0, 0, -1]);
  bState.windows.push({ t: now, fwd, pos: state.position.slice(), amp: l.magnitude, phase: l.phase, db: l.db });
  while (bState.windows.length > 80) bState.windows.shift();
  if (l.db > B_DB_THRESH) bFormPair(now, l);
}

// Aus dem neuesten Fenster + einem geeigneten früheren Fenster ein Band bilden.
function bFormPair(now, cur) {
  const A = bState.windows[bState.windows.length - 1];
  let best = null, bestBase = 0;
  for (let i = bState.windows.length - 2; i >= 0; i--) {
    const w = bState.windows[i];
    if (now - w.t > B_MAX_PAIR_DT) break;
    if (w.db <= B_DB_THRESH) continue;
    const base = Math.hypot(A.pos[0] - w.pos[0], A.pos[1] - w.pos[1], A.pos[2] - w.pos[2]);
    if (base > bestBase) { bestBase = base; best = w; }
  }
  if (!best || bestBase < B_MIN_BASELINE) return;

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

  // Qualität: längere Basis und stärkeres Signal -> schmaleres, sichereres Band.
  const baseQ = Math.min(1, bestBase / (lambda * 0.5));
  const sigQ = Math.min(1, Math.max(0, (cur.db + 60) / 45));
  const quality = Math.max(0.05, baseQ * sigQ);
  const halfWidth = (8 + 55 * (1 - quality)) * DEG;

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
    const rpx = (Math.tan(band.halfWidth) / tanX) * (W / 2);
    const alpha = 0.22 * band.quality * fade;
    const g = bCtx.createRadialGradient(proj.px, proj.py, 0, proj.px, proj.py, Math.max(8, rpx));
    g.addColorStop(0, `rgba(255,90,40,${alpha})`);
    g.addColorStop(1, 'rgba(255,90,40,0)');
    bCtx.fillStyle = g;
    bCtx.beginPath();
    bCtx.arc(proj.px, proj.py, Math.max(8, rpx), 0, Math.PI * 2);
    bCtx.fill();
  }
  bCtx.globalCompositeOperation = 'source-over';
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
    document.getElementById('b-db').textContent = (l.db <= -119 ? '–' : l.db.toFixed(1)) + ' dB';
    const det = document.getElementById('b-detect');
    const on = l.db > B_DB_THRESH;
    det.textContent = on ? 'Ton erkannt' : 'kein Ton';
    det.classList.toggle('on', on);
  }
  bRenderBands(now);
  document.getElementById('b-count').textContent = String(bState.bands.length);
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
  document.getElementById('b-clear').addEventListener('click', bClear);
  document.getElementById('b-freq').addEventListener('input', (e) => {
    if (tone) tone.setFreq(parseFloat(e.target.value) || 0);
    bClear(); // bei Frequenzwechsel alte Bänder verwerfen
  });
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
