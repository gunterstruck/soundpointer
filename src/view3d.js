/*
 * SoundPointer – Unabhängiges 3D-Ansichtsmodul
 * ------------------------------------------------------------------
 * Zeigt den aufgezeichneten Weg des Handys (Linie) und die gesetzten
 * Marker (Punkte) in einem frei drehbaren 3D-Raum. Reiner 2D-Canvas-
 * Renderer mit orthografischer Projektion – kein externes Framework.
 *
 * Bedienung: ein Finger ziehen = drehen (Orbit), zwei Finger = zoomen.
 *
 * Weltkoordinaten wie in der App: x = rechts, y = oben, z (−z = vorne).
 */

'use strict';

const COL = {
  cube: 'rgba(255,255,255,0.18)',
  grid: 'rgba(255,255,255,0.08)',
  path: '#36c6ff',     // Weg des Handys (roh)
  corr: '#ff9f43',     // korrigierter Weg (Loop Closure)
  marker: '#19e36a',   // gesetzte Marker
  patch: 'rgba(25,227,106,0.30)', // angedeuteter Kugelausschnitt um den Marker
  phone: '#ffd23f',    // aktuelle Handy-Position
  start: 'rgba(255,255,255,0.9)',
  axX: '#ff5a5a', axY: '#5aff8a', axZ: '#5a9bff',
};

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(v) {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}

function rotate(p, yaw, pitch) {
  // erst um Y (yaw), dann um X (pitch)
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = p[0] * cy + p[2] * sy;
  const z1 = -p[0] * sy + p[2] * cy;
  const y1 = p[1];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = y1 * cp - z1 * sp;
  const z2 = y1 * sp + z1 * cp;
  return [x1, y2, z2];
}

export class View3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.yaw = 0.7;
    this.pitch = 0.5;
    this.zoom = 1;
    this.pointers = new Map();
    this.lastPinch = 0;
    this._bindInput();
  }

  resetView() { this.yaw = 0.7; this.pitch = 0.5; this.zoom = 1; }

  _bindInput() {
    const c = this.canvas;
    const pos = (e) => ({ x: e.clientX, y: e.clientY });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, pos(e));
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const prev = this.pointers.get(e.pointerId);
      const cur = pos(e);
      this.pointers.set(e.pointerId, cur);

      if (this.pointers.size === 1) {
        // Orbit
        this.yaw -= (cur.x - prev.x) * 0.01;
        this.pitch -= (cur.y - prev.y) * 0.01;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
      } else if (this.pointers.size >= 2) {
        // Pinch-Zoom
        const pts = [...this.pointers.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this.lastPinch) this.zoom *= d / this.lastPinch;
        this.zoom = Math.max(0.2, Math.min(8, this.zoom));
        this.lastPinch = d;
      }
    });
    const end = (e) => { this.pointers.delete(e.pointerId); this.lastPinch = 0; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom *= e.deltaY < 0 ? 1.1 : 0.9;
      this.zoom = Math.max(0.2, Math.min(8, this.zoom));
    }, { passive: false });
  }

  draw(scene) {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (this.canvas.width !== W * dpr || this.canvas.height !== H * dpr) {
      this.canvas.width = W * dpr; this.canvas.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const path = scene.path || [];
    const corrected = scene.corrected || [];
    const markers = scene.markers || [];
    const phone = scene.phone || null;

    // Datenbereich (Bounding Box) inkl. Ursprung.
    const all = [[0, 0, 0], ...path, ...corrected, ...markers];
    if (phone) all.push(phone);
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of all) for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 0.3);
    const scale = (0.38 * Math.min(W, H) / extent) * this.zoom;

    const project = (p) => {
      const q = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
      const r = rotate(q, this.yaw, this.pitch);
      return [W / 2 + scale * r[0], H / 2 - scale * r[1]];
    };
    const line = (a, b, color, width) => {
      const pa = project(a), pb = project(b);
      ctx.strokeStyle = color; ctx.lineWidth = width || 1;
      ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
    };
    const dot = (p, color, radius) => {
      const s = project(p);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(s[0], s[1], radius, 0, Math.PI * 2); ctx.fill();
    };

    // Bounding-Würfel.
    const c000 = [min[0], min[1], min[2]], c111 = [max[0], max[1], max[2]];
    const corner = (i, j, k) => [i ? c111[0] : c000[0], j ? c111[1] : c000[1], k ? c111[2] : c000[2]];
    const edges = [
      [[0,0,0],[1,0,0]],[[0,0,0],[0,1,0]],[[0,0,0],[0,0,1]],
      [[1,1,1],[0,1,1]],[[1,1,1],[1,0,1]],[[1,1,1],[1,1,0]],
      [[1,0,0],[1,1,0]],[[1,0,0],[1,0,1]],[[0,1,0],[1,1,0]],
      [[0,1,0],[0,1,1]],[[0,0,1],[1,0,1]],[[0,0,1],[0,1,1]],
    ];
    for (const [a, b] of edges) line(corner(...a), corner(...b), COL.cube, 1);

    // Achsen vom Ursprung (x rot, y grün, z blau).
    const axLen = extent * 0.35;
    line([0, 0, 0], [axLen, 0, 0], COL.axX, 2);
    line([0, 0, 0], [0, axLen, 0], COL.axY, 2);
    line([0, 0, 0], [0, 0, axLen], COL.axZ, 2);

    // Weg des Handys.
    ctx.strokeStyle = COL.path; ctx.lineWidth = 2;
    if (path.length > 1) {
      ctx.beginPath();
      const p0 = project(path[0]); ctx.moveTo(p0[0], p0[1]);
      for (let i = 1; i < path.length; i++) { const s = project(path[i]); ctx.lineTo(s[0], s[1]); }
      ctx.stroke();
    }

    // Korrigierter Weg (Loop Closure), falls vorhanden.
    if (corrected.length > 1) {
      ctx.strokeStyle = COL.corr; ctx.lineWidth = 2;
      ctx.beginPath();
      const q0 = project(corrected[0]); ctx.moveTo(q0[0], q0[1]);
      for (let i = 1; i < corrected.length; i++) { const s = project(corrected[i]); ctx.lineTo(s[0], s[1]); }
      ctx.stroke();
    }

    // Startpunkt (Ursprung / Kugelmittelpunkt).
    dot([0, 0, 0], COL.start, 4);

    // Pro Marker einen leicht durchscheinenden Kugelausschnitt andeuten:
    // ein um die Markerrichtung herum gebogenes Gitter auf der Kugeloberfläche
    // (Radius = Abstand Marker↔Ursprung). Zeigt, dass der Punkt auf einer Kugel sitzt.
    const PN = 4, PS = 0.4; // Gitterauflösung / Winkelausdehnung
    for (const m of markers) {
      const R = Math.hypot(m[0], m[1], m[2]);
      if (R < 1e-3) continue;
      const d = [m[0] / R, m[1] / R, m[2] / R];
      const up = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
      const u = norm3(cross(d, up));
      const v = cross(d, u);
      const sph = (a, b) => {
        const w = norm3([d[0] + a * u[0] + b * v[0], d[1] + a * u[1] + b * v[1], d[2] + a * u[2] + b * v[2]]);
        return [w[0] * R, w[1] * R, w[2] * R];
      };
      for (let i = 0; i <= PN; i++) {
        const a = -PS + (2 * PS * i) / PN;
        for (let j = 0; j < PN; j++) {
          const b0 = -PS + (2 * PS * j) / PN, b1 = -PS + (2 * PS * (j + 1)) / PN;
          line(sph(a, b0), sph(a, b1), COL.patch, 1);
          line(sph(b0, a), sph(b1, a), COL.patch, 1);
        }
      }
    }

    // Marker (im Raum gesetzte Punkte).
    for (const m of markers) dot(m, COL.marker, 6);
    // Aktuelle Handy-Position.
    if (phone) dot(phone, COL.phone, 5);

    // Legende.
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillStyle = COL.path;   ctx.fillText('— Weg (roh)', 12, H - 62);
    if (corrected.length > 1) { ctx.fillStyle = COL.corr; ctx.fillText('— Weg (korrigiert)', 12, H - 46); }
    ctx.fillStyle = COL.marker; ctx.fillText('● Marker', 12, H - 30);
    ctx.fillStyle = COL.phone;  ctx.fillText('● Handy', 12, H - 14);

    // Kennzahlen (oben links): Dauer, Weglänge, Versatz, Schließfehler.
    if (scene.stats) {
      const s = scene.stats;
      ctx.font = '13px -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      const top = 22 + (window.innerWidth < 480 ? 24 : 0); // unter dem Hinweis-Chip
      ctx.fillText('Dauer:   ' + s.duration.toFixed(1) + ' s', 12, top);
      ctx.fillText('Weg:     ' + s.length.toFixed(2) + ' m', 12, top + 18);
      ctx.fillText('Versatz: ' + s.dist.toFixed(2) + ' m', 12, top + 36);
      if (s.closeError) {
        ctx.fillStyle = COL.corr;
        ctx.fillText('Schließfehler: ' + s.closeError.toFixed(2) + ' m', 12, top + 54);
      }
    }
  }
}
