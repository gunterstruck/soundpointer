/*
 * SoundPointer – Modus D: kohärente Lock-in-Phasenmessung
 * ------------------------------------------------------------------
 * Demoduliert das Mikrofonsignal gegen einen DURCHLAUFENDEN Referenz-
 * Oszillator (Phase trägt sich über alle Audioblöcke fort). Dadurch ist
 * die gemessene Phase über die Zeit KOHÄRENT (sample-genau) – Voraussetzung
 * für das phasenbasierte Beamforming des virtuellen Arrays.
 *
 * Jeder Audioblock ruft onWindow({ t, phase, amp, snr }) auf.
 * (ScriptProcessor läuft auch zuverlässig auf Android-Chrome.)
 */

'use strict';

const TWO_PI = Math.PI * 2;

export class CoherentTone {
  constructor() {
    this.ctx = null; this.stream = null; this.source = null; this.proc = null; this.zero = null;
    this.freq = 1200; this.sr = 48000; this.w = 0; this.ph = 0;
    this.running = false; this.onWindow = null;
  }

  async start(freq, deviceId) {
    this.freq = freq;
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) { /* ignore */ } }
    this.sr = this.ctx.sampleRate;
    this.w = (TWO_PI * this.freq) / this.sr;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(2048, 1, 1); // ~43 ms Blöcke (mehr Samples/Bogen)
    this.proc.onaudioprocess = (e) => this._process(e);
    this.zero = this.ctx.createGain(); this.zero.gain.value = 0;
    this.source.connect(this.proc); this.proc.connect(this.zero); this.zero.connect(this.ctx.destination);
    this.running = true;
  }

  setFreq(freq) { if (freq > 0) { this.freq = freq; this.w = (TWO_PI * freq) / this.sr; } }

  _process(e) {
    const input = e.inputBuffer.getChannelData(0);
    const N = input.length, w = this.w;
    let ph = this.ph, I = 0, Q = 0, sumsq = 0;
    for (let i = 0; i < N; i++) {
      const s = input[i]; sumsq += s * s;
      I += s * Math.cos(ph); Q += s * Math.sin(ph);
      ph += w; if (ph >= TWO_PI) ph -= TWO_PI;
    }
    this.ph = ph; // Kohärenz über Blöcke
    const amp = (Math.hypot(I, Q) * 2) / N;
    const phase = Math.atan2(Q, I);
    const rms = Math.sqrt(sumsq / N);
    const snr = amp / (rms + 1e-9);
    if (this.onWindow) this.onWindow({ t: performance.now(), phase, amp, snr });
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
