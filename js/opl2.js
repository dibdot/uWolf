/*
 * opl2.js — a Yamaha YM3812 (OPL2) FM synthesiser.
 *
 * This is the one part of uWolf that emulates *hardware* rather than parsing a file
 * format. AUDIOT contains no notes: it contains register writes for the AdLib card's
 * OPL2 chip. To hear the music you have to be the chip.
 *
 * Written from the documented behaviour of the part (Yamaha's application manual and
 * the public reverse-engineering of the envelope generator), not transcribed from any
 * particular emulator — deliberately, since the emulator Wolf4SDL itself uses (MAME's
 * fmopl.c) is NOT under the GPL.
 *
 * Structure: 9 channels x 2 operators. Each operator is a phase accumulator feeding a
 * quarter-sine lookup in the log domain; attenuation (envelope + total level + key
 * scaling + tremolo) is added *in that log domain* and converted back with an exp
 * table, which is exactly how the silicon avoids multipliers. Operator 1 either
 * modulates operator 2's phase (FM) or is simply added to it (AM), per the channel's
 * connection bit.
 *
 * Native output rate is 49716 Hz (3579545 / 72), the chip's real sample rate. Callers
 * resample; see music.js.
 */
(function (root) {
	'use strict';

	var RATE = 49716;                     // 3579545 / 72 — the chip's own sample rate

	// ---- Tables -------------------------------------------------------------
	// Everything is generated from the maths, so there is nothing to copy and nothing
	// to get subtly wrong by transcription.

	// Quarter sine in the log domain: logsin[i] = -256 * log2(sin(...)), 0..2137.
	var logsin = new Uint16Array(256);
	for (var i = 0; i < 256; i++) {
		var s = Math.sin((i + 0.5) * Math.PI / 512);
		logsin[i] = Math.round(-Math.log(s) / Math.LN2 * 256);
	}

	// exp2 lookup: expTab[f] = 4096 * 2^(-f/256), so 4096 down to 2048.
	var expTab = new Uint16Array(256);
	for (i = 0; i < 256; i++) expTab[i] = Math.round(4096 * Math.pow(2, -i / 256));

	// Turn a total attenuation (units of 1/256 of an octave) into an amplitude.
	function attToAmp(total) {
		if (total >= 0x1FFF) return 0;
		return expTab[total & 0xFF] >> (total >> 8);
	}

	// Frequency multiplier, doubled so 0.5 stays an integer.
	var MULT2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];

	// Sustain level: 3 dB per step, and 15 means "all the way down".
	var SL_TAB = [];
	for (i = 0; i < 16; i++) SL_TAB.push(i === 15 ? 496 : i * 16);

	// Key scale level: higher notes get quieter. Base attenuation per block/fnum-high.
	var KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
	var KSL_TAB = [];                       // [block][fnum >> 6]
	for (var b = 0; b < 8; b++) {
		KSL_TAB[b] = [];
		for (var f = 0; f < 16; f++) {
			var v = KSL_ROM[f] - 8 * (7 - b);
			KSL_TAB[b][f] = v < 0 ? 0 : v;
		}
	}
	var KSL_SHIFT = [8, 2, 1, 0];           // register value 0 = off (shift it away)

	// Envelope generator: the rate decides how often a step happens and how big it is.
	// The four patterns below are the hardware's way of getting fractional rates out of
	// an integer counter — a rate of 1 steps on half the slots, and so on.
	var EG_PATTERN = [
		[0, 1, 0, 1, 0, 1, 0, 1],
		[0, 1, 0, 1, 1, 1, 0, 1],
		[0, 1, 1, 1, 0, 1, 1, 1],
		[0, 1, 1, 1, 1, 1, 1, 1]
	];

	// Tremolo: a 3.7 Hz triangle, 26 units deep (~4.8 dB) or a quarter of that.
	var TREM_TAB = new Uint8Array(210);
	for (i = 0; i < 105; i++) { TREM_TAB[i] = i >> 2; TREM_TAB[209 - i] = i >> 2; }

	// Vibrato: 6.1 Hz, +/- a fraction of the note.
	var VIB_TAB = [0, 1, 0, -1];

	// Which register offset belongs to which operator of which channel.
	var OP_OFF = [
		[0x00, 0x03], [0x01, 0x04], [0x02, 0x05],
		[0x08, 0x0B], [0x09, 0x0C], [0x0A, 0x0D],
		[0x10, 0x13], [0x11, 0x14], [0x12, 0x15]
	];

	// EG states
	var OFF = 0, ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4;

	// ---- Operator -----------------------------------------------------------
	function Operator() {
		this.am = 0; this.vib = 0; this.egt = 0; this.ksr = 0; this.mult = 0;
		this.kslBits = 0; this.tl = 0;
		this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0;
		this.wave = 0;

		this.phase = 0;          // 10 fractional bits below the 10-bit wave index
		this.inc = 0;
		this.env = 511;          // attenuation: 0 = loud, 511 = silent
		this.state = OFF;
		this.ksl = 0;            // attenuation from key scaling
		this.out = 0;            // last sample (operator 1 needs the previous two)
		this.prev = 0;
	}

	// The wave index for the current phase, plus whether this part of the wave is
	// negative and whether it is silent at all (waves 1 and 3 chop the sine up).
	Operator.prototype._wave = function (phaseIdx) {
		var w = this.wave, neg = 0, idx;
		if (w === 0) {
			neg = (phaseIdx & 0x200) ? 1 : 0;
			idx = (phaseIdx & 0x100) ? (~phaseIdx & 0xFF) : (phaseIdx & 0xFF);
		} else if (w === 1) {
			if (phaseIdx & 0x200) return null;               // bottom half removed
			idx = (phaseIdx & 0x100) ? (~phaseIdx & 0xFF) : (phaseIdx & 0xFF);
		} else if (w === 2) {
			idx = (phaseIdx & 0x100) ? (~phaseIdx & 0xFF) : (phaseIdx & 0xFF);
		} else {
			if (phaseIdx & 0x100) return null;               // every other quarter removed
			idx = phaseIdx & 0xFF;
		}
		return { idx: idx, neg: neg };
	};

	// ---- Channel ------------------------------------------------------------
	function Channel() {
		this.fnum = 0; this.block = 0; this.kon = 0;
		this.fb = 0; this.cnt = 0;
		this.ops = [new Operator(), new Operator()];
	}

	// ---- The chip -----------------------------------------------------------
	function OPL2() {
		this.ch = [];
		for (var c = 0; c < 9; c++) this.ch.push(new Channel());
		this.opByOffset = {};                 // register offset -> operator
		for (c = 0; c < 9; c++) {
			this.opByOffset[OP_OFF[c][0]] = this.ch[c].ops[0];
			this.opByOffset[OP_OFF[c][1]] = this.ch[c].ops[1];
		}
		this.chOfOp = {};
		for (c = 0; c < 9; c++) {
			this.chOfOp[OP_OFF[c][0]] = this.ch[c];
			this.chOfOp[OP_OFF[c][1]] = this.ch[c];
		}
		this.reg = new Uint8Array(256);
		this.egCounter = 0;
		this.tremPos = 0; this.tremolo = 0;
		this.vibPos = 0;
		this.dam = 0; this.dvb = 0;
		this.waveSelect = 0;                  // register 0x01 bit 5
	}

	OPL2.RATE = RATE;

	OPL2.prototype.reset = function () {
		for (var r = 0; r < 256; r++) this.reg[r] = 0;
		for (var c = 0; c < 9; c++) {
			var ch = this.ch[c];
			ch.fnum = ch.block = ch.kon = ch.fb = ch.cnt = 0;
			for (var o = 0; o < 2; o++) {
				var op = ch.ops[o];
				op.env = 511; op.state = OFF; op.phase = 0; op.out = op.prev = 0;
			}
		}
	};

	OPL2.prototype.write = function (reg, val) {
		reg &= 0xFF; val &= 0xFF;
		this.reg[reg] = val;
		var hi = reg & 0xF0, lo = reg & 0x1F, op, ch, c;

		if (reg === 0x01) {                                  // wave select enable
			this.waveSelect = (val & 0x20) ? 1 : 0;
			return;
		}
		if (reg === 0xBD) {                                  // depth flags (rhythm ignored)
			this.dam = (val & 0x80) ? 1 : 0;
			this.dvb = (val & 0x40) ? 1 : 0;
			return;
		}

		if (hi === 0x20 || hi === 0x30) {
			op = this.opByOffset[lo]; if (!op) return;
			op.am = (val & 0x80) ? 1 : 0;
			op.vib = (val & 0x40) ? 1 : 0;
			op.egt = (val & 0x20) ? 1 : 0;
			op.ksr = (val & 0x10) ? 1 : 0;
			op.mult = val & 0x0F;
			this._retune(this.chOfOp[lo]);
			return;
		}
		if (hi === 0x40 || hi === 0x50) {
			op = this.opByOffset[lo]; if (!op) return;
			op.kslBits = (val >> 6) & 3;
			op.tl = val & 0x3F;
			this._retune(this.chOfOp[lo]);
			return;
		}
		if (hi === 0x60 || hi === 0x70) {
			op = this.opByOffset[lo]; if (!op) return;
			op.ar = (val >> 4) & 0x0F;
			op.dr = val & 0x0F;
			return;
		}
		if (hi === 0x80 || hi === 0x90) {
			op = this.opByOffset[lo]; if (!op) return;
			op.sl = (val >> 4) & 0x0F;
			op.rr = val & 0x0F;
			return;
		}
		if (hi === 0xE0 || hi === 0xF0) {
			op = this.opByOffset[lo]; if (!op) return;
			op.wave = val & 0x03;
			return;
		}
		if (hi === 0xA0) {
			c = reg & 0x0F; if (c > 8) return;
			ch = this.ch[c];
			ch.fnum = (ch.fnum & 0x300) | val;
			this._retune(ch);
			return;
		}
		if (hi === 0xB0) {
			c = reg & 0x0F; if (c > 8) return;
			ch = this.ch[c];
			ch.fnum = (ch.fnum & 0xFF) | ((val & 0x03) << 8);
			ch.block = (val >> 2) & 0x07;
			var kon = (val & 0x20) ? 1 : 0;
			if (kon && !ch.kon) this._keyOn(ch);
			else if (!kon && ch.kon) this._keyOff(ch);
			ch.kon = kon;
			this._retune(ch);
			return;
		}
		if (hi === 0xC0) {
			c = reg & 0x0F; if (c > 8) return;
			ch = this.ch[c];
			ch.fb = (val >> 1) & 0x07;
			ch.cnt = val & 0x01;
			return;
		}
	};

	OPL2.prototype._keyOn = function (ch) {
		for (var o = 0; o < 2; o++) {
			var op = ch.ops[o];
			op.state = ATTACK;
			op.phase = 0;                      // key-on restarts the waveform
			op.out = op.prev = 0;
			if (this._rate(ch, op, op.ar) >= 60) op.env = 0;   // instant attack
		}
	};

	OPL2.prototype._keyOff = function (ch) {
		for (var o = 0; o < 2; o++) {
			if (ch.ops[o].state !== OFF) ch.ops[o].state = RELEASE;
		}
	};

	// Phase increment and key-scale attenuation both follow from block/fnum/mult.
	OPL2.prototype._retune = function (ch) {
		if (!ch) return;
		for (var o = 0; o < 2; o++) {
			var op = ch.ops[o];
			op.inc = ((ch.fnum << ch.block) * MULT2[op.mult]) >> 1;
			var base = KSL_TAB[ch.block][ch.fnum >> 6];
			op.ksl = base >> KSL_SHIFT[op.kslBits];
		}
	};

	// Effective envelope rate: the register nibble, sped up for higher notes.
	OPL2.prototype._rate = function (ch, op, r) {
		if (r === 0) return 0;
		var ksrVal = (ch.block << 1) | ((ch.fnum >> 9) & 1);
		var rof = op.ksr ? ksrVal : (ksrVal >> 2);
		var rate = r * 4 + rof;
		return rate > 63 ? 63 : rate;
	};

	// One envelope step for one operator.
	OPL2.prototype._advanceEnv = function (ch, op) {
		var r;
		switch (op.state) {
			case ATTACK: r = op.ar; break;
			case DECAY: r = op.dr; break;
			case SUSTAIN: if (op.egt) return; r = op.rr; break;   // percussive: keeps falling
			case RELEASE: r = op.rr; break;
			default: return;
		}
		var rate = this._rate(ch, op, r);
		if (rate === 0) return;

		var hi = rate >> 2, lo = rate & 3;
		var shift = 13 - hi;
		var step;
		if (shift > 0) {
			if (this.egCounter & ((1 << shift) - 1)) return;      // not on this sample
			step = EG_PATTERN[lo][(this.egCounter >> shift) & 7];
		} else {
			step = EG_PATTERN[lo][this.egCounter & 7] << (hi - 13);
		}
		if (!step) return;

		if (op.state === ATTACK) {
			// Attenuation falls fastest while it is still large: that curve is the
			// characteristic OPL attack.
			op.env += ((~op.env) * step) >> 3;
			if (op.env <= 0) { op.env = 0; op.state = DECAY; }
		} else {
			op.env += step;
			if (op.env >= 511) {
				op.env = 511;
				if (op.state === RELEASE) op.state = OFF;
			}
			if (op.state === DECAY && op.env >= SL_TAB[op.sl]) {
				op.env = SL_TAB[op.sl];
				op.state = SUSTAIN;
			}
		}
	};

	// One operator sample. `mod` is added to the phase (FM) — that is the whole trick.
	OPL2.prototype._opSample = function (ch, op, mod) {
		if (op.state === OFF) { op.prev = op.out; op.out = 0; return 0; }

		var inc = op.inc;
		if (op.vib) {                                          // gentle pitch wobble
			var d = ((ch.fnum >> 7) & 7) * VIB_TAB[(this.vibPos >> 10) & 3];
			if (!this.dvb) d >>= 1;
			inc += ((d << ch.block) * MULT2[op.mult]) >> 1;
		}
		op.phase = (op.phase + inc) >>> 0;

		var phaseIdx = ((op.phase >>> 10) + mod) & 0x3FF;
		var w = op._wave(phaseIdx);
		if (w === null) { op.prev = op.out; op.out = 0; return 0; }

		var att = op.env + (op.tl << 2) + op.ksl;
		if (op.am) att += this.dam ? this.tremolo : (this.tremolo >> 2);

		var amp = attToAmp(logsin[w.idx] + (att << 3));
		if (w.neg) amp = -amp;

		op.prev = op.out;
		op.out = amp;
		return amp;
	};

	// One mono sample, roughly in [-1, 1]. The sequencer needs sample-by-sample control
	// (a 700 Hz tick lands between samples), so this is the real entry point and
	// generate() is just a loop over it.
	OPL2.prototype.sample = function () {
		// LFOs
		this.tremPos = (this.tremPos + 1) % (210 * 64);
		this.tremolo = TREM_TAB[(this.tremPos / 64) | 0];
		this.vibPos = (this.vibPos + 1) & 0xFFFF;

		var acc = 0;
		for (var c = 0; c < 9; c++) {
			var ch = this.ch[c];
			var op1 = ch.ops[0], op2 = ch.ops[1];
			if (op1.state === OFF && op2.state === OFF) continue;

			this._advanceEnv(ch, op1);
			this._advanceEnv(ch, op2);

			// Operator 1 can feed itself: the average of its last two outputs, scaled
			// by the feedback setting.
			var fbMod = 0;
			if (ch.fb) fbMod = ((op1.out + op1.prev) >> (9 - ch.fb));
			var o1 = this._opSample(ch, op1, fbMod);

			if (ch.cnt) {
				acc += o1 + this._opSample(ch, op2, 0);      // additive: both are heard
			} else {
				acc += this._opSample(ch, op2, o1 >> 1);     // FM: op1 bends op2's phase
			}
		}
		this.egCounter++;
		// Nine carriers at full tilt can sum to about three times full scale. The real
		// part saturates rather than wrapping, so clamp: a loud passage should sound
		// loud, not inside out.
		var v = acc / 12000;
		return v > 1 ? 1 : (v < -1 ? -1 : v);
	};

	// Fill `buf` with `n` mono samples.
	OPL2.prototype.generate = function (buf, n) {
		for (var s = 0; s < n; s++) buf[s] = this.sample();
		return buf;
	};

	root.OPL2 = OPL2;
})(typeof window !== 'undefined' ? window : this);
