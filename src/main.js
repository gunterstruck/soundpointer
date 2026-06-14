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
 * Reine Geräte-zu-Welt-Orientierung (OHNE Kamera-/Bildschirm-Korrektur).
 * Bildet einen Vektor in Geräteachsen (x = rechts, y = oben, z = aus dem
 * Display heraus) in dieselben Weltkoordinaten ab wie oben. Wird benötigt,
 * um die Beschleunigung (Geräteachsen) in die Welt zu drehen.
 */
function deviceWorldQuaternion(alpha, beta, gamma) {
  return Quat.fromEulerYXZ(beta * DEG, alpha * DEG, -gamma * DEG);
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
  view: 'ar',    // 'ar' | '3d'
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
  state.alpha = ev.alpha || 0;
  state.beta = ev.beta || 0;
  state.gamma = ev.gamma || 0;

  // Absolute Orientierung (Magnetometer) bevorzugen.
  const eventIsAbsolute = absolute || ev.absolute === true;
  if (eventIsAbsolute) {
    state.isAbsolute = true;
    state.source = 'Magnetometer (absolut)';
  } else if (!state.isAbsolute) {
    state.source = 'Gyroskop (relativ)';
  }

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
  if (!state.hasMotion) return;
  const now = performance.now();
  if (state.lastPathT && now - state.lastPathT < PATH_INTERVAL) return;
  state.lastPathT = now;
  state.path.push({ t: now, p: state.position.slice() });
  if (state.path.length > PATH_MAX) state.path.shift();
}

// Szene für das 3D-Modul.
function getScene() {
  return {
    path: state.path.map((s) => s.p),
    markers: state.markers.map((m) => m.pos),
    phone: state.position.slice(),
  };
}

/* ============================================================= *
 *  Render-Schleife: Marker projizieren bzw. 3D-Ansicht zeichnen
 * ============================================================= */

function render() {
  if (!state.running) return;
  samplePath();

  if (state.view === '3d') {
    if (view3d) view3d.draw(getScene());
    requestAnimationFrame(render);
    return;
  }

  const invQ = Quat.conjugate(state.quat); // Welt -> Kamera

  for (const m of state.markers) {
    // Richtung vom aktuellen Standort zum Marker (3D) -> Parallaxe bei Bewegung.
    const rel = sub3(m.pos, state.position);
    const camDir = Quat.rotateVec(invQ, rel);
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
  ['source', 'azimuth', 'pitch', 'roll', 'amag', 'speed', 'pos', 'dist', 'count'].forEach((k) => {
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

    gate.classList.add('hidden');
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
  document.getElementById('gate').classList.remove('hidden');
}

let view3d = null;

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
  document.getElementById('btn-stop').addEventListener('click', stop);
  document.getElementById('btn-calibrate').addEventListener('click', startCalibration);
  document.getElementById('btn-center').addEventListener('click', recenter);
  document.getElementById('btn-clear').addEventListener('click', clearMarkers);
  document.getElementById('btn-3d').addEventListener('click', open3D);
  document.getElementById('btn-view-close').addEventListener('click', close3D);
  document.getElementById('btn-view-reset').addEventListener('click', () => view3d.resetView());

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
