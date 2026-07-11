/*
 * wl_formats.js
 *
 * Parsers for the on-disk Wolfenstein 3D data formats:
 *   - VSWAP.*   : wall textures (64x64, column-major), sprites (RLE columns), sound
 *   - MAPHEAD.* : RLEW tag + per-level header offsets into GAMEMAPS
 *   - GAMEMAPS.*: level planes, Carmack-compressed, then RLEW-compressed
 *
 * This module only *interprets* files the user supplies; it ships no game
 * content of its own. Pure decoders (carmackExpand / rlewExpand) are also
 * exported for Node so they can be unit-tested outside a browser.
 */
(function (root) {
	'use strict';

	// ---- Compression -------------------------------------------------------

	// Carmack expansion. `src` is a Uint8Array, decode `expandedBytes` bytes of
	// output starting at byte `start`. Returns a Uint16Array of words.
	function carmackExpand(src, start, expandedBytes) {
		var NEAR = 0xA7, FAR = 0xA8;
		var outWords = expandedBytes >> 1;
		var out = new Uint16Array(outWords);
		var i = start, o = 0;
		while (o < outWords) {
			var count = src[i], ch = src[i + 1];
			i += 2;
			if (ch === NEAR) {
				if (count === 0) {                 // literal 0xA7?? escape
					out[o++] = src[i] | (ch << 8);
					i += 1;
				} else {
					var nOff = src[i]; i += 1;
					var nStart = o - nOff;
					while (count-- > 0) { out[o] = out[nStart++]; o++; }
				}
			} else if (ch === FAR) {
				if (count === 0) {                 // literal 0xA8?? escape
					out[o++] = src[i] | (ch << 8);
					i += 1;
				} else {
					var fOff = src[i] | (src[i + 1] << 8); i += 2;
					var fStart = fOff;
					while (count-- > 0) { out[o] = out[fStart++]; o++; }
				}
			} else {
				out[o++] = count | (ch << 8);      // literal word
			}
		}
		return out;
	}

	// RLEW expansion. `words` is a Uint16Array, decode `expandedBytes` of output
	// starting at word index `start`, using run marker `tag`.
	function rlewExpand(words, start, expandedBytes, tag) {
		var outWords = expandedBytes >> 1;
		var out = new Uint16Array(outWords);
		var i = start, o = 0;
		while (o < outWords) {
			var w = words[i++];
			if (w === tag) {
				var count = words[i++], value = words[i++];
				while (count-- > 0) out[o++] = value;
			} else {
				out[o++] = w;
			}
		}
		return out;
	}

	// ---- GameData ----------------------------------------------------------

	// `buffers` is an object: { VSWAP:ArrayBuffer, MAPHEAD:ArrayBuffer,
	// GAMEMAPS:ArrayBuffer }. Extension is irrelevant (WL1/WL6/WL3/SOD...).
	function GameData(buffers) {
		this.pal = root.WolfPalette.getRGB();
		this._wallCanvas = {};   // page -> {light, dark} canvas cache
		this._spriteCanvas = {}; // spriteIndex -> canvas cache
		this._parseVSWAP(buffers.VSWAP);
		this._parseMaps(buffers.MAPHEAD, buffers.GAMEMAPS);
		// Optional: VGAGRAPH UI graphics (status bar, BJ face, number/weapon pics).
		// Needs all three of VGADICT / VGAHEAD / VGAGRAPH; absent -> no original HUD.
		this.vga = null;
		if (root.WolfVGA && buffers.VGADICT && buffers.VGAHEAD && buffers.VGAGRAPH) {
			try {
				this.vga = new root.WolfVGA.VgaGraph(buffers.VGADICT, buffers.VGAHEAD, buffers.VGAGRAPH, this.pal);
			} catch (e) { this.vga = null; }
		}
	}

	GameData.prototype._parseVSWAP = function (buf) {
		if (!buf) throw new Error('VSWAP file missing');
		var dv = new DataView(buf);
		this.vswap = new Uint8Array(buf);
		this.chunkCount = dv.getUint16(0, true);
		this.spriteStart = dv.getUint16(2, true); // first sprite page
		this.soundStart = dv.getUint16(4, true);  // first sound page
		var n = this.chunkCount;
		this.pageOffset = new Uint32Array(n);
		this.pageLength = new Uint16Array(n);
		var p = 6;
		for (var i = 0; i < n; i++) { this.pageOffset[i] = dv.getUint32(p, true); p += 4; }
		for (var j = 0; j < n; j++) { this.pageLength[j] = dv.getUint16(p, true); p += 2; }
		this.numWalls = this.spriteStart;
		this.numSprites = this.soundStart - this.spriteStart;
	};

	// Parse the digitized-sound directory from the last VSWAP chunk. Mirrors
	// Wolf4SDL SDL_SetupDigi: the final page holds uint16 pairs
	// (startPage relative to soundStart, low-16 length); a sound's bytes span the
	// pages up to the next sound's start page. Sample format is 8-bit unsigned
	// mono at 7042 Hz. Lazily evaluated and cached.
	GameData.prototype._parseDigi = function () {
		if (this._digi) return;
		var last = this.chunkCount - 1;
		var dv = new DataView(this.vswap.buffer, this.vswap.byteOffset, this.vswap.byteLength);
		var infoOff = this.pageOffset[last];
		var infoWord = function (i) { return dv.getUint16(infoOff + i * 2, true); };
		var num = this.pageLength[last] >> 2; // 4 bytes per entry
		var list = [];
		for (var i = 0; i < num; i++) {
			var startPage = infoWord(i * 2);
			if (startPage >= last) { break; } // guard: bad/empty entry
			var lastPage;
			if (i < num - 1) {
				var lp = infoWord(i * 2 + 2);
				if (lp === 0 || lp + this.soundStart > last) lastPage = last;
				else lastPage = lp + this.soundStart;
			} else {
				lastPage = last;
			}
			var firstPage = this.soundStart + startPage;
			// Pages are contiguous, so the summed page sizes telescope to a simple
			// offset difference; the precise length's low 16 bits come from the
			// directory (the page span may include trailing padding).
			var raw = this.pageOffset[lastPage] - this.pageOffset[firstPage];
			var size = (raw & 0xffff0000) | infoWord(i * 2 + 1);
			if (size > raw) size = raw;
			list.push({ off: this.pageOffset[firstPage], len: size });
		}
		this._digi = list;
	};

	GameData.prototype.getDigiCount = function () { this._parseDigi(); return this._digi.length; };

	// Return the raw 8-bit unsigned PCM for digi sound `i`, or null.
	GameData.prototype.getDigiSound = function (i) {
		this._parseDigi();
		var e = this._digi[i];
		if (!e || e.len <= 0) return null;
		return this.vswap.subarray(e.off, e.off + e.len);
	};

	// Build (and cache) a 64x64 canvas for a wall page. `dark` = shaded variant
	// used for E/W faces to mimic the original two-tone lighting.
	GameData.prototype.getWallCanvas = function (page, dark) {
		if (page < 0) page = 0;
		if (page >= this.numWalls) page = this.numWalls - 1;
		var cache = this._wallCanvas[page];
		if (!cache) {
			cache = this._wallCanvas[page] = this._buildWall(page);
		}
		return dark ? cache.dark : cache.light;
	};

	GameData.prototype._buildWall = function (page) {
		var off = this.pageOffset[page];
		var src = this.vswap; // 4096 bytes, column-major
		var pal = this.pal;
		var light = document.createElement('canvas'); light.width = 64; light.height = 64;
		var dark = document.createElement('canvas'); dark.width = 64; dark.height = 64;
		var lc = light.getContext('2d'), dc = dark.getContext('2d');
		var lim = lc.createImageData(64, 64), dim = dc.createImageData(64, 64);
		var ld = lim.data, dd = dim.data;
		for (var x = 0; x < 64; x++) {
			for (var y = 0; y < 64; y++) {
				var idx = src[off + x * 64 + y];   // column-major source
				var r = pal[idx * 3], g = pal[idx * 3 + 1], b = pal[idx * 3 + 2];
				var d = (y * 64 + x) * 4;           // row-major destination
				ld[d] = r; ld[d + 1] = g; ld[d + 2] = b; ld[d + 3] = 255;
				dd[d] = r * 0.55 | 0; dd[d + 1] = g * 0.55 | 0; dd[d + 2] = b * 0.55 | 0; dd[d + 3] = 255;
			}
		}
		lc.putImageData(lim, 0, 0); dc.putImageData(dim, 0, 0);
		return { light: light, dark: dark };
	};

	// Decode a sprite page into a 64x64 RGBA canvas (transparent where empty).
	GameData.prototype.getSpriteCanvas = function (spriteIndex) {
		var c = this._spriteCanvas[spriteIndex];
		if (c) return c;
		c = this._buildSprite(spriteIndex);
		this._spriteCanvas[spriteIndex] = c;
		return c;
	};

	GameData.prototype._buildSprite = function (spriteIndex) {
		var page = this.spriteStart + spriteIndex;
		var canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
		var ctx = canvas.getContext('2d');
		var img = ctx.createImageData(64, 64);
		var data = img.data; // starts fully transparent (alpha 0)
		// NaN-safe range test: written as `!(in range)` on purpose, because every
		// comparison with NaN is false, so `page < start || page >= end` would let a
		// NaN index straight through and we'd decode garbage (negative column counts).
		if (!(page >= this.spriteStart && page < this.soundStart)) { ctx.putImageData(img, 0, 0); return canvas; }
		var base = this.pageOffset[page];
		if (base == null) { ctx.putImageData(img, 0, 0); return canvas; }
		var src = this.vswap;
		var pal = this.pal;
		var dv = new DataView(src.buffer, base);
		var firstCol = dv.getUint16(0, true);
		var lastCol = dv.getUint16(2, true);
		var numCols = lastCol - firstCol + 1;
		// Refuse to decode an implausible header rather than throwing on a bad length.
		if (numCols <= 0 || numCols > 64 || lastCol > 63) { ctx.putImageData(img, 0, 0); return canvas; }
		// Per-column command offsets (bytes, relative to sprite chunk start).
		var colOfs = new Uint16Array(numCols);
		for (var i = 0; i < numCols; i++) colOfs[i] = dv.getUint16(4 + i * 2, true);
		for (var col = firstCol; col <= lastCol; col++) {
			var p = colOfs[col - firstCol];
			while (true) {
				var endY = dv.getUint16(p, true);       // *2 encoded
				if (endY === 0) break;
				endY >>= 1;
				var pixOfs = dv.getUint16(p + 2, true);  // base into pixel pool
				var startY = dv.getUint16(p + 4, true) >> 1;
				p += 6;
				for (var y = startY; y < endY; y++) {
					var idx = src[base + pixOfs + y];
					var d = (y * 64 + col) * 4;
					data[d] = pal[idx * 3]; data[d + 1] = pal[idx * 3 + 1];
					data[d + 2] = pal[idx * 3 + 2]; data[d + 3] = 255;
				}
			}
		}
		ctx.putImageData(img, 0, 0);
		return canvas;
	};

	// ---- Maps --------------------------------------------------------------

	GameData.prototype._parseMaps = function (mapheadBuf, gamemapsBuf) {
		if (!mapheadBuf || !gamemapsBuf) throw new Error('MAPHEAD/GAMEMAPS missing');
		var mh = new DataView(mapheadBuf);
		this.rlewTag = mh.getUint16(0, true);
		this.gamemaps = new Uint8Array(gamemapsBuf);
		this.mapmaps = new DataView(gamemapsBuf);
		this.headerOffsets = [];
		// MAPHEAD holds up to 100 uint32 offsets after the 2-byte tag.
		var max = ((mapheadBuf.byteLength - 2) / 4) | 0;
		for (var i = 0; i < max; i++) {
			var o = mh.getUint32(2 + i * 4, true);
			if (o !== 0 && o !== 0xFFFFFFFF) this.headerOffsets.push({ index: i, offset: o });
			else this.headerOffsets.push(null);
		}
		// Pre-read level names for a menu.
		this.levels = [];
		for (var k = 0; k < this.headerOffsets.length; k++) {
			var e = this.headerOffsets[k];
			if (!e) continue;
			var dv = this.mapmaps, off = e.offset;
			var name = '';
			for (var c = 0; c < 16; c++) {
				var ch = this.gamemaps[off + 22 + c]; // name[16] sits after w(+18) & h(+20)
				if (ch === 0) break;
				name += String.fromCharCode(ch);
			}
			this.levels.push({ index: k, name: name || ('Level ' + (k + 1)) });
		}
	};

	// Decode a level: returns {width,height,plane0,plane1,plane2} (Uint16Array).
	GameData.prototype.getLevel = function (index) {
		var e = this.headerOffsets[index];
		if (!e) throw new Error('Level ' + index + ' not present');
		var dv = this.mapmaps, off = e.offset;
		var planeStart = [dv.getUint32(off, true), dv.getUint32(off + 4, true), dv.getUint32(off + 8, true)];
		var planeLen = [dv.getUint16(off + 12, true), dv.getUint16(off + 14, true), dv.getUint16(off + 16, true)];
		// Header layout: 3*uint32 planeStart, 3*uint16 planeLen, uint16 w, uint16 h, char[16] name
		var width = dv.getUint16(off + 18, true);
		var height = dv.getUint16(off + 20, true);
		var planes = [];
		for (var pl = 0; pl < 3; pl++) {
			planes.push(this._decodePlane(planeStart[pl], planeLen[pl], width * height * 2));
		}
		return { width: width, height: height, plane0: planes[0], plane1: planes[1], plane2: planes[2] };
	};

	GameData.prototype._decodePlane = function (start, length, mapBytes) {
		var src = this.gamemaps;
		// First word = size of Carmack-expanded output (in bytes).
		var carmackExpandedBytes = src[start] | (src[start + 1] << 8);
		var carmack = carmackExpand(src, start + 2, carmackExpandedBytes);
		// carmack[0] = RLEW-expanded byte count; RLEW data follows from word 1.
		return rlewExpand(carmack, 1, mapBytes, this.rlewTag);
	};

	GameData.DIGI_RATE = 7042; // original digitized-sound sample rate (Hz)

	var api = {
		carmackExpand: carmackExpand,
		rlewExpand: rlewExpand,
		GameData: GameData,
		DIGI_RATE: 7042
	};
	root.WolfFormats = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
