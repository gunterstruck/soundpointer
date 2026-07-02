/*
 * SoundPointer – Mode C "Akustische HF-Taschenlampe": Pegel-/Zielscore-Messung
 * ------------------------------------------------------------------
 * Hört AUSSCHLIESSLICH das Hochfrequenz-Band 12–20 kHz (dort ist die
 * Richtwirkung eines kleinen gerichteten Mikrofons am stärksten und
 * Umgebungs-/Maschinenlärm am leisesten). Score 0..1 = HF-Pegel über einem
 * adaptiv mitlaufenden Rauschteppich. KEINE Phase/Position – nur Lautstärke
 * in Blickrichtung. Robust gegen Sensordrift.
 */

'use strict';

const HF_LO = 12000, HF_HI = 20000;       // festes Hörband (Hz) – darunter taub
const PROM_LO = 4, PROM_HI = 18;          // Ton-Prominenz (dB) -> Score 0..1
const SNR_LO = 5, SNR_HI = 20;            // HF-Pegel über Rauschteppich (dB) -> Score 0..1
const HF_ABS_GATE = -88;                  // absoluter Mindestpegel (dBFS), sonst Score 0

export class LevelMeter {
  constructor() {
    this.ctx = null; this.stream = null; this.source = null; this.analyser = null;
    this.td = null; this.fd = null; this.running = false;
    this.floorDb = null;          // adaptiver HF-Rauschteppich (dB), lernt sich ein
    this.targetFreq = 0;          // 0 = ganzes HF-Band (12–20 kHz), >0 = schmalbandig (>=12 kHz)
    this.scoreEma = 0;            // geglätteter Score (ruhiger im Lärm)
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

  // Optionale Zielfrequenz (Hz), auf das HF-Band begrenzt. 0/leer = ganzes Band 12–20 kHz.
  setTarget(freq) {
    this.targetFreq = freq > 0 ? Math.min(HF_HI, Math.max(HF_LO, freq)) : 0;
    this.floorDb = null; // Rauschteppich neu einlernen (Skala ändert sich)
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
    // Feine Frequenzauflösung (~6 Hz/Bin bei 48 kHz): trennt einen Störton
    // sauber vom breitbandigen Industrierauschen.
    this.analyser.fftSize = 8192;
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

    let scoreNow, bandRatio, promDb;
    const levelDb = 20 * Math.log10(rms + 1e-7);
    // HF-Bandgrenzen (12–20 kHz), an die tatsächliche Abtastrate geklemmt.
    const nyq = this.ctx.sampleRate / 2;
    const hfLo = HF_LO, hfHi = Math.min(HF_HI, nyq * 0.98);
    let hfSum = 0, hfN = 0;
    if (this.targetFreq > 0) {
      // Schmalbandig (>=12 kHz): ABSOLUTE Ton-Prominenz = Ziel ggü. HF-Nachbarband (dB).
      const f0 = this.targetFreq;
      const bw = Math.max(2 * binHz, 30); // enges Zielband (~±30 Hz)
      let band = 0, nb = 0, guard = 0, ng = 0, total = 0;
      for (let k = 1; k < this.fd.length; k++) {
        const fk = k * binHz;
        if (fk < hfLo || fk > hfHi) continue; // unterhalb 12 kHz taub
        const p = Math.pow(10, this.fd[k] / 10);
        if (!isFinite(p)) continue;
        total += p; hfSum += p; hfN++;
        const df = Math.abs(fk - f0);
        if (df <= bw) { band += p; nb++; }
        else if (df >= 150 && df <= 600) { guard += p; ng++; }
      }
      const bandAvg = nb ? band / nb : 0;
      const guardAvg = ng ? guard / ng : 1e-12;
      promDb = 10 * Math.log10((bandAvg + 1e-12) / (guardAvg + 1e-12));
      // 0..1 erst ab spürbarer Prominenz: Rauschen (~0 dB) -> 0, klarer Ton -> 1.
      scoreNow = Math.max(0, Math.min(1, (promDb - PROM_LO) / (PROM_HI - PROM_LO)));
      bandRatio = band / (total + 1e-12);
    } else {
      // Ganzes HF-Band: Pegel 12–20 kHz relativ zum adaptiv gelernten Rauschteppich.
      for (let k = 1; k < this.fd.length; k++) {
        const fk = k * binHz;
        if (fk < hfLo || fk > hfHi) continue;
        const p = Math.pow(10, this.fd[k] / 10);
        if (isFinite(p)) { hfSum += p; hfN++; }
      }
      const hfDb = 10 * Math.log10((hfN ? hfSum / hfN : 0) + 1e-12);
      // Rauschteppich: fällt schnell mit, steigt nur langsam (Minimum-Tracker).
      if (this.floorDb == null) this.floorDb = hfDb;
      this.floorDb += (hfDb - this.floorDb) * (hfDb < this.floorDb ? 0.30 : 0.006);
      promDb = hfDb - this.floorDb; // "Prominenz" = dB über Teppich
      scoreNow = (hfDb <= HF_ABS_GATE) ? 0
        : Math.max(0, Math.min(1, (promDb - SNR_LO) / (SNR_HI - SNR_LO)));
      bandRatio = 0;
    }
    const hfDbOut = 10 * Math.log10((hfN ? hfSum / hfN : 0) + 1e-12);

    this.scoreEma += (scoreNow - this.scoreEma) * 0.35; // leichte zeitliche Glättung
    const score = this.scoreEma;
    // Qualität am HF-Band festmachen (Breitband darf still sein, solange HF ankommt).
    const qDb = Math.max(levelDb, hfDbOut);
    const quality = (clip ? 0.4 : 1) * Math.max(0, Math.min(1, (qDb + 82) / 45));

    // AGC-Verdacht: bei echtem Signal sollte der Pegel schwanken.
    this.dbHist.push(levelDb); if (this.dbHist.length > 45) this.dbHist.shift();
    let agc = false;
    if (this.dbHist.length >= 35 && levelDb > -50) {
      const m = this.dbHist.reduce((a, b) => a + b, 0) / this.dbHist.length;
      let v = 0; for (const x of this.dbHist) v += (x - m) * (x - m);
      agc = Math.sqrt(v / this.dbHist.length) < 0.4;
    }
    return { rms, levelDb, promDb, hfDb: hfDbOut, floorDb: this.floorDb, bandRatio, score, quality, clip, agc, channels: this.channels, label: this.devLabel, targetFreq: this.targetFreq };
  }

  stop() {
    this.running = false;
    if (this.source) { try { this.source.disconnect(); } catch (e) {} this.source = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    this.analyser = null;
  }
}
