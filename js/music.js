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
	// The main-thread ScriptProcessor fallback calls it directly; the AudioWorklet
	// gets it by serialising this exact function with .toString() into its module,
	// so there is a single source of truth for how a sample is made. It must stay
	// self-contained: it may reference only its two parameters and its own locals
	// (no `root`, no module-scope vars), or it will not survive the trip.
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
			// is playing.
			fill: function (out) {
				var i, n = out.length;
				if (!track && !sfx) { for (i = 0; i < n; i++) out[i] = 0; return; }
				for (i = 0; i < n; i++) {
					if (!primed) { a = chipSample(); b = chipSample(); primed = true; }
					out[i] = a + (b - a) * frac;
					frac += step;
					while (frac >= 1) { frac -= 1; a = b; b = chipSample(); }
				}
			}
		};
	}

	// ---- AudioWorklet plumbing ----------------------------------------------
	// Resolve opl2.js relative to THIS script, so the worklet can fetch the same
	// chip source however uWolf is deployed (sub-path, cache-busting query, …).
	var OPL_URL = (function () {
		try {
			if (typeof document !== 'undefined') {
				var s = document.querySelector('script[src*="opl2.js"]');
				if (s && s.src) return s.src;
				if (document.currentScript && document.currentScript.src)
					return new URL('opl2.js', document.currentScript.src).href;
			}
		} catch (e) { /* fall through to the default */ }
		return 'js/opl2.js';
	})();

	var _oplSrc = null;
	function fetchOplSource() {
		if (_oplSrc) return Promise.resolve(_oplSrc);
		return fetch(OPL_URL).then(function (r) {
			if (!r.ok) throw new Error('opl2.js ' + r.status);
			return r.text();
		}).then(function (t) { _oplSrc = t; return t; });
	}

	// The processor half of the worklet. It owns an engine and pumps it; control
	// comes in over the port. References OPL2 (from the fetched chip source),
	// createFmEngine (serialised in below) and the worklet globals sampleRate /
	// AudioWorkletProcessor / registerProcessor.
	var WORKLET_GLUE = `
class UWolfFmProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.engine = createFmEngine(OPL2, sampleRate);
		this.port.onmessage = (e) => {
			var d = e.data, g = this.engine;
			if (d.type === 'track') g.setTrack(d.track);
			else if (d.type === 'silence') g.silence();
			else if (d.type === 'stop') g.stop();
			else if (d.type === 'quiet') g.quietMusic();
			else if (d.type === 'sfx') g.playSfx(d.inst, d.block, d.data);
		};
	}
	process(inputs, outputs) {
		var out = outputs[0] && outputs[0][0];
		if (out) this.engine.fill(out);
		return true;   // stay alive: the node is a continuous source
	}
}
registerProcessor('uwolf-fm', UWolfFmProcessor);
`;

	function buildWorkletSource(oplSrc) {
		return oplSrc + '\n;\n' + createFmEngine.toString() + '\n' + WORKLET_GLUE;
	}

	// ---- Web Audio bridge ----------------------------------------------------
	// The chip runs at its own 49716 Hz; the audio context almost certainly does
	// not, so the engine generates at the native rate and resamples on the way out.
	//
	// Synthesis runs in an AudioWorklet (its own thread) when the browser supports
	// one, so a long render frame on the main thread can no longer starve the audio
	// callback and break the music up. The worklet module is built at runtime from
	// the fetched chip source + the shared engine, wrapped in a Blob URL — uWolf
	// still ships nothing but plain static files. If anything about that path is
	// unavailable (older browser, blocked blob:, addModule failure) it falls back
	// to the original main-thread ScriptProcessorNode, which still works.
	function MusicPlayer(ctx, audio) {
		this.ctx = ctx;
		this.audio = audio;
		this.node = null;         // AudioWorkletNode or ScriptProcessorNode
		this.gain = null;
		this.mode = null;         // 'worklet' | 'script' | null (not set up yet)
		this.onmode = null;       // optional callback(mode) once the node is live
		this.engine = null;       // main-thread engine (script fallback only)
		this._pending = false;    // node setup in flight
		this.musicOn = false;
		this.volume = 0.55;
		this.song = -1;
		this._wantSong = -1;      // what the sink should currently be playing (-1 = none)
	}

	MusicPlayer.prototype._resume = function () {
		if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
	};

	// Route a control command to whichever backend is live. Before the node is
	// ready (mode === null) commands are dropped: the wanted music is re-sent from
	// _onNodeReady, and a transient effect fired during that ~tens-of-ms window is
	// simply skipped.
	MusicPlayer.prototype._apply = function (msg) {
		if (this.mode === 'worklet' && this.node) {
			this.node.port.postMessage(msg);
		} else if (this.mode === 'script' && this.engine) {
			var g = this.engine;
			if (msg.type === 'track') g.setTrack(msg.track);
			else if (msg.type === 'silence') g.silence();
			else if (msg.type === 'stop') g.stop();
			else if (msg.type === 'quiet') g.quietMusic();
			else if (msg.type === 'sfx') g.playSfx(msg.inst, msg.block, msg.data);
		}
	};

	// Lazily create the audio node on first use — after a user gesture, so the
	// AudioContext is allowed to run. Worklet setup is async; the ScriptProcessor
	// fallback is synchronous.
	MusicPlayer.prototype._ensureNode = function () {
		if (this.node || this._pending) return;
		this._pending = true;
		var self = this;
		var canWorklet = this.ctx.audioWorklet && typeof Blob !== 'undefined' &&
			typeof URL !== 'undefined' && URL.createObjectURL &&
			typeof AudioWorkletNode !== 'undefined';
		if (canWorklet) {
			this._setupWorklet().then(function () {
				self._pending = false; self._onNodeReady();
			}).catch(function (e) {
				if (typeof console !== 'undefined')
					console.warn('[uWolf] AudioWorklet unavailable, using ScriptProcessor:',
						e && e.message ? e.message : e);
				self._setupScriptNode();
				self._pending = false; self._onNodeReady();
			});
		} else {
			this._setupScriptNode();
			this._pending = false; this._onNodeReady();
		}
	};

	MusicPlayer.prototype._setupWorklet = function () {
		var self = this;
		return fetchOplSource().then(function (oplSrc) {
			var url = URL.createObjectURL(
				new Blob([buildWorkletSource(oplSrc)], { type: 'application/javascript' }));
			return self.ctx.audioWorklet.addModule(url).then(function () {
				URL.revokeObjectURL(url);
				self.node = new AudioWorkletNode(self.ctx, 'uwolf-fm',
					{ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
				self.gain = self.ctx.createGain();
				self.gain.gain.value = self.volume;
				self.node.connect(self.gain);
				self.gain.connect(self.ctx.destination);
				self.mode = 'worklet';
			});
		});
	};

	MusicPlayer.prototype._setupScriptNode = function () {
		if (this.node) return;
		var self = this;
		this.engine = createFmEngine(root.OPL2, this.ctx.sampleRate);
		// 4096 frames (~92 ms at 44.1 kHz) of headroom on the main thread; the extra
		// latency is irrelevant for background music.
		this.node = this.ctx.createScriptProcessor(4096, 0, 1);
		this.node.onaudioprocess = function (e) { self.engine.fill(e.outputBuffer.getChannelData(0)); };
		this.gain = this.ctx.createGain();
		this.gain.gain.value = this.volume;
		this.node.connect(this.gain);
		this.gain.connect(this.ctx.destination);
		this.mode = 'script';
	};

	// Reconcile the freshly-ready node with the state the game asked for while it
	// was still being built.
	MusicPlayer.prototype._onNodeReady = function () {
		if (this.gain) this.gain.gain.value = this.volume;
		if (this._wantSong >= 0 && this.musicOn && this.audio) {
			var track = this.audio.music(this._wantSong);
			if (track) this._apply({ type: 'track', track: track.slice() });
		}
		// Tell the UI which backend actually came up ('worklet' vs 'script').
		if (this.onmode) { try { this.onmode(this.mode); } catch (e) { /* UI hook is best-effort */ } }
	};

	MusicPlayer.prototype.play = function (song) {
		this.song = song;
		if (!this.musicOn || !this.audio) return false;
		var track = this.audio.music(song);
		if (!track) return false;
		this._wantSong = song;
		this._ensureNode();
		// slice() detaches a compact copy so the worklet's structured clone never
		// touches (or transfers) the shared AUDIOT buffer this view points into.
		this._apply({ type: 'track', track: track.slice() });
		this._resume();
		return true;
	};

	// Play an FM sound effect. Parsing stays on the main thread (WolfAudio); only
	// the register writes and the note stream cross to the synth. Independent of
	// the Music toggle, exactly as the original keeps music and effects apart.
	MusicPlayer.prototype.playSfx = function (index) {
		if (!this.audio) return false;
		var snd = this.audio.fx(index);
		if (!snd) return false;
		this._ensureNode();
		this._apply({ type: 'sfx', inst: snd.inst, block: snd.block, data: snd.data.slice() });
		this._resume();
		return true;
	};

	// Only the *music* is toggled here; effects are unaffected.
	MusicPlayer.prototype.setEnabled = function (on) {
		this.musicOn = !!on;
		if (!this.musicOn) { this._wantSong = -1; this._apply({ type: 'silence' }); }
		else if (this.song >= 0) this.play(this.song);
	};

	MusicPlayer.prototype.setVolume = function (v) {
		this.volume = v;
		if (this.gain) this.gain.gain.value = v;
	};

	// Stop the music but leave the chip (and any effect) alone.
	MusicPlayer.prototype.silence = function () {
		this._wantSong = -1;
		this._apply({ type: 'silence' });
	};

	MusicPlayer.prototype.stop = function () {
		this.song = -1;
		this._wantSong = -1;
		this._apply({ type: 'stop' });
	};

	root.WolfMusic = {
		WolfAudio: WolfAudio,
		ImfPlayer: ImfPlayer,
		MusicPlayer: MusicPlayer,
		createFmEngine: createFmEngine,
		STARTMUSIC: STARTMUSIC,
		IMF_RATE: IMF_RATE
	};
})(typeof window !== 'undefined' ? window : this);
