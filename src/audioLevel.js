/*
 * SoundPointer – Mode C "Akustische Taschenlampe": Pegel-/Zielscore-Messung
 * ------------------------------------------------------------------
 * Misst pro Zeitfenster den Pegel (RMS) und die Energie im Zielband (2–6 kHz)
 * eines (bevorzugt externen, gerichteten) Mikrofons. Daraus entsteht ein
 * normalisierter Score 0..1 für die Richtungs-Heatmap. KEINE Phase/Position –
 * nur Lautstärke in Blickrichtung. Robust gegen Sensordrift.
 */

'use strict';

const TARGET_LO = 2000, TARGET_HI = 6000; // Zielband (Hz)

export class LevelMeter {
  constructor() {
    this.ctx = null; this.stream = null; this.source = null; this.analyser = null;
    this.td = null; this.fd = null; this.running = false;
    this.bandMax = 1e-9;          // langsam gleitendes Maximum zur Normalisierung
    this.devLabel = ''; this.channels = 1;
    this.dbHist = [];             // für AGC-Verdacht
  }

  static async listInputs() {
    try {
      const ds = await navigator.mediaDevices.enumerateDevices();
      return ds.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label || 'Mikrofon' }));
    } catch (e) { return []; }
  }

  static isExternal(label) {
    return /rode|røde|usb|extern|interface|videomic|me-?c/i.test(label || '');
  }

  async start(deviceId) {
    const audio = {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      channelCount: { ideal: 2 },
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const t = this.stream.getAudioTracks()[0];
    const s = (t && t.getSettings) ? t.getSettings() : {};
    this.devLabel = (t && t.label) || '';
    this.channels = s.channelCount || 1;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) { /* ignore */ } }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.source.connect(this.analyser);
    this.td = new Float32Array(this.analyser.fftSize);
    this.fd = new Float32Array(this.analyser.frequencyBinCount);
    this.running = true;
  }

  read() {
    if (!this.running || !this.analyser) return null;
    const N = this.td.length;
    this.analyser.getFloatTimeDomainData(this.td);
    let sq = 0, peak = 0;
    for (let i = 0; i < N; i++) { const x = this.td[i]; sq += x * x; const a = Math.abs(x); if (a > peak) peak = a; }
    const rms = Math.sqrt(sq / N);
    const clip = peak > 0.985;

    this.analyser.getFloatFrequencyData(this.fd);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    let band = 0, total = 0;
    for (let k = 1; k < this.fd.length; k++) {
      const p = Math.pow(10, this.fd[k] / 10);
      if (!isFinite(p)) continue;
      total += p;
      const f = k * binHz;
      if (f >= TARGET_LO && f <= TARGET_HI) band += p;
    }
    const bandRatio = band / (total + 1e-12);
    const levelDb = 20 * Math.log10(rms + 1e-7);
    this.bandMax = Math.max(band, this.bandMax * 0.997); // langsamer Zerfall
    const score = Math.max(0, Math.min(1, band / (this.bandMax + 1e-12)));
    const quality = (clip ? 0.4 : 1)
      * Math.max(0, Math.min(1, (levelDb + 70) / 45))
      * Math.max(0.2, Math.min(1, bandRatio / 0.15));

    // AGC-Verdacht: bei echtem Signal sollte der Pegel schwanken.
    this.dbHist.push(levelDb); if (this.dbHist.length > 45) this.dbHist.shift();
    let agc = false;
    if (this.dbHist.length >= 35 && levelDb > -50) {
      const m = this.dbHist.reduce((a, b) => a + b, 0) / this.dbHist.length;
      let v = 0; for (const x of this.dbHist) v += (x - m) * (x - m);
      agc = Math.sqrt(v / this.dbHist.length) < 0.4;
    }
    return { rms, levelDb, band, bandRatio, score, quality, clip, agc, channels: this.channels, label: this.devLabel };
  }

  stop() {
    this.running = false;
    if (this.source) { try { this.source.disconnect(); } catch (e) {} this.source = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    this.analyser = null;
  }
}
