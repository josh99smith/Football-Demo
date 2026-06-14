// Procedural arcade sound (WebAudio) layered with a handful of real recorded
// SFX (whistle, catch, tackle, fence carom, crowd goal reaction). Samples are
// fetched up front and decoded once the AudioContext exists (first gesture);
// if a sample is missing or still decoding we fall back to the synth cue, so
// the game always has sound.
const SAMPLES = {
  whistle: 'assets/sfx/whistle.mp3',
  catch:   'assets/sfx/catch.wav',
  hit:     'assets/sfx/hit.wav',
  fence:   'assets/sfx/fence.wav',
  goal:    'assets/sfx/goal.mp3',
};
export class AudioManager {
  constructor() {
    this.ctx = null; this.ready = false; this.master = null; this.noiseBuf = null;
    this.buffers = {}; this._raw = {};
    this._fetchSamples(); // start downloading immediately (decode later)
  }

  // Pull the encoded audio as ArrayBuffers now; decode once we have a context.
  _fetchSamples() {
    for (const [name, url] of Object.entries(SAMPLES)) {
      fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
        .then((buf) => { this._raw[name] = buf; if (this.ctx) this._decode(name); })
        .catch(() => { /* missing sample — synth fallback stays in play */ });
    }
  }
  _decode(name) {
    const raw = this._raw[name]; if (!raw || !this.ctx) return;
    delete this._raw[name];
    // decodeAudioData detaches the buffer, so hand it a copy.
    this.ctx.decodeAudioData(raw.slice(0))
      .then((b) => { this.buffers[name] = b; })
      .catch(() => {});
  }

  unlock() {
    if (!this.ctx) {
      try {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return;
        this.ctx = new C();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
        // One second of white noise, reused for hits / whooshes / crowd.
        const n = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, n, n);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        this.ready = true;
        for (const name of Object.keys(this._raw)) this._decode(name); // decode whatever arrived first
        this.startAmbience();
      } catch (e) { /* no audio — game still runs */ }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  get t() { return this.ctx.currentTime; }

  // Play a decoded sample. Returns true if it fired (so callers can skip their
  // synth fallback). `offset`/`duration` clip a region; `rate` repitches.
  play(name, { gain = 0.8, rate = 1, offset = 0, duration = null, delay = 0 } = {}) {
    const buf = this.buffers[name];
    if (!this.ready || !buf) return false;
    const t = this.t + delay;
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(this.master);
    if (duration != null) src.start(t, offset, duration); else src.start(t, offset);
    return true;
  }

  // A continuous filtered-noise crowd murmur under everything; swell() lifts it
  // on big moments so the stadium feels alive.
  startAmbience() {
    if (this.amb || !this.ready) return;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 0.5;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
    const g = this.ctx.createGain(); g.gain.value = 0.035;
    src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(this.master);
    src.start(); this.amb = g;
  }
  swell(amount = 0.5) {
    if (!this.amb) return; const t = this.t;
    this.amb.gain.cancelScheduledValues(t);
    this.amb.gain.setValueAtTime(Math.max(0.035, this.amb.gain.value), t);
    this.amb.gain.linearRampToValueAtTime(0.035 + 0.13 * amount, t + 0.15);
    this.amb.gain.linearRampToValueAtTime(0.035, t + 0.7 + amount * 1.3);
  }

  _tone(freq, dur, { type = 'sine', gain = 0.3, slideTo = null, delay = 0 } = {}) {
    if (!this.ready) return;
    const t = this.t + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _noise(dur, { gain = 0.3, type = 'lowpass', freq = 1200, q = 1, delay = 0 } = {}) {
    if (!this.ready) return;
    const t = this.t + delay;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  // --- gameplay cues ---
  hike() { this._noise(0.12, { gain: 0.25, freq: 500 }); this._tone(150, 0.1, { type: 'square', gain: 0.12 }); }
  throwPass() { this._noise(0.22, { gain: 0.3, type: 'bandpass', freq: 900, q: 0.8 }); }
  // Recorded ball-into-hands smack (first 0.9s); synth chirp if not loaded yet.
  catch() {
    if (this.play('catch', { gain: 0.9 })) return;
    this._tone(620, 0.09, { type: 'triangle', gain: 0.28 }); this._noise(0.05, { gain: 0.15, freq: 2500 });
  }
  juke() { this._noise(0.18, { gain: 0.22, type: 'bandpass', freq: 1600, q: 1.2 }); this._tone(700, 0.12, { type: 'sine', gain: 0.1, slideTo: 1200 }); }

  /** A tackle: real pad-pop-with-grunts sample (pitched/leveled by intensity),
   *  or a synth thud + crack if the sample isn't ready. `intensity` 0..1. */
  hit(intensity = 0.6) {
    const i = Math.max(0.2, Math.min(1, intensity));
    if (this.play('hit', { gain: 0.55 + i * 0.5, rate: 1.12 - i * 0.28 })) {
      if (i > 0.85) this._tone(70, 0.28, { type: 'sine', gain: 0.22, slideTo: 35 }); // extra low boom on big ones
      return;
    }
    this._tone(110, 0.18 + i * 0.12, { type: 'sine', gain: 0.4 * i, slideTo: 45 });
    this._noise(0.1 + i * 0.08, { gain: 0.3 * i, freq: 700 });
  }
  // The chain-link carom: real fence-rattle sample, else a synth tick.
  fence(intensity = 0.5) {
    const i = Math.max(0.2, Math.min(1, intensity));
    if (this.play('fence', { gain: 0.35 + i * 0.5, rate: 0.92 + Math.random() * 0.18 })) return;
    this.hit(i * 0.5);
  }
  bigHit() { this.hit(1); this.cheer(0.7); }

  /** Crowd swell from filtered noise (TD / big plays). */
  cheer(amount = 0.5) {
    if (!this.ready) return;
    this.swell(amount); // lift the ambient crowd bed too
    const t = this.t, dur = 0.6 + amount * 1.4;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.18 * amount, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.05);
  }
  groan() {
    if (!this.ready) return;
    const t = this.t;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.95);
  }
  // Real referee whistle (clipped to one blast); synth pair as fallback.
  whistle() {
    if (this.play('whistle', { gain: 0.5, offset: 0, duration: 1.1 })) return;
    this._tone(2300, 0.16, { type: 'square', gain: 0.18, slideTo: 2500 });
    this._tone(2300, 0.16, { type: 'square', gain: 0.16, slideTo: 2500, delay: 0.2 });
  }
  touchdown() {
    [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 0.18, { type: 'square', gain: 0.22, delay: i * 0.1 }));
    // Roaring crowd goal reaction over the fanfare (else the synth cheer).
    if (!this.play('goal', { gain: 0.6, duration: 5 })) this.cheer(1);
    else this.swell(1);
  }
  fire() { this._noise(0.5, { gain: 0.25, type: 'bandpass', freq: 1800, q: 0.5 }); this._tone(300, 0.5, { type: 'sawtooth', gain: 0.12, slideTo: 900 }); }
}
