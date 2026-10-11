/*
 * music.js — FM music: AUDIOHED/AUDIOT parsing, the IMF sequencer, and the bridge
 * to Web Audio.
 *
 * AUDIOT holds no notes. It holds *register writes* for the sound card's OPL2 (YM3812) chip,
 * in the IMF format: four bytes per packet — register, value, and a 16-bit delay
 * measured in ticks of a 700 Hz clock (SDL_t0FastAsmService ran at 700 Hz). The
 * sequencer below walks that list and hands the writes to opl2.js, which is the chip.
 *
 * Chunk layout (audiowl6.h): 87 logical sounds, three tables of them (PC speaker,
 * FM, digitised), so the music starts at chunk 3*87 = 261 and there are 27 tracks.
 * Unlike VGAGRAPH, AUDIOT is not compressed — the chunks are raw.
 */
(function (root) {
	'use strict';

	// AUDIOT layout: PC sounds [0..NUMSOUNDS), AdLib effects [NUMSOUNDS..2*NUMSOUNDS),
	// digi [2*NUMSOUNDS..3*NUMSOUNDS), music [3*NUMSOUNDS..). NUMSOUNDS is a per-dataset
	// compile-time constant (WL6 = 87, SPEAR = 81), so the FM-effect and music bases
	// differ between Wolfenstein and Spear — hardcoding WL6's 87/261 made SOD pickup
	// sounds read the wrong chunks and would shift SOD music too. Derived from the
	// active variant's numSounds below; the values here are the WL6 defaults.
	var STARTMUSIC = 261;      // 3 * NUMSOUNDS
	var STARTFX = 87;          // NUMSOUNDS — where the FM sound-effect table starts
	var NUM_MUSIC = 27;
	if (root.WolfVariant) {
		root.WolfVariant.onUse(function (v) {
			var n = (v && v.numSounds) || 87;
			STARTFX = n;
			STARTMUSIC = 3 * n;
		});
	}
	var IMF_RATE = 700;        // the sequencer's tick rate, in Hz
	var SFX_RATE = 140;        // FM effects step every 5th tick (soundTimeCounter = 5)

	// ---- AUDIOHED / AUDIOT ---------------------------------------------------
	function WolfAudio(audiohed, audiot) {
		this.data = new Uint8Array(audiot);
		var dv = new DataView(audiohed);
		var n = (audiohed.byteLength / 4) | 0;
		this.starts = new Int32Array(n);
		for (var i = 0; i < n; i++) this.starts[i] = dv.getInt32(i * 4, true);
	}

	WolfAudio.prototype.chunk = function (index) {
		if (index < 0 || index + 1 >= this.starts.length) return null;
		var from = this.starts[index], to = this.starts[index + 1];
		if (from < 0 || to <= from || to > this.data.length) return null;
		return this.data.subarray(from, to);
	};

	// An FM sound effect: an instrument, an octave, and a list of note bytes played
	// one per 140 Hz tick (a zero byte means "key off"). This is where the pickup and
	// locked-door sounds live — they were never digitised, so VSWAP does not have them.
	//
	//   0   uint32  length of the note data
	//   4   uint16  priority
	//   6   16 x u8 instrument (mChar, cChar, mScale, cScale, mAttack, cAttack,
	//               mSus, cSus, mWave, cWave, nConn, and three unused Muse bytes)
	//   22  u8      block (the octave)
	//   23  ...     note data
	WolfAudio.prototype.fx = function (index) {
		var raw = this.chunk(STARTFX + index);
		if (!raw || raw.length < 24) return null;
		var dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
		var len = dv.getUint32(0, true);
		if (len <= 0 || 23 + len > raw.length) len = raw.length - 23;
		var I = {
			mChar: raw[6], cChar: raw[7],
			mScale: raw[8], cScale: raw[9],
			mAttack: raw[10], cAttack: raw[11],
			mSus: raw[12], cSus: raw[13],
			mWave: raw[14], cWave: raw[15]
		};
		// A sound with no sustain on either cell is what the original calls a bad
		// instrument; better to stay silent than to write nonsense to the chip.
		if (!(I.mSus | I.cSus)) return null;
		return { inst: I, block: raw[22], data: raw.subarray(23, 23 + len) };
	};

	WolfAudio.prototype.musicCount = function () {
		var n = 0;
		for (var i = 0; i < NUM_MUSIC; i++) if (this.chunk(STARTMUSIC + i)) n++;
		return n;
	};

	// A track as the sequencer wants it: the register stream, minus the length word.
	WolfAudio.prototype.music = function (song) {
		var raw = this.chunk(STARTMUSIC + song);
		if (!raw || raw.length < 4) return null;
		// SD_StartMusic: a leading word of 0 means "no header, the chunk IS the data";
		// anything else is the length of the data that follows it.
		var head = raw[0] | (raw[1] << 8);
		if (head === 0) return raw;
		var len = Math.min(head, raw.length - 2);
		return raw.subarray(2, 2 + len);
	};

	WolfAudio.STARTMUSIC = STARTMUSIC;
	WolfAudio.NUM_MUSIC = NUM_MUSIC;

	// ---- IMF sequencer -------------------------------------------------------
	// Drives an OPL2 through a track, one 700 Hz tick at a time. Loops at the end,
	// which is what the original does too (the music never stops on a floor).
	function ImfPlayer(opl, track) {
		this.opl = opl;
		this.track = track;
		this.pos = 0;
		this.wait = 0;        // ticks still to wait before the next write
	}

	ImfPlayer.prototype.rewind = function () { this.pos = 0; this.wait = 0; };

	// Advance the sequence by one tick, performing every write that is due.
	ImfPlayer.prototype.tick = function () {
		if (this.wait > 0) { this.wait--; return; }
		var t = this.track;
		while (this.pos + 3 < t.length) {
			var reg = t[this.pos], val = t[this.pos + 1];
			var delay = t[this.pos + 2] | (t[this.pos + 3] << 8);
			this.pos += 4;
			this.opl.write(reg, val);
			if (delay) { this.wait = delay - 1; return; }   // this tick is used up
		}
		if (this.pos + 3 >= t.length) this.rewind();        // loop
	};

	// ---- Shared FM engine ----------------------------------------------------
	// The whole synthesis chain — the OPL2 chip, the IMF sequencer, the FM sound
	// effect, the 700/140 Hz clocks and the resampler — lives in this one factory.
	// The music worker (musicworker.js) loads this file and calls it, and so does
	// the main-thread ScriptProcessor fallback: one source of truth for how a
	// sample is made.
	function createFmEngine(OPL2Ctor, sampleRate) {
		'use strict';
		var IMF_RATE = 700;      // sequencer tick rate
		var SFX_RATE = 140;      // FM effect step rate (soundTimeCounter = 5)
		var RATE = OPL2Ctor.RATE;
		var opl = new OPL2Ctor();

		var track = null, pos = 0, wait = 0;    // inline IMF sequence state
		var sfx = null;                          // { data, pos, block }
		var frac = 0, step = RATE / sampleRate;
		var tickAcc = 0, samplesPerTick = RATE / IMF_RATE;
		var sfxAcc = 0, samplesPerSfxTick = RATE / SFX_RATE;
		var a = 0, b = 0, primed = false;

		function quietMusic() { for (var c = 1; c < 9; c++) opl.write(0xB0 + c, 0); }

		function imfTick() {
			if (!track) return;
			if (wait > 0) { wait--; return; }
			while (pos + 3 < track.length) {
				var reg = track[pos], val = track[pos + 1];
				var delay = track[pos + 2] | (track[pos + 3] << 8);
				pos += 4;
				opl.write(reg, val);
				if (delay) { wait = delay - 1; return; }
			}
			if (pos + 3 >= track.length) { pos = 0; wait = 0; }   // loop
		}

		function sfxTick() {
			if (!sfx) return;
			if (sfx.pos >= sfx.data.length) { opl.write(0xB0, 0); sfx = null; return; }
			var note = sfx.data[sfx.pos++];
			if (note) { opl.write(0xA0, note); opl.write(0xB0, sfx.block); }
			else opl.write(0xB0, 0);
		}

		function chipSample() {
			tickAcc += 1;
			if (tickAcc >= samplesPerTick) { tickAcc -= samplesPerTick; imfTick(); }
			sfxAcc += 1;
			if (sfxAcc >= samplesPerSfxTick) { sfxAcc -= samplesPerSfxTick; sfxTick(); }
			return opl.sample();
		}

		return {
			// Load (or clear) the music track. Quiets the music voices first so a
			// switch never leaves a note hanging.
			setTrack: function (t) { quietMusic(); track = t || null; pos = 0; wait = 0; tickAcc = 0; primed = false; },
			// Stop the music but leave the chip and any running effect alone.
			silence: function () { track = null; quietMusic(); primed = false; },
			// Full reset: no music, no effect, chip cleared.
			stop: function () { track = null; sfx = null; opl.reset(); primed = false; },
			quietMusic: quietMusic,
			// Start an FM effect on channel 0 (it borrows the voice for its duration,
			// exactly as the original does). inst is the decoded instrument, block the
			// raw octave byte, data the note stream.
			playSfx: function (inst, block, data) {
				var I = inst, m = 0, c = 3;
				opl.write(0x20 + m, I.mChar); opl.write(0x40 + m, I.mScale);
				opl.write(0x60 + m, I.mAttack); opl.write(0x80 + m, I.mSus);
				opl.write(0xE0 + m, I.mWave);
				opl.write(0x20 + c, I.cChar); opl.write(0x40 + c, I.cScale);
				opl.write(0x60 + c, I.cAttack); opl.write(0x80 + c, I.cSus);
				opl.write(0xE0 + c, I.cWave);
				opl.write(0xC0, 0);
				sfx = { data: data, pos: 0, block: ((block & 7) << 2) | 0x20 };
				sfxAcc = 0;
			},
			// Fill `out` with resampled chip output. Silent (and cheap) when nothing
			// is playing — unless `ring` is set: then the chip keeps running, so a
			// released note can fade out (the effect renderer wants that tail).
			fill: function (out, ring) {
				var i, n = out.length;
				if (!track && !sfx && !ring) { for (i = 0; i < n; i++) out[i] = 0; return; }
				for (i = 0; i < n; i++) {
					if (!primed) { a = chipSample(); b = chipSample(); primed = true; }
					out[i] = a + (b - a) * frac;
					frac += step;
					while (frac >= 1) { frac -= 1; a = b; b = chipSample(); }
				}
			}
		};
	}

	// ---- FM effects, rendered whole ------------------------------------------
	// An FM effect is short and finite: a note stream at 140 Hz plus the release
	// of its last note. So it is rendered in one go on a chip of its own, into a
	// plain buffer that is played like a digitised sound — no latency from the
	// music's queue, and the result is cached per effect. The original borrowed
	// voice 0 of the music chip for it; OPL2 voices are simply summed at the
	// output, so a second chip sounds the same (only a track that wrote to voice
	// 0 would have cut the original's effect short — this one plays on).
	var FX_TAIL = 0.12;        // seconds of release after the last note
	function renderFx(OPL2Ctor, sampleRate, snd) {
		var g = createFmEngine(OPL2Ctor, sampleRate);
		g.playSfx(snd.inst, snd.block, snd.data);
		var n = Math.ceil((snd.data.length + 1) * sampleRate / SFX_RATE + FX_TAIL * sampleRate);
		var out = new Float32Array(n);
		g.fill(out, true);
		var end = n;
		while (end > 0 && Math.abs(out[end - 1]) < 1e-4) end--;   // drop the silent tail
		return out.subarray(0, end);
	}

	// ---- Where the music is made -----------------------------------------------
	// The page's own script tag tells us where musicworker.js lives, including any
	// cache-busting query (index.html loads the scripts as js/x.js?v=…).
	var WORKER_URL = (function () {
		try {
			if (typeof document !== 'undefined') {
				var s = document.querySelector('script[src*="music.js"]');
				var u = new URL(s && s.src ? s.src : 'js/music.js', document.baseURI);
				return new URL('musicworker.js' + u.search, u).href;
			}
		} catch (e) { /* fall through */ }
		return 'js/musicworker.js';
	})();

	var BLOCK = 4096;          // frames per music block (~85 ms at 48 kHz)
	var LEAD = 1.0;            // seconds of music kept queued ahead of the clock
	var START_GAP = 0.05;      // an empty queue starts this far ahead

	// The music's way out when a Worker is available (the normal case, on plain
	// http:// as well as https://). The worker owns the chip and renders blocks;
	// this side keeps LEAD seconds of them queued as AudioBufferSourceNodes laid
	// end to end. The main thread only copies and schedules, so a long frame no
	// longer starves the music: it has LEAD seconds of slack instead of one 4096-frame
	// ScriptProcessor callback. A song change cuts the queue and bumps the
	// generation; blocks still on their way from the old song are dropped.
	// (uDuke's js/musicout.js, in uWolf's classic-script form.)
	function WorkerSink(ctx, gain, onfail) {
		var self = this;
		this.ctx = ctx;
		this.gain = gain;
		this.gen = 0;
		this.active = false;
		this.nextTime = 0;
		this.inflight = 0;
		this.underruns = 0;
		this.sources = [];
		this.fxWait = {};          // effect index -> callbacks waiting for its buffer
		this.worker = new Worker(WORKER_URL);
		this.worker.onmessage = function (e) {
			var m = e.data;
			if (m.type === 'block') {
				if (m.gen !== self.gen) return;       // from a song since stopped or changed
				self.inflight--;
				self._schedule(m.data);
				self.pump();
			} else if (m.type === 'fx') {
				var cbs = self.fxWait[m.index] || [];
				delete self.fxWait[m.index];
				for (var i = 0; i < cbs.length; i++) cbs[i](m.data);
			} else if (m.type === 'error') {
				if (m.index != null) delete self.fxWait[m.index];   // one bad effect, not the worker
				else onfail(m.message);
			}
		};
		this.worker.onerror = function (e) {
			if (e && e.preventDefault) e.preventDefault();
			onfail((e && e.message) || 'music worker failed to load');
		};
		this.worker.postMessage({ type: 'init', rate: ctx.sampleRate });
	}

	WorkerSink.prototype.ahead = function () {
		return Math.max(0, this.nextTime - this.ctx.currentTime);
	};

	WorkerSink.prototype.pump = function () {
		var rate = this.ctx.sampleRate;
		while (this.active && this.ahead() + this.inflight * BLOCK / rate < LEAD) {
			this.worker.postMessage({ type: 'render', frames: BLOCK, gen: this.gen });
			this.inflight++;
		}
	};

	WorkerSink.prototype._schedule = function (data) {
		var ctx = this.ctx, self = this;
		var buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
		buf.getChannelData(0).set(data);
		var src = ctx.createBufferSource();
		src.buffer = buf;
		src.connect(this.gain);
		// Underrun (the tab slept, the thread stalled): start again a little ahead.
		if (this.nextTime < ctx.currentTime + 0.01) {
			if (this.nextTime) this.underruns++;   // not the first block of a song
			this.nextTime = ctx.currentTime + START_GAP;
		}
		src.start(this.nextTime);
		this.nextTime += buf.duration;
		this.sources.push(src);
		src.onended = function () {
			var i = self.sources.indexOf(src);
			if (i >= 0) self.sources.splice(i, 1);
			self.pump();
		};
	};

	// Drop everything queued; blocks in flight are recognised as stale by the generation.
	WorkerSink.prototype.cut = function () {
		this.gen++;
		for (var i = 0; i < this.sources.length; i++) {
			var s = this.sources[i];
			s.onended = null;
			try { s.stop(); } catch (e) { /* not started yet */ }
		}
		this.sources.length = 0;
		this.inflight = 0;
		this.nextTime = 0;
	};

	WorkerSink.prototype.play = function (track) {
		this.cut();
		this.worker.postMessage({ type: 'track', track: track });
		this.active = true;
		this.pump();
	};

	WorkerSink.prototype.silence = function () {
		this.cut();
		this.active = false;
		this.worker.postMessage({ type: 'silence' });
	};

	// Ask for an effect's samples; `cb(Float32Array)` runs when they arrive.
	WorkerSink.prototype.fx = function (index, snd, cb) {
		if (this.fxWait[index]) { this.fxWait[index].push(cb); return; }
		this.fxWait[index] = [cb];
		this.worker.postMessage({ type: 'fx', index: index, inst: snd.inst, block: snd.block, data: snd.data.slice() });
	};

	WorkerSink.prototype.close = function () {
		this.cut();
		this.active = false;
		this.worker.terminate();
	};

	// ---- Web Audio bridge ----------------------------------------------------
	// The chip runs at its own 49716 Hz; the audio context almost certainly does
	// not, so the engine generates at the native rate and resamples on the way out.
	//
	// Normally the music is rendered in a Web Worker (WorkerSink above) and the FM
	// effects are rendered whole and cached. Workers need no secure context, so
	// this runs the same over plain http:// from the router as over https://.
	// Only where no worker can be started (a page opened from file://, an old
	// browser) does it fall back to the main-thread ScriptProcessorNode, which
	// still works but can stutter while a frame is long.
	function MusicPlayer(ctx, audio) {
		this.ctx = ctx;
		this.audio = audio;
		this.node = null;         // ScriptProcessorNode (fallback only)
		this.sink = null;         // WorkerSink (normal case)
		this.gain = null;         // music level
		this.fxGain = null;       // FM effect level
		this.mode = null;         // 'worker' | 'script' | null (not set up yet)
		this.onmode = null;       // optional callback(mode) once the backend is live
		this.engine = null;       // main-thread engine (script fallback only)
		this.musicOn = false;
		this.volume = 0.55;
		this.song = -1;
		this._wantSong = -1;      // what should currently be playing (-1 = none)
		this._fx = {};            // effect index -> AudioBuffer
		this._fxSrc = null;       // the effect sounding now (a new one cuts it, as on voice 0)
		this._fxSeq = 0;          // latest effect request, so a late one is not played
	}

	MusicPlayer.prototype._resume = function () {
		if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
	};

	// Set up the output on first use — after a user gesture, so the AudioContext
	// is allowed to run.
	MusicPlayer.prototype._ensureNode = function () {
		if (this.mode) return;
		var self = this;
		this.gain = this.ctx.createGain();
		this.gain.gain.value = this.volume;
		this.gain.connect(this.ctx.destination);
		this.fxGain = this.ctx.createGain();
		this.fxGain.gain.value = this.volume;
		this.fxGain.connect(this.ctx.destination);
		var ok = false;
		if (typeof Worker !== 'undefined') {
			try {
				this.sink = new WorkerSink(this.ctx, this.gain, function (why) { self._fallback(why); });
				this.mode = 'worker';
				ok = true;
			} catch (e) { this.sink = null; }
		}
		if (!ok) this._setupScriptNode();
		this._notify();
	};

	// The worker failed (it could not be loaded, or threw): carry on in the main
	// thread with whatever was wanted.
	MusicPlayer.prototype._fallback = function (why) {
		if (this.mode !== 'worker') return;
		if (typeof console !== 'undefined')
			console.warn('[uWolf] music worker unavailable, using ScriptProcessor:', why);
		if (this.sink) { this.sink.close(); this.sink = null; }
		this._setupScriptNode();
		if (this._wantSong >= 0 && this.musicOn && this.audio) {
			var track = this.audio.music(this._wantSong);
			if (track) this.engine.setTrack(track.slice());
		}
		this._notify();
	};

	MusicPlayer.prototype._setupScriptNode = function () {
		var self = this;
		this.engine = createFmEngine(root.OPL2, this.ctx.sampleRate);
		// 4096 frames (~92 ms at 44.1 kHz) of headroom on the main thread.
		this.node = this.ctx.createScriptProcessor(4096, 0, 1);
		this.node.onaudioprocess = function (e) { self.engine.fill(e.outputBuffer.getChannelData(0)); };
		this.node.connect(this.gain);
		this.mode = 'script';
	};

	// Tell the UI which backend actually came up ('worker' vs 'script').
	MusicPlayer.prototype._notify = function () {
		if (this.onmode) { try { this.onmode(this.mode); } catch (e) { /* UI hook is best-effort */ } }
	};

	MusicPlayer.prototype.play = function (song) {
		this.song = song;
		if (!this.musicOn || !this.audio) return false;
		var track = this.audio.music(song);
		if (!track) return false;
		this._wantSong = song;
		this._ensureNode();
		// slice() detaches a compact copy, so posting it never touches the shared
		// AUDIOT buffer this view points into.
		if (this.sink) this.sink.play(track.slice());
		else this.engine.setTrack(track.slice());
		this._resume();
		return true;
	};

	MusicPlayer.prototype._startFx = function (buf) {
		var ctx = this.ctx;
		if (this._fxSrc) { try { this._fxSrc.stop(); } catch (e) { /* already over */ } }
		var src = ctx.createBufferSource();
		src.buffer = buf;
		src.connect(this.fxGain);
		src.start(0);
		this._fxSrc = src;
	};

	// Play an FM sound effect. Parsing stays on the main thread (WolfAudio); the
	// worker renders the samples once, and they are kept. Independent of the
	// Music toggle, exactly as the original keeps music and effects apart.
	MusicPlayer.prototype.playSfx = function (index) {
		if (!this.audio) return false;
		var snd = this.audio.fx(index);
		if (!snd) return false;
		this._ensureNode();
		this._resume();
		if (!this.sink) {                                       // fallback: the shared chip
			this.engine.playSfx(snd.inst, snd.block, snd.data.slice());
			return true;
		}
		var have = this._fx[index];
		if (have) { this._fxSeq++; this._startFx(have); return true; }
		var self = this, seq = ++this._fxSeq, asked = this.ctx.currentTime;
		this.sink.fx(index, snd, function (data) {
			if (!data.length) return;
			var buf = self.ctx.createBuffer(1, data.length, self.ctx.sampleRate);
			buf.getChannelData(0).set(data);
			self._fx[index] = buf;
			// The first time an effect is needed it arrives a few ms late; if it took
			// so long that it would no longer match what happened, skip it.
			if (seq === self._fxSeq && self.ctx.currentTime - asked < 0.15) self._startFx(buf);
		});
		return true;
	};

	// Only the *music* is toggled here; effects are unaffected.
	MusicPlayer.prototype.setEnabled = function (on) {
		this.musicOn = !!on;
		if (!this.musicOn) this.silence();
		else if (this.song >= 0) this.play(this.song);
	};

	MusicPlayer.prototype.setVolume = function (v) {
		this.volume = v;
		if (this.gain) this.gain.gain.value = v;
		if (this.fxGain) this.fxGain.gain.value = v;
	};

	// Stop the music but leave any effect alone.
	MusicPlayer.prototype.silence = function () {
		this._wantSong = -1;
		if (this.sink) this.sink.silence();
		else if (this.engine) this.engine.silence();
	};

	MusicPlayer.prototype.stop = function () {
		this.song = -1;
		this.silence();
		if (this._fxSrc) { try { this._fxSrc.stop(); } catch (e) { /* already over */ } this._fxSrc = null; }
		if (this.engine) this.engine.stop();
	};

	root.WolfMusic = {
		WolfAudio: WolfAudio,
		ImfPlayer: ImfPlayer,
		MusicPlayer: MusicPlayer,
		createFmEngine: createFmEngine,
		renderFx: renderFx,
		STARTMUSIC: STARTMUSIC,
		IMF_RATE: IMF_RATE
	};
})(typeof window !== 'undefined' ? window : this);
