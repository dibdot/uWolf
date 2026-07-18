/*
 * palette.js
 *
 * The Wolfenstein 3D VGA palette is a fixed 256-colour lookup table. It is NOT
 * stored inside the data files (VSWAP / GAMEMAPS), so it has to live in the
 * engine. This is the byte-exact Wolf3D palette (from the GPL Wolf4SDL
 * wolfpal.inc, 6-bit values scaled to 0-255 as the game does: v*255/63).
 *
 * If any colour looks off with your particular data set, you can override the
 * whole table at runtime WITHOUT touching this file: drop a JSON file next to
 * the game data containing 256 [r,g,b] triples (or a flat array of 768 ints)
 * and point the loader at it, or set `window.WOLF_PALETTE_OVERRIDE` before the
 * engine starts. The canonical byte-exact table also lives in the GPL'd
 * Wolf4SDL / ECWolf source (gamepal.inc) if you ever want a reference copy.
 */
(function (root) {
	'use strict';

	// 256 * 3 = 768 bytes, r,g,b interleaved.
	var DEFAULT = [
		0, 0, 0, 0, 0, 170, 0, 170, 0, 0, 170, 170, 170, 0, 0, 170, 0, 170, 170, 85, 0, 170, 170, 170, 85, 85, 85, 85, 85, 255, 85, 255, 85, 85, 255, 255, 255, 85, 85, 255, 85, 255, 255, 255, 85, 255, 255, 255,
		238, 238, 238, 222, 222, 222, 210, 210, 210, 194, 194, 194, 182, 182, 182, 170, 170, 170, 153, 153, 153, 141, 141, 141, 125, 125, 125, 113, 113, 113, 101, 101, 101, 85, 85, 85, 72, 72, 72, 56, 56, 56, 44, 44, 44, 32, 32, 32,
		255, 0, 0, 238, 0, 0, 226, 0, 0, 214, 0, 0, 202, 0, 0, 190, 0, 0, 178, 0, 0, 165, 0, 0, 153, 0, 0, 137, 0, 0, 125, 0, 0, 113, 0, 0, 101, 0, 0, 89, 0, 0, 76, 0, 0, 64, 0, 0,
		255, 218, 218, 255, 186, 186, 255, 157, 157, 255, 125, 125, 255, 93, 93, 255, 64, 64, 255, 32, 32, 255, 0, 0, 255, 170, 93, 255, 153, 64, 255, 137, 32, 255, 121, 0, 230, 109, 0, 206, 97, 0, 182, 85, 0, 157, 76, 0,
		255, 255, 218, 255, 255, 186, 255, 255, 157, 255, 255, 125, 255, 250, 93, 255, 246, 64, 255, 246, 32, 255, 246, 0, 230, 218, 0, 206, 198, 0, 182, 174, 0, 157, 157, 0, 133, 133, 0, 113, 109, 0, 89, 85, 0, 64, 64, 0,
		210, 255, 93, 198, 255, 64, 182, 255, 32, 161, 255, 0, 145, 230, 0, 129, 206, 0, 117, 182, 0, 97, 157, 0, 218, 255, 218, 190, 255, 186, 157, 255, 157, 129, 255, 125, 97, 255, 93, 64, 255, 64, 32, 255, 32, 0, 255, 0,
		0, 255, 0, 0, 238, 0, 0, 226, 0, 0, 214, 0, 4, 202, 0, 4, 190, 0, 4, 178, 0, 4, 165, 0, 4, 153, 0, 4, 137, 0, 4, 125, 0, 4, 113, 0, 4, 101, 0, 4, 89, 0, 4, 76, 0, 4, 64, 0,
		218, 255, 255, 186, 255, 255, 157, 255, 255, 125, 255, 250, 93, 255, 255, 64, 255, 255, 32, 255, 255, 0, 255, 255, 0, 230, 230, 0, 206, 206, 0, 182, 182, 0, 157, 157, 0, 133, 133, 0, 113, 113, 0, 89, 89, 0, 64, 64,
		93, 190, 255, 64, 178, 255, 32, 170, 255, 0, 157, 255, 0, 141, 230, 0, 125, 206, 0, 109, 182, 0, 93, 157, 218, 218, 255, 186, 190, 255, 157, 157, 255, 125, 129, 255, 93, 97, 255, 64, 64, 255, 32, 36, 255, 0, 4, 255,
		0, 0, 255, 0, 0, 238, 0, 0, 226, 0, 0, 214, 0, 0, 202, 0, 0, 190, 0, 0, 178, 0, 0, 165, 0, 0, 153, 0, 0, 137, 0, 0, 125, 0, 0, 113, 0, 0, 101, 0, 0, 89, 0, 0, 76, 0, 0, 64,
		40, 40, 40, 255, 226, 52, 255, 214, 36, 255, 206, 24, 255, 194, 8, 255, 182, 0, 182, 32, 255, 170, 0, 255, 153, 0, 230, 129, 0, 206, 117, 0, 182, 97, 0, 157, 80, 0, 133, 68, 0, 113, 52, 0, 89, 40, 0, 64,
		255, 218, 255, 255, 186, 255, 255, 157, 255, 255, 125, 255, 255, 93, 255, 255, 64, 255, 255, 32, 255, 255, 0, 255, 226, 0, 230, 202, 0, 206, 182, 0, 182, 157, 0, 157, 133, 0, 133, 109, 0, 113, 89, 0, 89, 64, 0, 64,
		255, 234, 222, 255, 226, 210, 255, 218, 198, 255, 214, 190, 255, 206, 178, 255, 198, 165, 255, 190, 157, 255, 186, 145, 255, 178, 129, 255, 165, 113, 255, 157, 97, 242, 149, 93, 234, 141, 89, 222, 137, 85, 210, 129, 80, 202, 125, 76,
		190, 121, 72, 182, 113, 68, 170, 105, 64, 161, 101, 60, 157, 97, 56, 145, 93, 52, 137, 89, 48, 129, 80, 44, 117, 76, 40, 109, 72, 36, 93, 64, 32, 85, 60, 28, 72, 56, 24, 64, 48, 24, 56, 44, 20, 40, 32, 12,
		97, 0, 101, 0, 101, 101, 0, 97, 97, 0, 0, 28, 0, 0, 44, 48, 36, 16, 72, 0, 72, 80, 0, 80, 0, 0, 52, 28, 28, 28, 76, 76, 76, 93, 93, 93, 64, 64, 64, 48, 48, 48, 52, 52, 52, 218, 246, 246,
		186, 234, 234, 157, 222, 222, 117, 202, 202, 72, 194, 194, 32, 182, 182, 32, 178, 178, 0, 165, 165, 0, 153, 153, 0, 141, 141, 0, 133, 133, 0, 125, 125, 0, 121, 121, 0, 117, 117, 0, 113, 113, 0, 109, 109, 153, 0, 137
	];

	// Return a Uint8ClampedArray of length 768 (r,g,b, ...).
	// Spear of Destiny ships its own palette (sodpal.inc): it is identical to the
	// Wolfenstein one except for two entries, so the active dataset variant may
	// supply a sparse {index: [r,g,b]} override rather than a whole table. An
	// explicit WOLF_PALETTE_OVERRIDE still wins over everything.
	function getRGB() {
		var src = root.WOLF_PALETTE_OVERRIDE || DEFAULT;
		var out = new Uint8ClampedArray(768);
		if (src.length === 768) {
			for (var i = 0; i < 768; i++) out[i] = src[i] | 0;
		} else if (src.length >= 256 && Array.isArray(src[0])) {
			for (var j = 0; j < 256; j++) {
				out[j * 3] = src[j][0]; out[j * 3 + 1] = src[j][1]; out[j * 3 + 2] = src[j][2];
			}
		} else {
			for (var k = 0; k < 768; k++) out[k] = DEFAULT[k];
		}
		if (!root.WOLF_PALETTE_OVERRIDE && root.WolfVariant && root.WolfVariant.active) {
			var pv = root.WolfVariant.active.palette;
			if (pv) {
				for (var idx in pv) {
					if (!pv.hasOwnProperty(idx)) continue;
					var c = pv[idx], o = (idx | 0) * 3;
					out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
				}
			}
		}
		return out;
	}

	root.WolfPalette = { DEFAULT: DEFAULT, getRGB: getRGB };
})(typeof window !== 'undefined' ? window : this);
