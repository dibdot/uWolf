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

	// ---- Web Audio -----------------------------------------------------------
	// The chip runs at its own 49716 Hz; the audio context almost certainly does not,
	// so we generate at the native rate and resample on the way out.
	function MusicPlayer(ctx, audio) {
		this.ctx = ctx;
		this.audio = audio;
		this.opl = new root.OPL2();
		this.player = null;
		this.node = null;
		this.gain = null;
		this.musicOn = false;
		this.volume = 0.55;
		this.song = -1;
		this.sfx = null;                                   // the effect currently playing

		this._frac = 0;
		this._step = root.OPL2.RATE / ctx.sampleRate;
		this._tickAcc = 0;
		this._samplesPerTick = root.OPL2.RATE / IMF_RATE;      // ~71.02
		this._sfxAcc = 0;
		this._samplesPerSfxTick = root.OPL2.RATE / SFX_RATE;   // ~355.1
	}

	// One sample at the chip's own rate, running the 700 Hz sequencer as the clock
	// passes each tick boundary.
	MusicPlayer.prototype._chipSample = function () {
		this._tickAcc += 1;
		if (this._tickAcc >= this._samplesPerTick) {
			this._tickAcc -= this._samplesPerTick;
			if (this.player) this.player.tick();
		}
		this._sfxAcc += 1;
		if (this._sfxAcc >= this._samplesPerSfxTick) {
			this._sfxAcc -= this._samplesPerSfxTick;
			this._sfxTick();
		}
		return this.opl.sample();
	};

	// One step of the effect: play the next note byte, or stop.
	MusicPlayer.prototype._sfxTick = function () {
		var s = this.sfx;
		if (!s) return;
		if (s.pos >= s.data.length) {
			this.opl.write(0xB0, 0);          // key off, channel 0
			this.sfx = null;
			return;
		}
		var note = s.data[s.pos++];
		if (note) {
			this.opl.write(0xA0, note);
			this.opl.write(0xB0, s.block);    // key on, at this sound's octave
		} else {
			this.opl.write(0xB0, 0);
		}
	};

	// Play an FM sound effect. It takes over channel 0 for its duration — which is
	// exactly what the original does; the music simply loses that voice for a moment.
	// Effects do NOT depend on the music being switched on.
	MusicPlayer.prototype.playSfx = function (index) {
		if (!this.audio) return false;
		var snd = this.audio.fx(index);
		if (!snd) return false;
		this._ensureNode();

		var I = snd.inst, opl = this.opl;
		var m = 0, c = 3;                     // channel 0's two cells
		opl.write(0x20 + m, I.mChar); opl.write(0x40 + m, I.mScale);
		opl.write(0x60 + m, I.mAttack); opl.write(0x80 + m, I.mSus);
		opl.write(0xE0 + m, I.mWave);
		opl.write(0x20 + c, I.cChar); opl.write(0x40 + c, I.cScale);
		opl.write(0x60 + c, I.cAttack); opl.write(0x80 + c, I.cSus);
		opl.write(0xE0 + c, I.cWave);
		opl.write(0xC0, 0);

		this.sfx = { data: snd.data, pos: 0, block: ((snd.block & 7) << 2) | 0x20 };
		this._sfxAcc = 0;
		if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
		return true;
	};

	MusicPlayer.prototype._fill = function (out) {
		// The chip keeps running even with the music switched off: the FM sound
		// effects live on the same chip, and they are not part of the music toggle.
		var i;
		if (!this.player && !this.sfx) {
			for (i = 0; i < out.length; i++) out[i] = 0;
			return;
		}
		// Linear resampling from 49716 Hz to the context rate.
		for (i = 0; i < out.length; i++) {
			if (this._a === undefined) { this._a = this._chipSample(); this._b = this._chipSample(); }
			out[i] = this._a + (this._b - this._a) * this._frac;
			this._frac += this._step;
			while (this._frac >= 1) {
				this._frac -= 1;
				this._a = this._b;
				this._b = this._chipSample();
			}
		}
	};

	MusicPlayer.prototype._ensureNode = function () {
		if (this.node) return;
		var self = this;
		// ScriptProcessorNode is deprecated but universally available and needs no
		// separate module file, which keeps uWolf to plain static scripts. Music is not
		// latency-critical, so the main-thread callback is fine here.
		// A ScriptProcessorNode is filled on the MAIN thread, so a long frame starves
		// it and the music breaks up. 2048 frames is only ~46 ms of headroom; 4096
		// doubles that, and the extra latency is irrelevant for background music.
		this.node = this.ctx.createScriptProcessor(4096, 0, 1);
		this.node.onaudioprocess = function (e) { self._fill(e.outputBuffer.getChannelData(0)); };
		this.gain = this.ctx.createGain();
		this.gain.gain.value = this.volume;
		this.node.connect(this.gain);
		this.gain.connect(this.ctx.destination);
	};

	// Only the *music* is toggled here. Sound effects are unaffected, exactly as the
	// original keeps its music and sound settings apart.
	MusicPlayer.prototype.setEnabled = function (on) {
		this.musicOn = !!on;
		if (!this.musicOn) { this.player = null; this._quietMusicVoices(); }
		else if (this.song >= 0) this.play(this.song);
	};

	// Silence channels 1..8 (the music's) without disturbing the effect on channel 0.
	MusicPlayer.prototype._quietMusicVoices = function () {
		for (var c = 1; c < 9; c++) this.opl.write(0xB0 + c, 0);
	};

	MusicPlayer.prototype.setVolume = function (v) {
		this.volume = v;
		if (this.gain) this.gain.gain.value = v;
	};

	// Stop the music but leave the chip (and any effect) alone.
	MusicPlayer.prototype.silence = function () {
		this.player = null;
		this._quietMusicVoices();
		this._a = this._b = undefined;
	};

	MusicPlayer.prototype.play = function (song) {
		this.song = song;
		if (!this.musicOn || !this.audio) return false;
		var track = this.audio.music(song);
		if (!track) return false;
		this._ensureNode();
		this._quietMusicVoices();
		this.player = new ImfPlayer(this.opl, track);
		this._tickAcc = 0;
		this._a = this._b = undefined;
		if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
		return true;
	};

	MusicPlayer.prototype.stop = function () {
		this.song = -1;
		this.player = null;
		this.sfx = null;
		this.opl.reset();
		this._a = this._b = undefined;
	};

	root.WolfMusic = {
		WolfAudio: WolfAudio,
		ImfPlayer: ImfPlayer,
		MusicPlayer: MusicPlayer,
		STARTMUSIC: STARTMUSIC,
		IMF_RATE: IMF_RATE
	};
})(typeof window !== 'undefined' ? window : this);
