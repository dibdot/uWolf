/*
 * sound.js — plays the digitized sound effects stored in the user's VSWAP.
 *
 * The samples are 8-bit unsigned mono at 7042 Hz (see wl_formats.js). This
 * decodes them lazily into Web Audio buffers and plays them on demand. No
 * audio data ships with the engine; it all comes from the user's own file.
 *
 * DIGI holds the WL6 logical->chunk mapping (from Wolf4SDL wolfdigimap) for the
 * handful of sounds the explorer actually triggers. Any chunk can still be
 * played by raw index via play(i).
 */
(function (root) {
	'use strict';

	var DIGI = {
		HALT: 0, DOGBARK: 1, CLOSEDOOR: 2, OPENDOOR: 3,
		MGUN: 4, PISTOL: 5, GATLING: 6, SCHUTZ: 7, GUTENTAG: 8, MUTTI: 9,
		BOSSFIRE: 10, SSFIRE: 11, DEATH1: 12, DEATH2: 13, TAKEDMG: 14, PUSHWALL: 15,
		DOGDEATH: 16, AHHG: 17, DIE: 18, EVA: 19, LEBEN: 20, NAZIFIRE: 21,
		SLURPIE: 22, TOTHUND: 23, MEINGOTT: 24, SCHABBSHA: 25, HITLERHA: 26,
		SPION: 27, NEINSOVAS: 28, DOGATTACK: 29, LEVELDONE: 30, MECHSTEP: 31, YEAH: 32
	};

	function SoundManager(gameData, rate) {
		this.data = gameData;
		this.rate = rate || (root.WolfFormats && root.WolfFormats.DIGI_RATE) || 7042;
		this.ctx = null;
		this.buffers = {};   // chunk index -> AudioBuffer
		this.enabled = true;
		this.volume = 1;
	}

	SoundManager.prototype._ac = function () {
		if (!this.ctx) {
			var AC = root.AudioContext || root.webkitAudioContext;
			if (AC) this.ctx = new AC();
		}
		return this.ctx;
	};

	// Must be called from a user gesture (browsers block audio otherwise).
	SoundManager.prototype.resume = function () {
		var c = this._ac();
		if (c && c.state === 'suspended') c.resume();
	};

	SoundManager.prototype._buffer = function (i) {
		if (this.buffers[i]) return this.buffers[i];
		var c = this._ac();
		var pcm = this.data.getDigiSound(i);
		if (!c || !pcm || pcm.length === 0) return null;
		var buf = c.createBuffer(1, pcm.length, this.rate);
		var ch = buf.getChannelData(0);
		for (var k = 0; k < pcm.length; k++) ch[k] = (pcm[k] - 128) / 128;
		this.buffers[i] = buf;
		return buf;
	};

	// Play digitized chunk `i`. `gain` defaults to 1. Silently no-ops if audio is
	// unavailable, disabled, or the chunk does not exist.
	SoundManager.prototype.play = function (i, gain) {
		if (!this.enabled || i == null || i < 0) return;
		var c = this._ac();
		if (!c) return;
		var buf = this._buffer(i);
		if (!buf) return;
		var src = c.createBufferSource();
		src.buffer = buf;
		var g = c.createGain();
		g.gain.value = (gain == null ? 1 : gain) * this.volume;
		src.connect(g); g.connect(c.destination);
		try { src.start(0); } catch (e) { /* ignore double-start */ }
	};

	// --- Procedural sound effects -----------------------------------------
	// Wolfenstein's pickup/UI sounds are Adlib (not in VSWAP's digitized bank),
	// so these are short synthesized tones used for item pickups and locked doors
	// until an OPL2/AUDIOT path exists.
	SoundManager.prototype.tone = function (freq, start, dur, type, peak) {
		var c = this._ac();
		if (!this.enabled || !c) return;
		var t0 = c.currentTime + (start || 0);
		var osc = c.createOscillator(), g = c.createGain();
		osc.type = type || 'sine';
		osc.frequency.setValueAtTime(freq, t0);
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.linearRampToValueAtTime((peak == null ? 0.2 : peak) * this.volume, t0 + 0.008);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
		osc.connect(g); g.connect(c.destination);
		try { osc.start(t0); osc.stop(t0 + dur + 0.03); } catch (e) { /* ignore */ }
	};

	SoundManager.prototype.sweep = function (f0, f1, start, dur, type, peak) {
		var c = this._ac();
		if (!this.enabled || !c) return;
		var t0 = c.currentTime + (start || 0);
		var osc = c.createOscillator(), g = c.createGain();
		osc.type = type || 'sawtooth';
		osc.frequency.setValueAtTime(f0, t0);
		osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.linearRampToValueAtTime((peak == null ? 0.2 : peak) * this.volume, t0 + 0.01);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
		osc.connect(g); g.connect(c.destination);
		try { osc.start(t0); osc.stop(t0 + dur + 0.03); } catch (e) { /* ignore */ }
	};

	SoundManager.prototype.sfx = function (name) {
		switch (name) {
			case 'health': this.tone(660, 0, 0.10, 'sine', 0.22); this.tone(988, 0.07, 0.13, 'sine', 0.20); break;
			case 'ammo': this.tone(520, 0, 0.05, 'square', 0.15); this.tone(760, 0.045, 0.06, 'square', 0.13); break;
			case 'weapon': this.sweep(240, 900, 0, 0.22, 'sawtooth', 0.2); this.tone(1200, 0.16, 0.12, 'square', 0.12); break;
			case 'treasure': this.tone(1047, 0, 0.07, 'sine', 0.2); this.tone(1568, 0.06, 0.16, 'sine', 0.18); break;
			case 'key': this.tone(784, 0, 0.09, 'triangle', 0.2); this.tone(1175, 0.08, 0.16, 'triangle', 0.18); break;
			case '1up': [523, 659, 784, 1047].forEach(function (f, i) { this.tone(f, i * 0.09, 0.13, 'square', 0.17); }, this); break;
			case 'locked': this.tone(140, 0, 0.16, 'square', 0.18); this.tone(96, 0.09, 0.18, 'square', 0.16); break;
		}
	};

	SoundManager.prototype.count = function () {
		try { return this.data.getDigiCount(); } catch (e) { return 0; }
	};

	SoundManager.DIGI = DIGI;
	root.SoundManager = SoundManager;
})(typeof window !== 'undefined' ? window : this);
