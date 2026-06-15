/*
 * SoundPointer – Variante B: kohärente Audio-Analyse einer Zielfrequenz
 * ------------------------------------------------------------------
 * Statt einzelne Fenster getrennt auszuwerten (Timing nicht sample-genau),
 * läuft hier eine kontinuierliche LOCK-IN-DEMODULATION:
 *   I = Σ s·cos(φ_ref) , Q = Σ s·sin(φ_ref)
 * Der Referenz-Oszillator φ_ref läuft OHNE Unterbrechung über alle Audio-
 * Blöcke (this.ph trägt sich fort). Dadurch ist die gemessene Phase über
 * die Zeit KOHÄRENT: phase = φ_quelle − 2π·f·Abstand/c (Trägeranteil bereits
 * entfernt). Der Phasenvergleich zweier Messpunkte liefert direkt die
 * Laufzeitdifferenz – ohne einen separaten Δt-Korrekturterm.
 *
 * Umsetzung über ScriptProcessor (funktioniert auch auf iOS Safari).
 */

'use strict';

const TWO_PI = Math.PI * 2;

export class TargetTone {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.proc = null;
    this.zero = null;
    this.freq = 500;
    this.sr = 48000;
    this.w = 0;          // Referenz-Kreisfrequenz pro Sample
    this.ph = 0;         // fortlaufende Referenzphase (Kohärenz!)
    this.sampleIndex = 0;
    this.running = false;
    this.onWindow = null; // Callback je Audioblock
    this.latest = { mag: 0, db: -120, phase: 0, rms: 0, snr: 0, freq: 500, sr: 0, windowMs: 0 };
  }

  async start(freq) {
    this.freq = freq;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) { /* ignore */ } }
    this.sr = this.ctx.sampleRate;
    this.w = (TWO_PI * this.freq) / this.sr;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1); // ~85 ms Blöcke bei 48 kHz
    this.proc.onaudioprocess = (e) => this._process(e);
    // Stummschaltung: ScriptProcessor muss mit dem Ausgang verbunden sein, darf
    // den Mikrofonton aber nicht hörbar zurückspielen -> Gain 0.
    this.zero = this.ctx.createGain();
    this.zero.gain.value = 0;
    this.source.connect(this.proc);
    this.proc.connect(this.zero);
    this.zero.connect(this.ctx.destination);
    this.running = true;
  }

  setFreq(freq) {
    if (freq > 0) { this.freq = freq; this.w = (TWO_PI * freq) / this.sr; }
  }

  _process(e) {
    const input = e.inputBuffer.getChannelData(0);
    const N = input.length;
    const w = this.w;
    let ph = this.ph, I = 0, Q = 0, sumsq = 0;
    for (let i = 0; i < N; i++) {
      const s = input[i];
      sumsq += s * s;
      I += s * Math.cos(ph);
      Q += s * Math.sin(ph);
      ph += w;
      if (ph >= TWO_PI) ph -= TWO_PI;
    }
    this.ph = ph; // fortlaufende Phase -> Kohärenz über Blöcke hinweg
    this.sampleIndex += N;

    const mag = (Math.hypot(I, Q) * 2) / N;
    const phase = Math.atan2(Q, I);
    const rms = Math.sqrt(sumsq / N);
    const snr = mag / (rms + 1e-9);
    const db = 20 * Math.log10(mag + 1e-9);
    this.latest = { mag, db, phase, rms, snr, freq: this.freq, sr: this.sr, windowMs: (N / this.sr) * 1000 };
    if (this.onWindow) this.onWindow(this.latest);
  }

  stop() {
    this.running = false;
    if (this.proc) { this.proc.onaudioprocess = null; try { this.proc.disconnect(); } catch (e) {} this.proc = null; }
    if (this.zero) { try { this.zero.disconnect(); } catch (e) {} this.zero = null; }
    if (this.source) { try { this.source.disconnect(); } catch (e) {} this.source = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
  }
}
