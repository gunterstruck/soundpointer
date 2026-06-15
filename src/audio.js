/*
 * SoundPointer – Variante B: Audio-Analyse einer einzelnen Zielfrequenz
 * ------------------------------------------------------------------
 * Nimmt das Mikrofon auf und bestimmt fortlaufend Amplitude UND Phase
 * GENAU der vorgegebenen Zielfrequenz – per Goertzel-Algorithmus über ein
 * kurzes Zeitfenster. Keine vollständige FFT nötig.
 *
 * Die Phase ist die Grundlage für die spätere Bildung virtueller
 * Mikrofonpaare (Richtungsschätzung). Amplitude/Pegel dient als Live-
 * Rückmeldung und zur Qualitätsbewertung.
 */

'use strict';

export class TargetTone {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.source = null;
    this.buf = null;
    this.freq = 3000;
    this.running = false;
    this.latest = { magnitude: 0, db: -120, phase: 0, rms: 0, freq: 3000, sampleRate: 0, windowMs: 0 };
  }

  async start(freq) {
    this.freq = freq;
    // Wichtig: Audio-Vorverarbeitung aus, damit der echte Pegel/Phase erhalten bleibt.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) { /* ignore */ } }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    // ~340 ms Fenster bei 48 kHz – guter Kompromiss aus Frequenzschärfe und Reaktion.
    this.analyser.fftSize = 16384;
    this.analyser.smoothingTimeConstant = 0;
    this.source.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.running = true;
  }

  setFreq(freq) { if (freq > 0) this.freq = freq; }

  // Goertzel: Amplitude + Phase der Zielfrequenz im aktuellen Zeitfenster.
  analyze() {
    if (!this.running || !this.analyser) return this.latest;
    this.analyser.getFloatTimeDomainData(this.buf);
    const sr = this.ctx.sampleRate;
    const N = this.buf.length;
    const w = (2 * Math.PI * this.freq) / sr;
    const cw = Math.cos(w), sw = Math.sin(w), coeff = 2 * cw;

    let s1 = 0, s2 = 0, sumsq = 0;
    for (let n = 0; n < N; n++) {
      const x = this.buf[n];
      sumsq += x * x;
      const s0 = x + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const real = s1 - s2 * cw;
    const imag = s2 * sw;
    const magnitude = (Math.hypot(real, imag) * 2) / N; // ~ Amplitude der Sinuskomponente
    const phase = Math.atan2(imag, real);               // Radiant
    const rms = Math.sqrt(sumsq / N);
    const db = 20 * Math.log10(magnitude + 1e-9);
    // Verhältnis Zielfrequenz zur Gesamtenergie: ~1.4 bei reinem Ton, klein bei Rauschen.
    // Distanzunabhängig -> robuste Erkennung auch bei leisem (entferntem) Ton.
    const snr = magnitude / (rms + 1e-9);

    this.latest = { magnitude, db, phase, rms, snr, freq: this.freq, sampleRate: sr, windowMs: (N / sr) * 1000 };
    return this.latest;
  }

  stop() {
    this.running = false;
    if (this.source) { try { this.source.disconnect(); } catch (e) { /* ignore */ } this.source = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    this.analyser = null;
  }
}
