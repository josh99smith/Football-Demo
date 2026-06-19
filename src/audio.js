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
// Announcer commentary. Synth-first: the browser's SpeechSynthesis SPEAKS a
// random line per event. Drop real voice clips into VO_CLIPS (e.g.
// td: ['assets/vo/td1.mp3', 'assets/vo/td2.mp3']) and they'll be used instead —
// kept empty for now so nothing 404s.
const VO_LINES = {
  bigHit:    ['Big hit!', 'Oh, he laid him out!', 'What a shot!'],
  dirtyHit:  ['Dirty hit!', "He's gonna feel that one!", 'That was uncalled for!'],
  gang:      ['Gang tackle!', 'They swarmed him!', 'Buried him!'],
  td:        ['Touchdown!', "He's in! Touchdown!", 'Six points!'],
  fumble:    ['Fumble!', 'The ball is loose!', 'He coughed it up!'],
  pick:      ['Intercepted!', 'Picked off!', 'What a pick!'],
  safety:    ['Safety! Two points!', 'Got him in the end zone!'],
  onFire:    ["He's on fire!", 'Unstoppable!', 'Somebody stop this guy!'],
  firstDown: ['First down!', "Movin' the chains!"],
  sack:      ['Sack!', 'Got the quarterback!', 'Dropped him!'],
  scramble:  ['He takes off!', 'Out of the pocket!'],
  win:       ['That\'s the ballgame!', 'Final whistle — what a win!', 'Your champions!'],
  lose:      ['Tough loss out there.', 'Not their night.', 'They left it all on the field.'],
};
const VO_CLIPS = {
  bigHit:    ['assets/vo/bigHit1.mp3', 'assets/vo/bigHit2.mp3', 'assets/vo/bigHit3.mp3',
              'assets/vo/bigHit4.mp3', 'assets/vo/bigHit5.mp3', 'assets/vo/bigHit6.mp3'],
  dirtyHit:  ['assets/vo/dirtyHit1.mp3', 'assets/vo/dirtyHit2.mp3', 'assets/vo/dirtyHit3.mp3',
              'assets/vo/dirtyHit4.mp3', 'assets/vo/dirtyHit5.mp3', 'assets/vo/dirtyHit6.mp3'],
  gang:      ['assets/vo/gang1.mp3', 'assets/vo/gang2.mp3', 'assets/vo/gang3.mp3',
              'assets/vo/gang4.mp3', 'assets/vo/gang5.mp3', 'assets/vo/gang6.mp3'],
  td:        ['assets/vo/td1.mp3', 'assets/vo/td2.mp3', 'assets/vo/td3.mp3', 'assets/vo/td4.mp3',
              'assets/vo/td5.mp3', 'assets/vo/td6.mp3', 'assets/vo/td7.mp3', 'assets/vo/td8.mp3',
              'assets/vo/td9.mp3', 'assets/vo/td10.mp3', 'assets/vo/td11.mp3', 'assets/vo/td12.mp3',
              'assets/vo/td13.mp3', 'assets/vo/td14.mp3', 'assets/vo/td15.mp3', 'assets/vo/td16.mp3',
              'assets/vo/td17.mp3'],
  fumble:    ['assets/vo/fumble1.mp3', 'assets/vo/fumble2.mp3', 'assets/vo/fumble3.mp3', 'assets/vo/fumble4.mp3',
              'assets/vo/fumble5.mp3', 'assets/vo/fumble6.mp3', 'assets/vo/fumble7.mp3', 'assets/vo/fumble8.mp3'],
  firstDown: ['assets/vo/firstDown1.mp3', 'assets/vo/firstDown2.mp3', 'assets/vo/firstDown3.mp3', 'assets/vo/firstDown4.mp3',
              'assets/vo/firstDown5.mp3', 'assets/vo/firstDown6.mp3', 'assets/vo/firstDown7.mp3', 'assets/vo/firstDown8.mp3'],
  sack:      ['assets/vo/sack1.mp3', 'assets/vo/sack2.mp3', 'assets/vo/sack3.mp3',
              'assets/vo/sack4.mp3', 'assets/vo/sack5.mp3', 'assets/vo/sack6.mp3'],
  scramble:  ['assets/vo/scramble1.mp3', 'assets/vo/scramble2.mp3', 'assets/vo/scramble3.mp3', 'assets/vo/scramble4.mp3'],
};
export class AudioManager {
  constructor() {
    this.ctx = null; this.ready = false; this.master = null; this.noiseBuf = null;
    this.buffers = {}; this._raw = {};
    this.vo = {};        // event -> [AudioBuffer,...] of real announcer clips
    this._voRaw = {};    // event -> [ArrayBuffer,...] awaiting decode
    this._voCd = 0;      // wall-clock gate so lines don't stomp each other
    this.music = null;   // currently-playing music source/gain
    this.muted = false;  // master mute (settings can flip this)
    this.voEnabled = true;
    this._fetchSamples(); // start downloading immediately (decode later)
  }

  // Pull the encoded audio as ArrayBuffers now; decode once we have a context.
  _fetchSamples() {
    for (const [name, url] of Object.entries(SAMPLES)) {
      fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
        .then((buf) => { this._raw[name] = buf; if (this.ctx) this._decode(name); })
        .catch(() => { /* missing sample — synth fallback stays in play */ });
    }
    // Real announcer clips (optional). VO_CLIPS is empty by default so nothing
    // 404s; drop files in and they override the SpeechSynthesis fallback.
    for (const [event, urls] of Object.entries(VO_CLIPS)) {
      (urls || []).forEach((url, i) => {
        fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
          .then((buf) => {
            (this._voRaw[event] || (this._voRaw[event] = []))[i] = buf;
            if (this.ctx) this._decodeVo(event, i);
          })
          .catch(() => { /* missing clip — synth line stays in play */ });
      });
    }
  }
  _decodeVo(event, i) {
    const arr = this._voRaw[event]; if (!arr || !arr[i] || !this.ctx) return;
    const raw = arr[i]; arr[i] = null;
    this.ctx.decodeAudioData(raw.slice(0))
      .then((b) => { (this.vo[event] || (this.vo[event] = []))[i] = b; })
      .catch(() => {});
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
        for (const event of Object.keys(this._voRaw))
          (this._voRaw[event] || []).forEach((_, i) => this._decodeVo(event, i));
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

  // --- announcer commentary ---
  // Pick a punchy English voice for the play-by-play. Cached after first lookup.
  _voice() {
    if (this._voiceCached !== undefined) return this._voiceCached;
    let v = null;
    try {
      const list = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      const en = list.filter((x) => /en[-_]/i.test(x.lang) || /^en$/i.test(x.lang));
      // Prefer a male/announcer-ish voice if the platform exposes one.
      v = en.find((x) => /(daniel|google uk english male|fred|alex|aaron|arthur)/i.test(x.name))
        || en.find((x) => /male/i.test(x.name)) || en[0] || list[0] || null;
    } catch (e) { /* no speech synth */ }
    // getVoices() is often empty until the list loads — only cache a real hit.
    if (v) this._voiceCached = v;
    return v;
  }

  /** Speak a line for a game event. Plays a real VO clip if loaded, else uses
   *  SpeechSynthesis with a random line. `force` bypasses the cooldown for
   *  marquee moments (TD, safety). Lifts the crowd bed under the call. */
  say(event, { force = false, swell = 0.4 } = {}) {
    if (!this.voEnabled || this.muted) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!force && now < this._voCd) return;
    this._voCd = now + 1100; // ~1.1s gate so calls don't trample each other
    if (swell) this.swell(swell);
    // Real clip path.
    const clips = this.vo[event];
    if (clips && clips.length) {
      const b = clips[(Math.random() * clips.length) | 0];
      if (b && this.ready) {
        const src = this.ctx.createBufferSource(); src.buffer = b;
        const g = this.ctx.createGain(); g.gain.value = 0.95;
        src.connect(g); g.connect(this.master); src.start(this.t);
        return;
      }
    }
    // Synth fallback: speak a random scripted line.
    const lines = VO_LINES[event];
    if (!lines || !lines.length) return;
    try {
      const synth = window.speechSynthesis; if (!synth) return;
      if (force) synth.cancel(); // marquee call cuts in over chatter
      const u = new SpeechSynthesisUtterance(lines[(Math.random() * lines.length) | 0]);
      const v = this._voice(); if (v) u.voice = v;
      u.rate = 1.05; u.pitch = 0.8; u.volume = 0.9;
      synth.speak(u);
    } catch (e) { /* speech unavailable — silent */ }
  }

  // --- music (menu / on-fire bed) ---
  // Loops a decoded buffer at low gain under the action. url is loaded lazily.
  playMusic(url, { gain = 0.25, loop = true } = {}) {
    if (!this.ready) return;
    this.stopMusic();
    this._musicGain = gain; // live target so a duck during decode still lands
    const start = (buf) => {
      if (!buf || this.music) return;
      const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = loop;
      const g = this.ctx.createGain(); g.gain.value = this.muted ? 0 : this._musicGain;
      src.connect(g); g.connect(this.master); src.start(this.t);
      this.music = { src, g };
    };
    if (this._musicBuf && this._musicBuf.url === url) { start(this._musicBuf.buf); return; }
    fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
      .then((raw) => this.ctx.decodeAudioData(raw.slice(0)))
      .then((buf) => { this._musicBuf = { url, buf }; start(buf); })
      .catch(() => { /* no music file — silence */ });
  }
  // Smoothly ride the music bed up/down (e.g. duck under gameplay). Works even
  // if the track is still decoding — the new target is applied when it starts.
  setMusicGain(gain, ramp = 0.8) {
    this._musicGain = gain;
    if (!this.music) return;
    const t = this.t, g = this.music.g.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.muted ? 0 : gain, t + ramp);
  }
  stopMusic() {
    if (!this.music) return;
    const t = this.t, m = this.music; this.music = null;
    try {
      m.g.gain.cancelScheduledValues(t);
      m.g.gain.setValueAtTime(m.g.gain.value, t);
      m.g.gain.linearRampToValueAtTime(0.0001, t + 0.4);
      m.src.stop(t + 0.45);
    } catch (e) { /* already stopped */ }
  }
}
