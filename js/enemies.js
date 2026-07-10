/*
 * enemies.js — enemy spawn decoding and 8-direction sprite selection.
 *
 * This is an ORIGINAL implementation. The sprite-base indices and spawn-code
 * ranges below are functional constants required to interpret the user's own
 * data files; they were derived from the GPL-licensed Wolf4SDL source
 * (WL_DEF.H sprite enum, WL_GAME.C ScanInfoPlane, WL_ACT2.C SpawnStand,
 * WL_DRAW.C CalcRotate) for the WL6 (registered, non-SPEAR) build. No game
 * content is included.
 *
 * All indices are RELATIVE sprite-chunk numbers: the VSWAP page is
 * (gameData.spriteStart + index), which getSpriteCanvas(index) already expects.
 */
(function (root) {
	'use strict';

	// Stand / walk-frame-1 base sprite indices (8 rotation frames each).
	var BASE = {
		guard: 50,    // SPR_GRD_S_1
		officer: 238, // SPR_OFC_S_1
		ss: 138,      // SPR_SS_S_1
		mutant: 187,  // SPR_MUT_S_1
		dog: 99       // SPR_DOG_W1_1 (dogs have no stand frames -> walk frame 1)
	};
	var GRD_DEAD = 95; // SPR_GRD_DEAD (decorative corpse, single frame)

	// Sight/alert digitized-sound chunk per enemy base (WL6 wolfdigimap indices).
	// -1 = no vocalisation. Used only to make the digi sounds audible while
	// exploring; it is a sound cue, not combat AI.
	var ALERT = {};
	ALERT[BASE.guard] = 0;    // HALTSND    ("Halt!")
	ALERT[BASE.officer] = 8;  // GUTENTAGSND
	ALERT[BASE.ss] = 7;       // SCHUTZADSND
	ALERT[BASE.dog] = 1;      // DOGBARKSND
	ALERT[BASE.mutant] = -1;  // mutants are silent

	// 4-directional trooper blocks: [firstCode, base, type, minDiff, patrol].
	// Each block spans firstCode..firstCode+3 (dir 0..3). minDiff mirrors
	// ScanInfoPlane: base blocks spawn at any skill, the second set needs medium,
	// the third needs hard. patrol=true means the actor walks a set route.
	var G = 'guard', O = 'officer', S = 'ss', D = 'dog', M = 'mutant';
	var BLOCKS = [
		// guard
		[108, BASE.guard, G, 0, 0], [112, BASE.guard, G, 0, 1], [144, BASE.guard, G, 2, 0],
		[148, BASE.guard, G, 2, 1], [180, BASE.guard, G, 3, 0], [184, BASE.guard, G, 3, 1],
		// officer
		[116, BASE.officer, O, 0, 0], [120, BASE.officer, O, 0, 1], [152, BASE.officer, O, 2, 0],
		[156, BASE.officer, O, 2, 1], [188, BASE.officer, O, 3, 0], [192, BASE.officer, O, 3, 1],
		// ss
		[126, BASE.ss, S, 0, 0], [130, BASE.ss, S, 0, 1], [162, BASE.ss, S, 2, 0],
		[166, BASE.ss, S, 2, 1], [198, BASE.ss, S, 3, 0], [202, BASE.ss, S, 3, 1],
		// dog
		[134, BASE.dog, D, 0, 0], [138, BASE.dog, D, 0, 1], [170, BASE.dog, D, 2, 0],
		[174, BASE.dog, D, 2, 1], [206, BASE.dog, D, 3, 0], [210, BASE.dog, D, 3, 1],
		// mutant
		[216, BASE.mutant, M, 0, 0], [220, BASE.mutant, M, 0, 1], [234, BASE.mutant, M, 2, 0],
		[238, BASE.mutant, M, 2, 1], [252, BASE.mutant, M, 3, 0], [256, BASE.mutant, M, 3, 1]
	];

	// Single-frame spawns: {base, type[, boss]}. Corpses are inert; ghosts and
	// bosses are actors. Boss kinds map to their combat stats in ai.js.
	var SINGLE = {
		124: { base: GRD_DEAD, type: 'corpse' },       // dead guard
		214: { base: 296, type: 'boss', boss: 'hans' },
		197: { base: 385, type: 'boss', boss: 'gretel' },
		215: { base: 360, type: 'boss', boss: 'gift' },
		179: { base: 396, type: 'boss', boss: 'fat' },
		196: { base: 307, type: 'boss', boss: 'schabbs' },
		160: { base: 321, type: 'boss', boss: 'fake' },
		178: { base: 334, type: 'boss', boss: 'mecha' },
		224: { base: 288, type: 'ghost' }, 225: { base: 292, type: 'ghost' },
		226: { base: 290, type: 'ghost' }, 227: { base: 294, type: 'ghost' }
	};

	// Decode a plane-1 tile code into a spawn descriptor, or null if it is not an
	// enemy/actor spawn. `minDiff` mirrors ScanInfoPlane so callers can filter by
	// skill; `type` selects combat behaviour, `patrol` marks a walking route.
	function decodeSpawn(code) {
		if (SINGLE.hasOwnProperty(code)) {
			var s = SINGLE[code];
			return {
				base: s.base, dirType: 0, rotate: false, alert: -1,
				type: s.type, boss: s.boss || null, minDiff: 0, patrol: false
			};
		}
		for (var b = 0; b < BLOCKS.length; b++) {
			var start = BLOCKS[b][0];
			if (code >= start && code <= start + 3) {
				var dir = code - start;          // 0..3 (E, N, W, S)
				var base = BLOCKS[b][1];
				var al = ALERT.hasOwnProperty(base) ? ALERT[base] : -1;
				return {
					base: base, dirType: dir * 2, rotate: true, alert: al,
					type: BLOCKS[b][2], boss: null, minDiff: BLOCKS[b][3], patrol: !!BLOCKS[b][4]
				};
			}
		}
		return null;
	}

	// Pick the rotation frame for a rotating enemy, mirroring WL_DRAW.C CalcRotate
	// (minus its screen-space perspective term). Uses the id-Software angle space
	// internally (0=east, CCW, degrees; north = -y), independent of the engine's
	// own angle sign, so it stays correct regardless of camera convention.
	function rotFrame(dirType, ex, ey, px, py) {
		var a = Math.atan2(-(py - ey), px - ex) * 180 / Math.PI; // enemy -> viewer
		var ang = a - dirType * 45 + 22.5;                       // dirangle = dirType*45
		ang = ((ang % 360) + 360) % 360;
		return Math.floor(ang / 45) % 8;
	}

	function spriteFor(spawn, ex, ey, px, py) {
		if (!spawn.rotate) return spawn.base;
		return spawn.base + rotFrame(spawn.dirType, ex, ey, px, py);
	}

	// Movement vectors per dirtype (east, ne, north, nw, west, sw, south, se).
	// north = -y, matching the engine's start-facing convention.
	var DIRVEC = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];
	var NODIR = 8;
	var OPPOSITE = [4, 5, 6, 7, 0, 1, 2, 3, 8];

	root.WolfEnemies = {
		decodeSpawn: decodeSpawn, spriteFor: spriteFor, rotFrame: rotFrame,
		BASE: BASE, DIRVEC: DIRVEC, NODIR: NODIR, OPPOSITE: OPPOSITE
	};
})(typeof window !== 'undefined' ? window : this);
