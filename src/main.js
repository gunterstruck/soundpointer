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
  quat: Quat.identity(),
  markers: [],   // { id, azimuth, elevation, timestamp, el(DOM) }
  nextId: 1,
  showDebug: true,
};

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
  video.srcObject = stream;
  await video.play().catch(() => {});
  return stream;
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
  state.hasOrientation = true;

  // Absolute Orientierung (Magnetometer) bevorzugen.
  const eventIsAbsolute = absolute || ev.absolute === true;
  if (eventIsAbsolute) {
    state.isAbsolute = true;
    state.source = 'Magnetometer (absolut)';
  } else if (!state.isAbsolute) {
    state.source = 'Gyroskop (relativ)';
  }

  state.quat = deviceQuaternion(state.alpha, state.beta, state.gamma, state.screenAngle);
}

async function initSensors() {
  updateScreenAngle();
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', updateScreenAngle);
  }
  window.addEventListener('orientationchange', updateScreenAngle);

  // iOS 13+ verlangt explizite Freigabe.
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    const res = await DOE.requestPermission();
    if (res !== 'granted') {
      throw new Error('Zugriff auf Bewegungssensoren verweigert.');
    }
  }

  // Absolute Orientierung bevorzugen, falls verfügbar.
  let absoluteSupported = false;
  if ('ondeviceorientationabsolute' in window) {
    absoluteSupported = true;
    window.addEventListener('deviceorientationabsolute', (e) => onOrientation(e, true));
  }
  window.addEventListener('deviceorientation', (e) => onOrientation(e, false));

  return absoluteSupported;
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
  // 3) Weltrichtung -> Azimut / Elevation (das wird gespeichert!)
  const { azimuth, elevation } = vectorToSpherical(worldDir);

  const el = document.createElement('div');
  el.className = 'marker';
  document.getElementById('markers').appendChild(el);

  state.markers.push({
    id: state.nextId++,
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

/* ============================================================= *
 *  Render-Schleife: Marker auf den Bildschirm projizieren
 * ============================================================= */

function render() {
  const invQ = Quat.conjugate(state.quat); // Welt -> Kamera

  for (const m of state.markers) {
    const worldDir = sphericalToVector(m.azimuth, m.elevation);
    const camDir = Quat.rotateVec(invQ, worldDir);
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
  ['source', 'azimuth', 'pitch', 'roll', 'count'].forEach((k) => {
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

    gate.classList.add('hidden');
    setStatus(absolute
      ? 'Bereit · absolute Orientierung verfügbar. Tippe zum Markieren.'
      : 'Bereit · relative Orientierung (Gyroskop). Tippe zum Markieren.');

    requestAnimationFrame(render);
  } catch (err) {
    console.error(err);
    gateErr.textContent = (err && err.message) ? err.message
      : 'Start fehlgeschlagen. Kamera-/Sensorzugriff prüfen (HTTPS erforderlich).';
  }
}

function init() {
  cacheDom();
  wireTapToPlace();

  document.getElementById('btn-start').addEventListener('click', start);
  document.getElementById('btn-clear').addEventListener('click', clearMarkers);

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
