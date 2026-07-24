/*
 * variants.js — game-dataset profiles (Wolfenstein 3D vs. Spear of Destiny).
 *
 * The engine is dataset-agnostic; only a set of numeric tables differs between
 * the registered Wolfenstein 3D (WL6) and Spear of Destiny (SOD) data. This is
 * the runtime equivalent of Wolf4SDL's compile-time `#ifdef SPEAR`: one engine,
 * one profile object selected at load time.
 *
 * All sprite fields are RELATIVE sprite-chunk indices (page = spriteStart +
 * index); spriteStart itself is read from the VSWAP header, so a profile only
 * carries the enum offsets, not absolute pages.
 *
 * WL6 numbers are the ones already proven in ai.js/enemies.js/game.js and are
 * NOT duplicated here where a module already holds them (see spriteShift/boss):
 * the WL6 path stays byte-identical to before. SOD numbers were derived from the
 * GPL-licensed Wolf4SDL source with SPEAR defined (wl_def.h sprite enum,
 * wl_game.cpp ScanInfoPlane, wl_act2.cpp starthitpoints, gfxv_sod.h, wl_play.cpp
 * songs[], audiosod.h) and cross-checked by recomputing the WL6 values and
 * matching them against the existing tables.
 *
 * NOTE ON SOD SOUND: the digitised-sound directory order (wolfdigimap) is not
 * shipped by Wolf4SDL's engine — it reads it from VSWAP at runtime — but it IS
 * in Wolf4SDL's wl_main.cpp as a source table. Its WL6 branch reproduces
 * DIGI_WL6 exactly, so its SPEAR branch (DIGI_SOD below) is trustworthy: the SOD
 * slot order diverges from WL6 from index 8 on, which is why reusing the WL6 map
 * made guard fire bark and officer alerts play boss fire. Sounds SOD has no digi
 * for map to -1 (silent) and simply play nothing.
 */
(function (root) {
	'use strict';

	// The WL6 digitised-sound map (wolfdigimap order), copied verbatim from
	// sound.js so a profile can carry it. SOD reuses this map (see note above).
	var DIGI_WL6 = {
		HALT: 0, DOGBARK: 1, CLOSEDOOR: 2, OPENDOOR: 3,
		MGUN: 4, PISTOL: 5, GATLING: 6, SCHUTZ: 7, GUTENTAG: 8, MUTTI: 9,
		BOSSFIRE: 10, SSFIRE: 11, DEATH1: 12, DEATH2: 13, TAKEDMG: 14, PUSHWALL: 15,
		DOGDEATH: 16, AHHG: 17, DIE: 18, EVA: 19, LEBEN: 20, NAZIFIRE: 21,
		SLURPIE: 22, TOTHUND: 23, MEINGOTT: 24, SCHABBSHA: 25, HITLERHA: 26,
		SPION: 27, NEINSOVAS: 28, DOGATTACK: 29, LEVELDONE: 30, MECHSTEP: 31, YEAH: 32,
		SCHEIST: 33, DONNER: 36, EINE: 37, ERLAUBEN: 38, KEIN: 43, MEIN: 44, ROSE: 45,
		DEATH3: 13, DEATH4: 34, DEATH5: 35, FART: 39, DEATH7: 40, DEATH8: 41, DEATH9: 42
	};

	// The SOD digitised-sound map, from the SPEAR branch of Wolf4SDL's wolfdigimap
	// (wl_main.cpp). The slot order differs from WL6 from index 8 on — reusing the
	// WL6 map made guard fire play the dog-attack sound, officer alerts play boss
	// fire, etc. Sounds that SOD has no digi for map to -1 (silent). SOD adds real
	// boss taunts (TRANSSIGHT..ANGELDEATH). Verified: the WL6 branch of that same
	// array reproduces DIGI_WL6 exactly.
	var DIGI_SOD = {
		HALT: 0, DOGBARK: 1, CLOSEDOOR: 2, OPENDOOR: 3,
		MGUN: 4, PISTOL: 5, GATLING: 6, SCHUTZ: 7, BOSSFIRE: 8, SSFIRE: 9,
		DEATH1: 10, DEATH2: 11, TAKEDMG: 12, PUSHWALL: 13, DOGDEATH: 14, AHHG: 15,
		LEBEN: 16, NAZIFIRE: 17, SLURPIE: 18, SPION: 19, NEINSOVAS: 20, DOGATTACK: 21,
		LEVELDONE: 22, DEATH4: 23, DEATH3: 23, DEATH5: 24, FART: 25, DEATH7: 26,
		DEATH8: 27, DEATH9: 28, GETGATLING: 38, GETSPEAR: 39,
		// SOD-specific boss taunts
		TRANSSIGHT: 29, TRANSDEATH: 30, WILHELMSIGHT: 31, WILHELMDEATH: 32,
		UBERDEATH: 33, KNIGHTSIGHT: 34, KNIGHTDEATH: 35, ANGELSIGHT: 36, ANGELDEATH: 37,
		// present in WL6 but absent from the SOD digi bank -> silent
		GUTENTAG: -1, MUTTI: -1, DIE: -1, EVA: -1, TOTHUND: -1, MEINGOTT: -1,
		SCHABBSHA: -1, HITLERHA: -1, MECHSTEP: -1, YEAH: -1, SCHEIST: -1, DONNER: -1,
		EINE: -1, ERLAUBEN: -1, KEIN: -1, MEIN: -1, ROSE: -1
	};

	// ---- Wolfenstein 3D (registered, WL6) ----------------------------------
	var WL6 = {
		id: 'WL6',
		name: 'Wolfenstein 3D',
		ext: 'WL6',
		// spriteShift 0 and boss:null mean "use the built-in WL6 tables in
		// enemies.js / ai.js unchanged" — the WL6 path is not rerouted.
		spriteShift: 0,
		enemies: null,          // use enemies.js built-ins
		boss: null,             // use ai.js built-in BOSS table
		digi: DIGI_WL6,
		weaponBase: [416, 421, 426, 431],   // SPR_KNIFEREADY / PISTOL / MG / CHAIN
		// plane1 codes of static decorations that block movement (statinfo[].block;
		// code = 23 + statinfo index). These are the WL6 values.
		statics: {
			block: [24, 25, 26, 28, 30, 31, 33, 34, 35, 36, 39, 40, 41, 45, 58, 59, 60, 62, 63, 68, 69],
			pickup: null
		},
		numSounds: 87,                       // LASTSOUND — AUDIOT FM/music base offset
		// Par times in MINUTES (wl_inter.cpp parTimes[]); 0 = no par (boss and
		// secret floors), which means no time bonus is possible there.
		parTimes: [
			1.5, 2, 2, 3.5, 3, 3, 2.5, 2.5, 0, 0,
			1.5, 3.5, 3, 2, 4, 6, 1, 3, 0, 0,
			1.5, 1.5, 2.5, 2.5, 3.5, 2.5, 2, 6, 0, 0,
			2, 2, 1.5, 1, 4.5, 3.5, 2, 4.5, 0, 0,
			2.5, 1.5, 2.5, 2.5, 4, 3, 4.5, 3.5, 0, 0,
			6.5, 4, 4.5, 6, 5, 5.5, 5.5, 8.5, 0, 0
		],
		// GOTGATLING replaces the face while the chaingun pickup jingle plays, and
		// MUTANTBJ is Wolfenstein's death portrait after Schabbs' syringe gets you
		// (`#ifndef SPEAR` in DrawFace). Wolfenstein has no god-mode face.
		vga: {
			STATUSBAR: 86, KNIFE: 91, NOKEY: 95, GOLDKEY: 96, SILVERKEY: 97,
			N_BLANK: 98, N_0: 99, FACE1A: 109,
			GOTGATLING: 131, MUTANTBJ: 132, GODMODEFACE: -1
		},
		songs: [
			3, 11, 9, 12, 3, 11, 9, 12, 2, 0,
			8, 18, 17, 4, 8, 18, 4, 17, 2, 1,
			6, 20, 22, 21, 6, 20, 22, 21, 19, 26,
			3, 11, 9, 12, 3, 11, 9, 12, 2, 0,
			8, 18, 17, 4, 8, 18, 4, 17, 2, 1,
			6, 20, 22, 21, 6, 20, 22, 21, 19, 15
		],
		prog: { episodeFloors: 10, elevatorBackTo: [1, 1, 7, 3, 5, 3], episodes: true, secretWarp: true }
	};

	// ---- Spear of Destiny (SOD) --------------------------------------------
	// Shared enemies (guard/officer/ss/mutant/dog) are the WL6 tables shifted by
	// +4 (SPR_STAT_48..51 add four SPEAR-only statics before SPR_GRD_S_1);
	// ai.js applies spriteShift for those. The boss cast is entirely different
	// and given explicitly. Boss floors just die (elevator continues); the Angel
	// of Death is the finale (end 'victory'). Each boss fires its real attack —
	// the Death Knight's twin rockets, the Angel's sparks with the relaunch/tired
	// cycle — over a generic chase; the Angel's self-heal is the only unmodelled bit.
	var D = DIGI_SOD;
	var SOD = {
		id: 'SOD',
		name: 'Spear of Destiny',
		ext: 'SOD',
		spriteShift: 4,
		enemies: {
			// relative sprite bases (spriteStart + index), SPEAR enum
			BASE: { guard: 54, officer: 242, ss: 142, mutant: 191, dog: 103 },
			GRD_DEAD: 99,           // SPR_GRD_DEAD (SPEAR)
			// plane-1 spawn codes -> single-frame actors. Trooper block codes are
			// identical to WL6 (shared ScanInfoPlane) and stay in enemies.js.
			SINGLE: {
				124: { base: 99,  type: 'corpse' },                 // SpawnDeadGuard
				125: { base: 326, type: 'boss', boss: 'trans' },    // Trans Grosse
				143: { base: 337, type: 'boss', boss: 'will' },     // Barnacle Wilhelm
				142: { base: 349, type: 'boss', boss: 'uber' },     // Ubermutant
				161: { base: 362, type: 'boss', boss: 'death' },    // Death Knight
				107: { base: 385, type: 'boss', boss: 'angel' },    // Angel of Death (finale)
				106: { base: 377, type: 'boss', boss: 'ghost' }     // Spectre
			}
		},
		// SOD boss table (consumed by ai.js bossType). Sounds use the real SOD boss
		// taunts; Uber and the Spectre have no sight sound in the SOD digi bank.
		boss: {
			// chase speeds are the per-boss values FirstSighting assigns in the
			// original (wl_state.cpp): Trans/Angel 1536, Wilhelm/Death 2048,
			// Ubermutant 3000, Spectre 800.
			trans: { W: 326, SHOOT1: 330, DIE1: 334, dieN: 3, DEAD: 333, sight: D.TRANSSIGHT,
				chase: 1536,
				SHOOT: [[330, 20, 0], [331, 20, 1], [332, 20, 1]],
				hp: [850, 950, 1050, 1200], pts: 5000, death: D.TRANSDEATH, end: null },

			// T_Will: shoots, but breaks off and runs once you are within 4 tiles.
			will:  { W: 337, SHOOT1: 341, DIE1: 345, dieN: 3, DEAD: 348, sight: D.WILHELMSIGHT,
				chase: 2048, runAway: true,
				SHOOT: [[341, 20, 0], [342, 20, 1], [343, 20, 1], [344, 20, 1]],
				hp: [950, 1050, 1150, 1300], pts: 5000, death: D.WILHELMDEATH, end: null },

			// T_UShoot = T_Shoot plus a flat 10 damage when he is right next to you.
			uber:  { W: 349, SHOOT1: 353, DIE1: 357, dieN: 4, DEAD: 361, sight: -1,
				chase: 3000, closeDmg: 10,
				SHOOT: [[353, 20, 0], [354, 20, 1], [355, 20, 1], [356, 20, 1]],
				hp: [1050, 1150, 1250, 1400], pts: 5000, death: D.UBERDEATH, end: null },

			// T_Launch: the Death Knight fires bullets AND two rockets, fanned a few
			// degrees either side of your bearing (iangle -4 / +4 in the original).
			death: { W: 362, SHOOT1: 366, DIE1: 370, dieN: 6, DEAD: 376, sight: D.KNIGHTSIGHT,
				chase: 2048,
				SHOOT: [[366, 20, 0], [367, 20, 'hrocket:-4'], [368, 20, 'hrocket:+4'], [369, 20, 1]],
				hp: [1250, 1350, 1450, 1600], pts: 5000, death: D.KNIGHTDEATH, end: null },

			// T_Launch + A_Relaunch: the Angel throws sparks, and after three of them
			// it drops into a tired state to catch its breath before coming back.
			angel: { W: 385, SHOOT1: 389, DIE1: 393, dieN: 7, DEAD: 400, sight: D.ANGELSIGHT,
				chase: 1536, relaunch: 3, TIRED: [391, 392], tiredFx: 80,
				SHOOT: [[389, 20, 'attack0'], [390, 20, 'spark'], [390, 10, 'relaunch']],
				hp: [1450, 1550, 1650, 2000], pts: 5000, death: D.ANGELDEATH, end: 'victory' },

			// The Spectre never really dies: killing it plays the fade-out frames and
			// A_Dormant puts it back to sleep, ready to rise again. 200 points once.
			// It has no ranged attack at all: MoveObj drains your health while it is
			// touching you (tics*2), which is why there is no SHOOT sequence here.
			ghost: { W: 377, DIE1: 381, dieN: 4, DEAD: 384, sight: -1,
				chase: 800, dormant: true, contactDmg: 2,
				hp: [5, 10, 15, 25], pts: 200, death: -1, end: null }
		},
		digi: D,
		// SPEAR projectiles. Sprite pages from the SPEAR sprite enum; sounds are
		// AdLib indices from audiosod.h (KNIGHTMISSILESND 78, ANGELFIRESND 69,
		// MISSILEHITSND 1). The Death Knight's rocket also fires bullets on the
		// same frame, because T_Launch calls T_Shoot for him.
		proj: {
			hrocket: {
				frames: [307], tics: 3, rot: true,
				speed: 0x2000, dmg: function (r) { return (r >> 3) + 30; },
				launch: 78, impact: 1,
				boom: [319, 320, 321], boomTics: 6, withShot: true
			},
			spark: {
				frames: [322, 323, 324, 325], tics: 6, rot: false,
				speed: 0x2000, dmg: function (r) { return (r >> 3) + 20; },
				launch: 69
			}
		},
		weaponBase: [401, 406, 411, 416],   // SPEAR SPR_KNIFEREADY / PISTOL / MG / CHAIN
		// statinfo[] under SPEAR differs from WL6 in four places, so the blocking
		// decoration set is NOT the same: SPR_STAT_15 (code 38) and SPR_STAT_44
		// (code 67) become blocking "gibs", SPR_STAT_40 (code 63) turns from the
		// blocking "Call Apogee" sign into a NON-blocking red ceiling light, and
		// SPEAR adds SPR_STAT_48/50 (codes 71/73, marble pillar and truck).
		// Reusing the WL6 list made SOD's red lamps solid walls.
		statics: {
			block: [24, 25, 26, 28, 30, 31, 33, 34, 35, 36, 38, 39, 40, 41, 45,
				58, 59, 60, 62, 67, 68, 69, 71, 73],
			// SPEAR-only collectibles (statinfo indices 49 and 51). The spear itself
			// ends the floor on pickup (GetBonus sets playstate = ex_completed).
			pickup: {
				72: { ammo: 25, snd: 64 },        // bonus 25-clip, GETAMMOBOXSND
				74: { complete: 1, snd: 79 }      // SPEAR OF DESTINY, GETSPEARSND
			}
		},
		numSounds: 81,                       // SPEAR LASTSOUND — AUDIOT base offset (WL6 is 87)
		// Spear's own par times. The original table has only 20 entries for its 21
		// floors, so the last floor simply has no par — reproduced here by omission.
		parTimes: [
			1.5, 3.5, 2.75, 3.5, 0, 4.5, 3.25, 2.75, 4.75, 0,
			6.5, 4.5, 2.75, 4.5, 6, 0, 6, 0, 0, 0
		],
		// Spear ships sodpal.inc, which is byte-identical to wolfpal.inc except for
		// two entries: the two bright purples become very dark greens. Sparse
		// override rather than a second full table.
		palette: {
			166: [0, 56, 0],                 // WL6 (182, 32, 255) -> SOD (0, 56, 0)
			167: [0, 40, 0]                  // WL6 (170,  0, 255) -> SOD (0, 40, 0)
		},
		// Spear is the one with a god-mode portrait (GODMODEFACE1..3, indexed by the
		// face frame directly), and it has no mutant-BJ death picture.
		vga: {
			STATUSBAR: 90, KNIFE: 101, NOKEY: 105, GOLDKEY: 106, SILVERKEY: 107,
			N_BLANK: 108, N_0: 109, FACE1A: 119,
			GOTGATLING: 141, MUTANTBJ: -1, GODMODEFACE: 142
		},
		// songs[] under SPEAR (wl_play.cpp) mapped to SOD music-track indices
		// (audiosod.h). 21 floors, one continuous campaign.
		songs: [4, 0, 2, 22, 15, 1, 5, 9, 10, 15, 8, 3, 12, 11, 13, 15, 21, 15, 18, 0, 17],
		// vgaCeiling[] under SPEAR (wl_draw.cpp): the 21 SOD floors' ceiling colours
		// (VGA palette indices). Byte-exact to Wolf4SDL.
		ceiling: [
			0x6f, 0x4f, 0x1d, 0xde, 0xdf, 0x2e, 0x7f, 0x9e, 0xae, 0x7f,
			0x1d, 0xde, 0xdf, 0xde, 0xdf, 0xde, 0xe1, 0xdc, 0x2e, 0x1d, 0xdc
		],
		// Flat 21-floor run: no episodes, no secret-elevator warp (a documented
		// simplification — the SOD bonus floors 19-21 are reached normally here).
		// Spear is one continuous 21-floor campaign: no episodes, and the floor
		// counter runs straight through 1..21 rather than restarting. Its two bonus
		// floors hang off hidden elevators on maps 3 and 11 (0-based), and each
		// returns you to the map after the one you left.
		prog: {
			episodeFloors: 21, elevatorBackTo: [1], episodes: false, secretWarp: true,
			secretMap: { to: { 3: 18, 11: 19 }, back: { 18: 4, 19: 12 } }
		}
	};

	var VARIANTS = { WL6: WL6, SOD: SOD };

	// Active-profile holder. Modules register via onUse() and are (re)configured
	// whenever use() picks a profile; main.js calls use() before a level starts.
	var holder = {
		active: WL6,            // sane default so early reads never see null
		_cbs: [],
		list: function () { return [WL6, SOD]; },
		get: function (id) { return VARIANTS[id] || null; },
		onUse: function (fn) { this._cbs.push(fn); if (this.active) fn(this.active); },
		use: function (id) {
			var v = VARIANTS[id];
			if (!v) return false;
			this.active = v;
			for (var i = 0; i < this._cbs.length; i++) this._cbs[i](v);
			return true;
		}
	};

	root.WolfVariants = VARIANTS;
	root.WolfVariant = holder;
})(typeof window !== 'undefined' ? window : this);
