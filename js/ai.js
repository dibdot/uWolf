/*
 * ai.js — enemy AI, combat, and the actor state machine.
 *
 * This is an ORIGINAL implementation whose behaviour is ported from the
 * GPL-licensed Wolf4SDL logic (WL_STATE.C, WL_ACT2.C, WL_AGENT.C): the state
 * tables, movement (TryWalk / SelectChaseDir / MoveObj), line-of-sight
 * (CheckLine), sighting/reaction, the hit-probability and damage formulas, and
 * the per-difficulty hitpoints. Frame indices and timings are the real ones.
 *
 * Deliberate simplifications (see README): patrol routes ignore the map's turn
 * arrows (actors walk straight and turn at walls); "area" activation is
 * approximated by line-of-sight plus gunfire noise; line-of-sight treats a door
 * as see-through once it is at least half open; bosses use a generic ranged
 * chase rather than their unique attack patterns. Timing runs on the original
 * 70 Hz tic clock (1 tic = 1/70 s).
 */
(function (root) {
	'use strict';

	var E = root.WolfEnemies;
	var DIRVEC = E.DIRVEC, NODIR = E.NODIR, OPPOSITE = E.OPPOSITE;
	var DIGI = root.SoundManager ? root.SoundManager.DIGI : {};

	var TICS = 70;                 // tic rate
	var G2T = TICS / 65536;        // global-units/tic speed -> tiles/sec
	var MINACTORDIST = 1.0;        // 0x10000 in tiles: personal space / melee reach
	var KNIFE_REACH = 1.5;         // 0x18000

	// Per-type combat config. Sprite fields are RELATIVE indices (page =
	// spriteStart + index). shoot/die entries are [spr, tics, fireFlag]; for die,
	// fireFlag on the first frame triggers the death scream.
	function spd(globalPerTic) { return globalPerTic * G2T; }
	var HP = { // [baby, easy, medium, hard]
		guard: [25, 25, 25, 25], officer: [50, 50, 50, 50], ss: [100, 100, 100, 100],
		dog: [1, 1, 1, 1], mutant: [45, 55, 55, 65], boss: [850, 950, 1050, 1200]
	};

	var TYPES = {
		guard: {
			S: 50, W: 58, PAIN: 90, PAIN2: 94, DEAD: 95,
			SHOOT: [[96, 20, 0], [97, 20, 1], [98, 20, 0]],
			DIE: [[91, 15, 1], [92, 15, 0], [93, 15, 0]],
			patrol: spd(512), chase: spd(1536), sight: DIGI.HALT, fire: DIGI.NAZIFIRE,
			hp: HP.guard, pts: 100
		},
		officer: {
			S: 238, W: 246, PAIN: 278, PAIN2: 282, DEAD: 284,
			SHOOT: [[285, 6, 0], [286, 20, 1], [287, 10, 0]],
			DIE: [[279, 11, 1], [280, 11, 0], [281, 11, 0], [283, 11, 0]],
			patrol: spd(512), chase: spd(2560), sight: DIGI.SPION, fire: DIGI.NAZIFIRE,
			hp: HP.officer, pts: 400
		},
		ss: {
			S: 138, W: 146, PAIN: 178, PAIN2: 182, DEAD: 183,
			SHOOT: [[184, 20, 0], [185, 20, 1], [186, 10, 0], [185, 10, 1], [186, 10, 0],
			[185, 10, 1], [186, 10, 0], [185, 10, 1], [186, 10, 0]],
			DIE: [[179, 15, 1], [180, 15, 0], [181, 15, 0]],
			patrol: spd(512), chase: spd(2048), sight: DIGI.SCHUTZ, fire: DIGI.SSFIRE,
			hp: HP.ss, pts: 500, betterShot: true
		},
		mutant: {
			S: 187, W: 195, PAIN: 227, PAIN2: 231, DEAD: 233,
			SHOOT: [[234, 6, 1], [235, 20, 0], [236, 10, 1], [237, 20, 0]],
			DIE: [[228, 7, 1], [229, 7, 0], [230, 7, 0], [232, 7, 0]],
			patrol: spd(512), chase: spd(1536), sight: -1, fire: DIGI.NAZIFIRE,
			hp: HP.mutant, pts: 700
		},
		dog: {
			// The original has no dog "stand" state at all: SpawnStand() simply has no
			// en_dog case, even though ScanInfoPlane sends codes 134-137 there (a latent
			// bug in the original). A stationary dog therefore has no frames of its own —
			// we use walk frame 1, which is what a standing dog looks like.
			S: 99, W: 99, DEAD: 134,
			JUMP: [[135, 10, 0], [136, 10, 1], [137, 10, 0], [135, 10, 0], [99, 10, 0]],
			DIE: [[131, 15, 1], [132, 15, 0], [133, 15, 0]],
			patrol: spd(1500), chase: spd(3000), sight: DIGI.DOGBARK, fire: -1,
			hp: HP.dog, pts: 200, dog: true
		}
	};
	// The WL6 tables above are the default; a dataset variant may shift the shared
	// enemy sprites (see the WolfVariant hook after the boss table).
	var TYPES_WL6 = TYPES;

	// [W1, SHOOT1, DIE1, DEAD, sightSound, ending]
	//
	// How a boss floor ends is NOT the same for every boss (this trips people up):
	//   - Hans and Gretel just die. KillActor() drops a GOLD KEY (bo_key1) on their
	//     tile, and you still have to unlock the door and ride the elevator out.
	//   - Schabbs, Giftmacher, Fat Face and Hitler end the floor the moment they
	//     die: their last death frame runs A_StartDeathCam, which leads to
	//     ex_victorious. Those floors have no elevator for you to find.
	//   - Fake Hitler is neither — he's just a very tough regular enemy.
	// Per-boss data, straight from the source. Note how little of this is uniform —
	// a single "generic boss" was simply wrong:
	//
	//   end 'key'     — Hans / Gretel: KillActor drops bo_key1; you still ride out.
	//   end 'victory' — Schabbs / Gift / Fat / real Hitler: the last death frame runs
	//                   A_StartDeathCam -> ex_victorious. Those floors have no elevator.
	//   end 'morph'   — Mecha Hitler: A_HitlerMorph replaces him with Adolf himself,
	//                   who then has to be killed as well.
	//   end null      — Fake Hitler: just a very tough regular enemy.
	//
	// hp is starthitpoints[difficulty]; note that Schabbs (2400 on hard!) and Fake
	// Hitler (500) are nowhere near the rest.
	// Projectiles (T_Projectile). Speeds are the raw global units/tic from the source;
	// damage is rolled from the same 0..255 counter the rest of the game uses.
	//   PROJECTILESIZE 0xC000 = 0.75 tiles — how close it has to get to hurt you
	//   PROJSIZE       0x2000 = 0.125     — its own half-width, for hitting walls
	var HIT_RADIUS = 0.75, PROJ_HALF = 0.125;

	// B.J.'s victory run: he spawns where you are standing, runs six tiles (following
	// the map's turn arrows, like a patrolling guard would), then jumps — and on the
	// second jump frame he says the only word he ever says.
	var BJ = { W: 408, JUMP: 412, run: spd(2048), jump: spd(680), tiles: 6 };

	function bjStates() {
		if (bjStates._s) return bjStates._s;
		function st(spr, tics, think, action) {
			return { rot: false, spr: spr, tics: tics, think: think, action: action, next: null };
		}
		var W = BJ.W, J = BJ.JUMP;
		var r1 = st(W, 12, 'bjrun', null), r1s = st(W, 3, null, null);
		var r2 = st(W + 1, 8, 'bjrun', null);
		var r3 = st(W + 2, 12, 'bjrun', null), r3s = st(W + 2, 3, null, null);
		var r4 = st(W + 3, 8, 'bjrun', null);
		r1.next = r1s; r1s.next = r2; r2.next = r3; r3.next = r3s; r3s.next = r4; r4.next = r1;

		var j1 = st(J, 14, 'bjjump', null);
		var j2 = st(J + 1, 14, 'bjjump', 'bjyell');     // "Yeah!"
		var j3 = st(J + 2, 14, 'bjjump', null);
		var j4 = st(J + 3, 300, null, 'bjdone');        // hold, then the episode is over
		j1.next = j2; j2.next = j3; j3.next = j4; j4.next = j4;

		bjStates._s = { run1: r1, jump1: j1 };
		return bjStates._s;
	}

	var PROJ = {
		// Schabbs' syringe: four frames, no rotation, and it stings.
		needle: {
			frames: [317, 318, 319, 320], tics: 6, rot: false,
			speed: spd(0x2000), dmg: function (r) { return (r >> 3) + 20; },
			launch: 8                                     // SCHABBSTHROWSND
		},
		// Giftmacher's and Fat Face's rocket: rotates to face you, explodes on a wall.
		rocket: {
			frames: [370], tics: 3, rot: true,
			speed: spd(0x2000), dmg: function (r) { return (r >> 3) + 30; },
			launch: 85, impact: 86,                       // MISSILEFIRESND / MISSILEHITSND
			boom: [382, 383, 384], boomTics: 6
		},
		// Fake Hitler's fireball: slower, and weak on its own — he throws eight of them.
		fire: {
			frames: [326, 327], tics: 6, rot: false,
			speed: spd(0x1200), dmg: function (r) { return r >> 3; },
			launch: 69                                    // FLAMETHROWERSND
		}
	};
	// Projectiles are dataset-dependent: the sprite pages above are Wolfenstein's
	// and Spear has its own pair (the Death Knight's rocket and the Angel's spark).
	// Rebuilt on a variant switch, same pattern as the enemy tables. Spear never
	// spawns the WL6-only throwers, so leaving their entries in place is harmless.
	var PROJ_BASE = PROJ;
	function setProj(extra) {
		if (!extra) { PROJ = PROJ_BASE; return; }
		var m = {}, k;
		for (k in PROJ_BASE) if (PROJ_BASE.hasOwnProperty(k)) m[k] = PROJ_BASE[k];
		for (k in extra) {
			if (!extra.hasOwnProperty(k)) continue;
			var src = extra[k], o = {};
			for (var f in src) if (src.hasOwnProperty(f)) o[f] = src[f];
			// Profiles carry raw per-tic speeds (as the source does); convert them
			// the same way the built-in table does.
			if (typeof o.speed === 'number') o.speed = spd(o.speed);
			m[k] = o;
		}
		PROJ = m;
	}

	var BOSS = {
		hans:    { W: 296, SHOOT1: 300, DIE1: 304, dieN: 3, DEAD: 303, sight: DIGI.GUTENTAG,
			hp: [850, 950, 1050, 1200], pts: 5000, death: DIGI.MUTTI, end: 'key' },
		gretel:  { W: 385, SHOOT1: 389, DIE1: 393, dieN: 3, DEAD: 392, sight: DIGI.KEIN,
			hp: [850, 950, 1050, 1200], pts: 5000, death: DIGI.MEIN, end: 'key' },
		gift:    { W: 360, SHOOT1: 364, DIE1: 366, dieN: 3, DEAD: 369, sight: DIGI.EINE,
			hp: [850, 950, 1050, 1200], pts: 5000, death: DIGI.DONNER, end: 'victory',
			// wind up, then launch a rocket
			SHOOT: [[364, 30, 0], [365, 10, 'rocket']] },
		fat:     { W: 396, SHOOT1: 400, DIE1: 404, dieN: 3, DEAD: 407, sight: DIGI.ERLAUBEN,
			hp: [850, 950, 1050, 1200], pts: 5000, death: DIGI.ROSE, end: 'victory',
			// a rocket first, then four bursts from the chainguns
			SHOOT: [[400, 30, 0], [401, 10, 'rocket'], [402, 10, 1], [403, 10, 1],
				[402, 10, 1], [403, 10, 1]] },
		schabbs: { W: 307, SHOOT1: 311, DIE1: 313, dieN: 3, DEAD: 316, sight: DIGI.SCHABBSHA,
			hp: [850, 950, 1550, 2400], pts: 5000, death: DIGI.MEINGOTT, end: 'victory',
			// wind up, then throw a syringe
			SHOOT: [[311, 30, 0], [312, 10, 'needle']] },
		fake:    { W: 321, SHOOT1: 325, DIE1: 328, dieN: 5, DEAD: 333, sight: DIGI.TOTHUND,
			hp: [200, 300, 400, 500], pts: 2000, death: DIGI.HITLERHA, end: null,
			// eight fireballs in a row — individually weak, together lethal
			SHOOT: [[325, 8, 'fire'], [325, 8, 'fire'], [325, 8, 'fire'], [325, 8, 'fire'],
				[325, 8, 'fire'], [325, 8, 'fire'], [325, 8, 'fire'], [325, 8, 'fire'],
				[325, 8, 0]] },
		mecha:   { W: 334, SHOOT1: 338, DIE1: 342, dieN: 3, DEAD: 341, sight: DIGI.DIE,
			hp: [800, 950, 1050, 1200], pts: 5000, death: DIGI.SCHEIST,
			end: 'morph', morphTo: 'hitler' },
		// Adolf himself: steps out of the suit when Mecha Hitler falls. Faster than any
		// other boss (SPDPATROL*5), fires a five-shot burst, takes seven frames to die.
		hitler:  { W: 345, SHOOT1: 349, DIE1: 353, dieN: 7, DEAD: 352, sight: DIGI.DIE,
			hp: [500, 700, 800, 900], pts: 5000, death: DIGI.EVA, end: 'victory',
			chase: 2560,
			SHOOT: [[349, 30, 0], [350, 10, 1], [351, 10, 1], [350, 10, 1], [351, 10, 1], [350, 10, 1]] }
	};
	var BOSS_WL6 = BOSS;

	// Dataset variants (e.g. Spear of Destiny) shift the shared enemy sprites by a
	// fixed amount — SOD inserts four SPEAR-only statics (SPR_STAT_48..51) before
	// the guard sprites, so every shared enemy frame moves by +4 — and replace the
	// boss cast entirely. The shift is uniform, so it is applied mechanically to
	// the WL6 tables; the boss table is swapped wholesale (see variants.js). Any
	// cache that bakes in sprite numbers is cleared on a switch.
	function shiftRows(rows, n) {
		return rows ? rows.map(function (r) { return [r[0] + n, r[1], r[2]]; }) : rows;
	}
	function shiftTypes(src, n) {
		if (!n) return src;
		var out = {};
		for (var k in src) {
			if (!src.hasOwnProperty(k)) continue;
			var t = src[k], o = {};
			// Copy the data fields only. statesFor() memoises a built state graph on
			// the type object as `_states`, and that graph has the ORIGINAL sprite
			// numbers baked into every frame. Copying it would hand the shifted type
			// a stale WL6 state machine, so enemies would keep rendering WL6 frames
			// (guard stand 50 instead of 54) — which, with eight rotations, reads as
			// a 180-degree error: the actor shows its back while facing you.
			for (var f in t) if (t.hasOwnProperty(f) && f.charAt(0) !== '_') o[f] = t[f];
			['S', 'W', 'PAIN', 'PAIN2', 'DEAD'].forEach(function (fld) {
				if (typeof o[fld] === 'number') o[fld] = o[fld] + n;
			});
			o.SHOOT = shiftRows(o.SHOOT, n);
			o.DIE = shiftRows(o.DIE, n);
			o.JUMP = shiftRows(o.JUMP, n);
			out[k] = o;
		}
		return out;
	}
	function clearBossCache(tbl) { if (tbl) for (var k in tbl) if (tbl[k]) delete tbl[k]._cfg; }

	// The enemy sight/fire cues and the death-scream pool are digi indices baked at
	// load from the WL6 map, so they must be re-resolved against the active map when
	// the dataset changes (sound.js has already swapped DIGI by the time this runs).
	// The logical names below reproduce the WL6 values exactly, so WL6 is unchanged.
	function applySounds() {
		var T = TYPES;
		if (T.guard) { T.guard.sight = DIGI.HALT; T.guard.fire = DIGI.NAZIFIRE; }
		if (T.officer) { T.officer.sight = DIGI.SPION; T.officer.fire = DIGI.NAZIFIRE; }
		if (T.ss) { T.ss.sight = DIGI.SCHUTZ; T.ss.fire = DIGI.SSFIRE; }
		if (T.mutant) { T.mutant.fire = DIGI.NAZIFIRE; }
		if (T.dog) { T.dog.sight = DIGI.DOGBARK; }
		GUARD_SCREAMS = [DIGI.DEATH1, DIGI.DEATH2, DIGI.DEATH3, DIGI.DEATH4,
			DIGI.DEATH5, DIGI.DEATH7, DIGI.DEATH8, DIGI.DEATH9];
	}

	if (root.WolfVariant) {
		root.WolfVariant.onUse(function (v) {
			TYPES = (v && v.spriteShift) ? shiftTypes(TYPES_WL6, v.spriteShift) : TYPES_WL6;
			BOSS = (v && v.boss) ? v.boss : BOSS_WL6;
			clearBossCache(BOSS_WL6);
			clearBossCache(v && v.boss);
			bjStates._s = null;   // BJ frames are dataset-relative too
			setProj(v && v.proj);
			applySounds();
		});
	}

	function bossType(kind) {
		var b = BOSS[kind] || BOSS.hans || BOSS.trans;
		if (b._cfg) return b._cfg;                 // cached: the state graph is shared
		var die = [];
		for (var i = 0; i < b.dieN; i++) die.push([b.DIE1 + i, 15, i === 0 ? 1 : 0]);
		b._cfg = {
			kind: kind,
			W: b.W,
			// No SHOOT and no SHOOT1 means the actor has no ranged attack at all
			// (the Spectre), so it must not get a shoot state built for it.
			SHOOT: b.SHOOT || (b.SHOOT1 != null ? [[b.SHOOT1, 30, 1]] : null),
			DIE: die,
			DEAD: b.DEAD,
			patrol: spd(512), chase: spd(b.chase || 1536),
			sight: b.sight, fire: DIGI.BOSSFIRE, death: b.death,
			hp: b.hp, pts: b.pts, boss: true, betterShot: true,
			closeDmg: b.closeDmg || 0,        // Ubermutant's point-blank maul
			runAway: !!b.runAway,             // Barnacle Wilhelm backs off up close
			relaunch: b.relaunch || 0,        // Angel: shots before it needs a breather
			TIRED: b.TIRED || null,           // Angel's tired frames
			tiredFx: b.tiredFx != null ? b.tiredFx : -1,   // AdLib cue during the breather
			dormant: !!b.dormant,             // Spectre goes dormant instead of dying
			contactDmg: b.contactDmg || 0,    // Spectre drains health on contact
			dropsKey: b.end === 'key',
			victory: b.end === 'victory',
			morphTo: b.end === 'morph' ? b.morphTo : null
		};
		return b._cfg;
	}

	// --- Build a per-type state graph -------------------------------------
	// State: {rot, spr, tics, think, action, next}. Walk states rotate (sprite =
	// spr + rotationframe); attack/pain/die states are single-frame.
	// Action names that are state actions in their own right rather than the name
	// of a projectile to throw.
	var PLAIN_ACTIONS = { shoot: 1, attack0: 1, relaunch: 1, tired: 1, bite: 1, scream: 1 };

	// The four Wolfenstein ghosts (Blinky, Pinky, Clyde, Inky) on the secret floor.
	// SpawnGhosts gives them dog speed, an east facing and FL_AMBUSH, and crucially
	// no FL_SHOOTABLE — they cannot be killed. They have two non-rotating frames and
	// no attack of their own: MoveObj drains health while they are touching you,
	// the same mechanic the Spectre uses.
	var GHOST_CACHE = {};
	function ghostType(base) {
		if (GHOST_CACHE[base]) return GHOST_CACHE[base];
		GHOST_CACHE[base] = {
			kind: 'ghost', ghost: true, W: base,
			patrol: spd(1500), chase: spd(1500),   // SPDDOG
			contactDmg: 2,                          // TakeDamage(tics*2) on contact
			sight: -1, fire: -1, pts: 0, hp: [1, 1, 1, 1]
		};
		return GHOST_CACHE[base];
	}

	function buildStates(cfg) {
		function st(rot, spr, tics, think, action) {
			return { rot: rot, spr: spr, tics: tics, think: think, action: action, next: null };
		}
		var S = {};
		var chaseThink = cfg.dog ? 'dogchase' : 'chase';

		if (cfg.ghost) {
			// Two frames, cycling, chasing forever. No stand, no attack, no death.
			var g1 = st(false, cfg.W, 10, chaseThink, null);
			var g2 = st(false, cfg.W + 1, 10, chaseThink, null);
			g1.next = g2; g2.next = g1;
			S.chase1 = g1; S.stand = g1; S.path1 = g1;
			return S;
		}

		if (cfg.boss) {
			// Bosses: 4 non-rotating walk frames cycling, generic ranged shoot.
			S.stand = st(false, cfg.W, 0, 'stand', null);
			var w = [];
			for (var i = 0; i < 4; i++) w.push(st(false, cfg.W + i, 10, chaseThink, null));
			for (i = 0; i < 4; i++) w[i].next = w[(i + 1) % 4];
			S.chase1 = w[0];
			S.path1 = w[0];
		} else {
			S.stand = st(true, cfg.S, 0, 'stand', null);
			// patrol walk cycle
			var p1 = st(true, cfg.W, 20, 'path', null), p1s = st(true, cfg.W, 5, null, null);
			var p2 = st(true, cfg.W + 8, 15, 'path', null);
			var p3 = st(true, cfg.W + 16, 20, 'path', null), p3s = st(true, cfg.W + 16, 5, null, null);
			var p4 = st(true, cfg.W + 24, 15, 'path', null);
			p1.next = p1s; p1s.next = p2; p2.next = p3; p3.next = p3s; p3s.next = p4; p4.next = p1;
			S.path1 = p1;
			// chase walk cycle
			var c1 = st(true, cfg.W, 10, chaseThink, null), c1s = st(true, cfg.W, 3, null, null);
			var c2 = st(true, cfg.W + 8, 8, chaseThink, null);
			var c3 = st(true, cfg.W + 16, 10, chaseThink, null), c3s = st(true, cfg.W + 16, 3, null, null);
			var c4 = st(true, cfg.W + 24, 8, chaseThink, null);
			c1.next = c1s; c1s.next = c2; c2.next = c3; c3.next = c3s; c3s.next = c4; c4.next = c1;
			S.chase1 = c1;
		}

		// pain (not for dogs — they have 1 hp)
		if (cfg.PAIN != null) {
			S.pain = st(false, cfg.PAIN, 10, null, null);
			S.pain1 = st(false, cfg.PAIN2, 10, null, null);
			S.pain.next = S.chase1; S.pain1.next = S.chase1;
		}

		// shoot / jump attack sequence
		if (cfg.SHOOT) {
			var prev = null, first = null;
			for (var k = 0; k < cfg.SHOOT.length; k++) {
				var f = cfg.SHOOT[k];
				// f[2]: 0 = nothing, 1 = fire bullets (T_Shoot), a plain action name,
				// or a projectile to throw ('needle', 'rocket', 'hrocket:-4', ...).
				var act = null;
				if (f[2] === 1) act = 'shoot';
				else if (f[2]) act = PLAIN_ACTIONS[f[2]] ? f[2] : 'throw:' + f[2];
				var s = st(false, f[0], f[1], null, act);
				if (prev) prev.next = s; else first = s;
				prev = s;
			}
			prev.next = S.chase1; S.shoot1 = first;
			// A_StartAttack / A_Relaunch: the Angel of Death does not fall back to
			// chasing after one spark. It loops on its launch frame, and the
			// 'relaunch' action decides each time whether to throw again, break off,
			// or — after `relaunch` throws — drop into the tired state. So the tail
			// of the sequence points back at the launch frame, not at the chase.
			if (cfg.relaunch && S.shoot1 && S.shoot1.next) prev.next = S.shoot1.next;
		}
		// Angel's breather: a couple of slow frames, then back to the chase.
		if (cfg.TIRED && cfg.TIRED.length) {
			var tA = st(false, cfg.TIRED[0], 40, null, 'tired');
			var tB = st(false, cfg.TIRED[1] != null ? cfg.TIRED[1] : cfg.TIRED[0], 40, null, null);
			var tC = st(false, cfg.TIRED[0], 40, null, 'tired');
			var tD = st(false, cfg.TIRED[1] != null ? cfg.TIRED[1] : cfg.TIRED[0], 40, null, null);
			tA.next = tB; tB.next = tC; tC.next = tD; tD.next = S.chase1;
			S.tired = tA;
		}
		if (cfg.JUMP) {
			var jprev = null, jfirst = null;
			for (var j = 0; j < cfg.JUMP.length; j++) {
				var jf = cfg.JUMP[j];
				var js = st(false, jf[0], jf[1], null, jf[2] ? 'bite' : null);
				if (jprev) jprev.next = js; else jfirst = js;
				jprev = js;
			}
			jprev.next = S.chase1; S.jump1 = jfirst;
		}

		// die
		var dprev = null, dfirst = null;
		for (var d = 0; d < cfg.DIE.length; d++) {
			var df = cfg.DIE[d];
			var ds = st(false, df[0], df[1], null, df[2] ? 'scream' : null);
			if (dprev) dprev.next = ds; else dfirst = ds;
			dprev = ds;
		}
		// The floor-ending bosses run A_StartDeathCam on their LAST death frame, not
		// the moment their hitpoints hit zero — so the death animation plays out first
		// and the intermission doesn't slide in while the boss is still on his feet.
		// A dormant actor (the Spectre) doesn't rest in the dead state — it lingers
		// on the last fade frame and A_Dormant brings it back once you have moved on.
		var dead = st(false, cfg.DEAD,
			cfg.victory ? 20 : (cfg.dormant ? 40 : 0), null,
			cfg.victory ? 'victory' : (cfg.dormant ? 'dormant' : null));
		dead.next = dead;
		dprev.next = dead; S.die1 = dfirst; S.dead = dead;
		return S;
	}

	// Cache built state graphs per config object.
	function statesFor(cfg) {
		if (!cfg._states) cfg._states = buildStates(cfg);
		return cfg._states;
	}

	// ===================================================================
	// WolfAI: owns the actor list, occupancy grid, and combat.
	// ===================================================================
	function WolfAI(env) {
		this.env = env;          // see header of game.js integration
		this.actors = [];
		this.occ = new Map();    // tileKey -> actor (blocking)
		this.tics = 0;
		this.noise = { t: 0 };             // madenoise: seconds left on the last gunshot
	}

	WolfAI.prototype.reset = function () { this.actors = []; this.occ.clear(); this.noise.t = 0; };

	WolfAI.prototype._key = function (tx, ty) { return ty * this.env.width + tx; };
	WolfAI.prototype.occAt = function (tx, ty) { return this.occ.get(this._key(tx, ty)) || null; };

	// Build an actor from a spawn descriptor. Returns null for non-actors.
	WolfAI.prototype.spawn = function (spawn, x, y, difficulty) {
		var cfg;
		if (spawn.type === 'boss') cfg = bossType(spawn.boss);
		else if (spawn.type === 'ghost') cfg = ghostType(spawn.base);
		else if (TYPES[spawn.type]) cfg = TYPES[spawn.type];
		else return null; // corpses are decoration, not actors
		var S = statesFor(cfg);
		var a = {
			cfg: cfg, cls: spawn.type,
			kind: cfg.kind || spawn.type,     // for save/load of runtime-spawned actors
			diff: difficulty | 0,             // the morph needs it to pick Adolf's hitpoints
			x: x, y: y, tilex: x | 0, tiley: y | 0,
			dir: spawn.rotate ? spawn.dirType : NODIR,
			distance: 0, speed: cfg.patrol,
			hp: cfg.hp[difficulty] | 0,
			temp2: 0, ticcount: 0,
			state: spawn.patrol ? S.path1 : S.stand,
			flags: { attackmode: false, ambush: false, shootable: true, visible: false, active: false, hidden: false, dead: false },
			sprite: 0,
			S: S
		};
		// Derive the first frame from the state we actually start in. (Reading it
		// from cfg.S instead used to yield NaN for any type without stand frames.)
		a.sprite = a.state.rot ? a.state.spr + (spawn.rotate ? spawn.dirType : 0) : a.state.spr;
		if (cfg.ghost) {
			// SpawnGhosts: east-facing, ambush, and NOT shootable — the ghosts are
			// invulnerable, and they are already chasing the moment the floor loads.
			a.dir = 0;
			a.flags.shootable = false;
			a.flags.ambush = true;
			a.flags.attackmode = true;
			a.flags.active = true;
			a.speed = cfg.chase;
			a.state = S.chase1;
			a.sprite = a.state.spr;
		}
		if (a.state.tics) a.ticcount = 1 + (this.env.rnd() % a.state.tics);
		this.occ.set(this._key(a.tilex, a.tiley), a);
		this.actors.push(a);
		return a;
	};

	// --- Line of sight (CheckLine): fine DDA through the tile grid --------
	WolfAI.prototype.checkLine = function (ax, ay, bx, by) {
		var env = this.env;
		var dx = bx - ax, dy = by - ay;
		var dist = Math.hypot(dx, dy);
		if (dist < 0.001) return true;
		var steps = Math.ceil(dist / 0.04);
		var sx = dx / steps, sy = dy / steps;
		var x = ax, y = ay, ptx = bx | 0, pty = by | 0;
		for (var i = 0; i < steps; i++) {
			x += sx; y += sy;
			var tx = x | 0, ty = y | 0;
			if (tx === ptx && ty === pty) return true;
			if (env.isWall(tx, ty)) return false;
			var dr = env.doorInfo(tx, ty);
			if (dr && dr.open < 0.5) return false; // door blocks unless ~half open
		}
		return true;
	};

	// --- Sighting ---------------------------------------------------------
	WolfAI.prototype.sightPlayer = function (a) {
		var env = this.env;
		if (a.flags.attackmode) return false;
		if (a.temp2) {
			a.temp2 -= this.tics;
			if (a.temp2 > 0) return false;
			a.temp2 = 0;
		} else {
			// The area gate, straight from SightPlayer: an actor whose room is not
			// currently connected to the player's — through doors that are anything but
			// fully shut — neither hears him nor sees him, however close he is. This is
			// the whole of Wolfenstein's "alerting" model; there is no distance term and
			// no hand-rolled sound propagation anywhere in the original.
			if (env.areaByPlayer && !env.areaByPlayer(env.areaAt(a.tilex, a.tiley))) return false;

			var los = this.checkLine(a.x, a.y, env.player.x, env.player.y);
			if (a.flags.ambush) { if (!los) return false; a.flags.ambush = false; }
			else if (this.noise.t <= 0 && !los) return false;
			// reaction delay (tics), by class
			var r = env.rnd();
			switch (a.cls) {
				case 'guard': a.temp2 = 1 + (r >> 2); break;
				case 'officer': a.temp2 = 2; break;
				case 'mutant': case 'ss': a.temp2 = 1 + ((r / 6) | 0); break;
				case 'dog': a.temp2 = 1 + ((r / 8) | 0); break;
				default: a.temp2 = 1; break;
			}
			return false;
		}
		this.firstSighting(a);
		return true;
	};

	WolfAI.prototype.firstSighting = function (a) {
		var cfg = a.cfg;
		if (cfg.sight != null && cfg.sight >= 0) this.playAt(cfg.sight, a);
		a.state = a.S.chase1;
		a.ticcount = a.state.tics || 0;
		a.speed = cfg.chase;
		a.flags.attackmode = true;
		a.flags.active = true;
		a.dir = NODIR;
	};

	// --- Movement: TryWalk / SelectChaseDir / MoveObj ---------------------
	// Can the actor step into tile (tx,ty)? For diagonals, both flanking cells
	// must also be clear. Returns 'ok', 'door' (openable), or false.
	WolfAI.prototype._cell = function (a, tx, ty, strict) {
		var env = this.env;
		if (tx < 0 || ty < 0 || tx >= env.width || ty >= env.height) return false;
		if (env.isWall(tx, ty)) return false;
		var dr = env.doorInfo(tx, ty);
		if (dr) {
			if (dr.locked) return false;   // locked to the player -> impassable to actors
			if (dr.open >= 0.85) return true; // open enough to walk straight through
			if (strict) return false;      // diagonals can't pass doors
			if (a.cfg.dog) return false;   // dogs can't open doors
			return dr;                     // openable door: caller opens and waits
		}
		var o = this.occAt(tx, ty);
		if (o && o.flags.shootable && o !== a) return false;
		if (env.blocked && env.blocked(tx, ty)) return false; // solid decoration
		return true;
	};

	WolfAI.prototype.tryWalk = function (a) {
		if (a.dir === NODIR) return false;
		var v = DIRVEC[a.dir];
		var nx = a.tilex + v[0], ny = a.tiley + v[1];
		var diag = v[0] !== 0 && v[1] !== 0;
		if (diag) {
			if (this._cell(a, nx, ny, true) !== true) return false;
			if (this._cell(a, a.tilex + v[0], a.tiley, true) !== true) return false;
			if (this._cell(a, a.tilex, a.tiley + v[1], true) !== true) return false;
		} else {
			var c = this._cell(a, nx, ny, false);
			if (c === false) return false;
			if (c !== true) { // openable door: open it and wait
				this.env.openDoor(c.key);
				a.waitDoor = c.key; a.distance = -1;
				return true;
			}
		}
		a.tilex = nx; a.tiley = ny; a.distance = 1;
		return true;
	};

	// SelectRunDir: the mirror image of SelectChaseDir — head AWAY from the player.
	// Barnacle Wilhelm backs off once you get within four tiles (T_Will), which is
	// what makes him a hit-and-run fight rather than a straight brawl.
	WolfAI.prototype.selectRunDir = function (a) {
		var p = this.env.player;
		var dx = (p.x | 0) - a.tilex, dy = (p.y | 0) - a.tiley;
		var d1 = NODIR, d2 = NODIR;
		if (dx <= 0) d1 = 0; else d1 = 4;                 // run east if you're west
		if (dy <= 0) d2 = 6; else d2 = 2;                 // run south if you're north
		if (Math.abs(dy) > Math.abs(dx)) { var t = d1; d1 = d2; d2 = t; }
		if (d1 !== NODIR) { a.dir = d1; if (this.tryWalk(a)) return; }
		if (d2 !== NODIR) { a.dir = d2; if (this.tryWalk(a)) return; }
		if (this.env.rnd() > 128) {
			for (var td = 2; td <= 4; td++) { a.dir = td; if (this.tryWalk(a)) return; }
		} else {
			for (var td2 = 4; td2 >= 2; td2--) { a.dir = td2; if (this.tryWalk(a)) return; }
		}
		a.dir = NODIR;
	};

	WolfAI.prototype.selectChaseDir = function (a) {
		var p = this.env.player;
		var olddir = a.dir, turnaround = OPPOSITE[olddir];
		var dx = (p.x | 0) - a.tilex, dy = (p.y | 0) - a.tiley;
		var d1 = NODIR, d2 = NODIR;
		if (dx > 0) d1 = 0; else if (dx < 0) d1 = 4;      // east / west
		if (dy > 0) d2 = 6; else if (dy < 0) d2 = 2;      // south / north
		if (Math.abs(dy) > Math.abs(dx)) { var t = d1; d1 = d2; d2 = t; }
		if (d1 === turnaround) d1 = NODIR;
		if (d2 === turnaround) d2 = NODIR;
		if (d1 !== NODIR) { a.dir = d1; if (this.tryWalk(a)) return; }
		if (d2 !== NODIR) { a.dir = d2; if (this.tryWalk(a)) return; }
		if (olddir !== NODIR) { a.dir = olddir; if (this.tryWalk(a)) return; }
		// search (matches the original's north..west scan quirk)
		if (this.env.rnd() > 128) {
			for (var td = 2; td <= 4; td++) { if (td !== turnaround) { a.dir = td; if (this.tryWalk(a)) return; } }
		} else {
			for (var td2 = 4; td2 >= 2; td2--) { if (td2 !== turnaround) { a.dir = td2; if (this.tryWalk(a)) return; } }
		}
		if (turnaround !== NODIR) { a.dir = turnaround; if (this.tryWalk(a)) return; }
		a.dir = NODIR;
	};

	// Straight patrol: keep going; on block, pick any open cardinal (no arrows).
	// Patrol routing, as SelectPathDir does it: the map's turn-arrow tiles
	// (plane1 codes 90..97 = ICONARROWS, one per direction) script the route —
	// standing on one sets the actor's direction. Otherwise it keeps walking
	// straight; if the next step is blocked it stops (dir = nodir) until it
	// sights the player.
	WolfAI.prototype.selectPathDir = function (a) {
		if (this.env.arrowAt) {
			var d = this.env.arrowAt(a.tilex, a.tiley);
			if (d >= 0) a.dir = d;
		}
		if (!this.tryWalk(a)) a.dir = NODIR;
	};

	// Advance along dir; block against the player's personal space. Returns
	// false if blocked by the player (so the caller stops).
	WolfAI.prototype.moveObj = function (a, move) {
		var v = DIRVEC[a.dir];
		a.x += v[0] * move; a.y += v[1] * move;
		var p = this.env.player;
		if (!a.flags.hidden &&
			Math.abs(a.x - p.x) <= MINACTORDIST && Math.abs(a.y - p.y) <= MINACTORDIST) {
			// MoveObj: the Spectre has no ranged attack — it hurts you by walking
			// into you, draining health for as long as it is on top of you, and
			// then backs off out of your personal space.
			if (a.cfg && a.cfg.contactDmg) this.env.hurtPlayer(Math.max(1, (this.tics * a.cfg.contactDmg) | 0), a);
			a.x -= v[0] * move; a.y -= v[1] * move; // undo
			return false;
		}
		a.distance -= move;
		return true;
	};

	// --- Think functions --------------------------------------------------
	WolfAI.prototype.think = function (a, key) {
		switch (key) {
			case 'stand': this.sightPlayer(a); break;
			case 'path': this.tPath(a); break;
			case 'chase': this.tChase(a, false); break;
			case 'dogchase': this.tChase(a, true); break;
			case 'bjrun': this.tBJRun(a); break;
			case 'bjjump': this.tBJJump(a); break;
		}
	};
	WolfAI.prototype.action = function (a, key) {
		if (key && key.indexOf('throw:') === 0) {
			// "throw:name" or "throw:name:±deg" — the offset fans the Death Knight's
			// rockets. T_Launch also runs T_Shoot for him, so a projectile flagged
			// withShot fires bullets on the same frame.
			var parts = key.slice(6).split(':');
			var pcfg = PROJ[parts[0]];
			if (pcfg && pcfg.withShot) this.tShoot(a);
			this.throwProjectile(a, parts[0], parts[1] ? parseFloat(parts[1]) : 0);
			return;
		}
		switch (key) {
			case 'shoot': this.tShoot(a); break;
			case 'attack0': a.temp1 = 0; break;         // A_StartAttack
			case 'relaunch': {
				// A_Relaunch: count the throws. Three and it needs a breather;
				// otherwise a coin flip decides between breaking off and throwing
				// again (falling through keeps it on the launch frame).
				a.temp1 = (a.temp1 || 0) + 1;
				if (a.cfg.relaunch && a.temp1 >= a.cfg.relaunch && a.S.tired) {
					a.temp1 = 0;
					a.jumpTo = a.S.tired; a.jumpTics = a.S.tired.tics;
				} else if (this.env.rnd() & 1) {
					a.jumpTo = a.S.chase1; a.jumpTics = a.S.chase1.tics;
				}
				break;
			}
			case 'dormant': {
				// A_Dormant: stay down until the player has stepped away and the tile
				// is free, then get back up with full hitpoints.
				var pp = this.env.player;
				if ((Math.abs(pp.x - a.x) <= MINACTORDIST && Math.abs(pp.y - a.y) <= MINACTORDIST) ||
					this.occAt(a.tilex, a.tiley)) {
					a.jumpTo = a.state; a.jumpTics = a.state.tics;   // still blocked, wait
					break;
				}
				a.flags.dead = false;
				a.flags.shootable = true;
				a.flags.attackmode = false;
				a.flags.active = false;
				a.hp = a.cfg.hp[a.diff] | 0;
				a.dir = NODIR;
				this.occ.set(this._key(a.tilex, a.tiley), a);
				a.jumpTo = a.S.stand; a.jumpTics = a.S.stand.tics;
				break;
			}
			case 'tired':
				if (a.cfg.tiredFx != null && a.cfg.tiredFx >= 0 && this.env.fx) this.env.fx(a.cfg.tiredFx);
				break;
			case 'bite': this.tBite(a); break;
			case 'scream': this.deathScream(a); break;
			case 'bjyell': this.playAt(DIGI.YEAH, a); break;
			case 'bjdone':
				if (!a.victoryFired) { a.victoryFired = true; this.env.onVictory && this.env.onVictory(); }
				break;
			case 'victory':
				// A_StartDeathCam runs at the END of the death animation, and it runs
				// TWICE. The first time it swings the camera round and makes him die
				// again, for the camera ("LET'S SEE THAT AGAIN!"). Only when that replay
				// finishes does it set ex_victorious. Getting this wrong is why the
				// stats used to appear the moment he hit the floor.
				if (!a.replayed) {
					a.replayed = true;
					if (this.env.onDeathCam) this.env.onDeathCam(a);
					a.jumpTo = a.S.die1;                       // rewind: he falls again
					a.jumpTics = a.S.die1.tics + 100;          // after a beat on the freeze-frame
					return;
				}
				// The dead state loops, so guard: the floor may only be won once.
				if (!a.victoryFired) { a.victoryFired = true; this.env.onVictory && this.env.onVictory(); }
				break;
		}
	};

	WolfAI.prototype.tPath = function (a) {
		if (this.sightPlayer(a)) return;
		if (a.dir === NODIR) { this.selectPathDir(a); if (a.dir === NODIR) return; }
		var move = a.speed * this._dt;
		var guard = 0;
		while (move > 0 && guard++ < 8) {
			if (a.distance < 0) { // waiting for a door to finish opening
				if (!this._doorReady(a)) return;
				this.tryWalk(a); if (a.distance < 0) return;
			}
			if (move < a.distance) { this.moveObj(a, move); break; }
			this._snap(a); move -= a.distance;
			this.selectPathDir(a); if (a.dir === NODIR) return;
		}
	};

	WolfAI.prototype.tChase = function (a, isDog) {
		var env = this.env, p = env.player;
		var dodge = false;
		if (!isDog && this.checkLine(a.x, a.y, p.x, p.y)) {
			a.flags.hidden = false;
			var dx = Math.abs(a.tilex - (p.x | 0)), dy = Math.abs(a.tiley - (p.y | 0));
			var dist = dx > dy ? dx : dy;
			var chance;
			var t16 = (this.tics * 16) | 0;
			if (dist) chance = (t16 / dist) | 0; else chance = 300;
			if (dist === 1 && Math.abs(a.x - p.x) < 1.25 && Math.abs(a.y - p.y) < 1.25) chance = 300;
			if (a.S.shoot1 && env.rnd() < chance) { a.state = a.S.shoot1; a.ticcount = a.state.tics; return; }
			dodge = true;
		} else if (!isDog) {
			a.flags.hidden = true;
		}

		if (a.dir === NODIR) { this.selectChaseDir(a); if (a.dir === NODIR) return; }
		var move = a.speed * this._dt;
		var guard = 0;
		while (move > 0 && guard++ < 8) {
			if (a.distance < 0) {
				if (!this._doorReady(a)) return;
				this.tryWalk(a); if (a.distance < 0) return;
			}
			if (isDog) {
				// bite range check (T_DogChase)
				if (Math.abs(p.x - a.x) - move <= MINACTORDIST && Math.abs(p.y - a.y) - move <= MINACTORDIST) {
					a.state = a.S.jump1; a.ticcount = a.state.tics; return;
				}
			}
			if (move < a.distance) { if (!this.moveObj(a, move)) return; break; }
			this._snap(a); move -= a.distance;
			// T_Will: at close quarters Barnacle Wilhelm breaks off and runs instead
			// of closing in. Only bosses flagged runAway do this.
			if (a.cfg.runAway && dist < 4) this.selectRunDir(a);
			else this.selectChaseDir(a);
			if (a.dir === NODIR) return;
		}
	};

	WolfAI.prototype._snap = function (a) { a.x = a.tilex + 0.5; a.y = a.tiley + 0.5; };
	WolfAI.prototype._doorReady = function (a) {
		var dr = this.env.doorByKey(a.waitDoor);
		this.env.openDoor(a.waitDoor);
		return dr && dr.open >= 0.85;
	};

	WolfAI.prototype.tShoot = function (a) {
		var env = this.env, p = env.player;
		if (!this.checkLine(a.x, a.y, p.x, p.y)) { this.playAt(a.cfg.fire, a); return; }
		var dx = Math.abs(a.tilex - (p.x | 0)), dy = Math.abs(a.tiley - (p.y | 0));
		var dist = dx > dy ? dx : dy;
		if (a.cfg.betterShot) dist = (dist * 2 / 3) | 0;
		var vis = a.flags.visible;
		var hitchance;
		if (env.playerMoving()) hitchance = (vis ? 160 : 160) - dist * (vis ? 16 : 8);
		else hitchance = 256 - dist * (vis ? 16 : 8);
		if (env.rnd() < hitchance) {
			var dmg;
			var r = env.rnd();
			if (dist < 2) dmg = r >> 2; else if (dist < 4) dmg = r >> 3; else dmg = r >> 4;
			env.hurtPlayer(dmg, a);
		}
		if (a.cfg.fire != null && a.cfg.fire >= 0) this.playAt(a.cfg.fire, a);
		// T_UShoot: the Ubermutant's attack also mauls you if he is right on top of
		// you — an extra flat 10 on top of whatever the shot itself did.
		if (a.cfg.closeDmg) {
			var cdx = Math.abs(a.tilex - (p.x | 0)), cdy = Math.abs(a.tiley - (p.y | 0));
			if ((cdx > cdy ? cdx : cdy) <= 1) env.hurtPlayer(a.cfg.closeDmg, a);
		}
	};

	WolfAI.prototype.tBite = function (a) {
		var env = this.env, p = env.player;
		this.playAt(DIGI.DOGATTACK, a);
		if (Math.abs(p.x - a.x) - 1 <= 0.0 && Math.abs(p.y - a.y) - 1 <= 0.0) {
			if (env.rnd() < 180) env.hurtPlayer(env.rnd() >> 4, a);
		}
	};

	// The guard's pool, exactly as the source declares it: DEATHSCREAM1..5,7..9,
	// picked with US_RndT()%8. Note that DEATHSCREAM2 and 3 both map to chunk 13,
	// so that one really is twice as likely — the duplicate is not a typo.
	var GUARD_SCREAMS = [DIGI.DEATH1, DIGI.DEATH2, DIGI.DEATH3, DIGI.DEATH4,
		DIGI.DEATH5, DIGI.DEATH7, DIGI.DEATH8, DIGI.DEATH9];

	WolfAI.prototype.deathScream = function (a) {
		var d = DIGI;

		// Easter egg, straight from A_DeathScream: on the SECRET floor (mapon == 9)
		// every regular enemy has a 1-in-256 chance (!US_RndT()) of going out on
		// DEATHSCREAM6 instead of his usual cry. The source labels that sound, with no
		// further comment, "FART". Bosses are excluded — they keep their dignity.
		if (!a.cfg.boss && this.env.isSecretFloor && this.env.isSecretFloor() &&
			this.env.rnd() === 0) {
			this.playAt(d.FART, a);
			return;
		}

		if (a.cfg.death != null) { this.playAt(a.cfg.death, a); return; }  // bosses: one each
		var s;
		switch (a.cls) {
			case 'mutant': s = d.AHHG; break;
			case 'officer': s = d.NEINSOVAS; break;
			case 'ss': s = d.LEBEN; break;
			case 'dog': s = d.DOGDEATH; break;
			default: s = GUARD_SCREAMS[this.env.rnd() % 8]; break;
		}
		this.playAt(s, a);
	};

	// --- Damage from the player -------------------------------------------
	WolfAI.prototype.damageActor = function (a, damage) {
		if (!a.flags.shootable || a.flags.dead) return;   // corpses take no more hits
		if (!a.flags.attackmode) { damage <<= 1; this.firstSighting(a); }
		a.hp -= damage;
		if (a.hp <= 0) { this.killActor(a); return; }
		var S = a.S;
		if (S.pain) { a.state = (a.hp & 1) ? S.pain : S.pain1; a.ticcount = a.state.tics; }
	};

	WolfAI.prototype.killActor = function (a) {
		if (a.flags.dead) return;                        // never die twice
		var dir0 = a.dir;                                // A_HitlerMorph inherits the facing,
		a.hp = 0;                                        // so grab it before death clears it
		a.flags.shootable = false;
		a.flags.dead = true;
		a.dir = NODIR;
		this.occ.delete(this._key(a.tilex, a.tiley));
		a.state = a.S.die1; a.ticcount = a.state.tics || 0;
		// FL_BONUS: the Spectre only ever pays out once, however often it is put
		// down, and it is only counted as a kill the first time.
		var firstKill = !a.bonusTaken;
		if (firstKill) { a.bonusTaken = true; this.env.addScore(a.cfg.pts); }
		else if (!a.cfg.dormant) this.env.addScore(a.cfg.pts);

		// Boss endings (see the BOSS table): Hans and Gretel drop the gold key you
		// need for the elevator; Schabbs, Giftmacher, Fat Face and the real Hitler end
		// the floor when they go down; Mecha Hitler doesn't end anything — Adolf steps
		// out of the wreck and the fight continues.
		if (a.cfg.dropsKey && this.env.dropKey) this.env.dropKey(a.tilex, a.tiley);
		if (a.cfg.morphTo) this.morph(a, a.cfg.morphTo, dir0);
		// NOTE: victory is NOT fired here. It hangs off the last death frame (see
		// buildStates), because A_StartDeathCam does too — otherwise the intermission
		// appears while the boss is still standing.

		if (firstKill || !a.cfg.dormant) this.env.onKill && this.env.onKill(a);
	};

	// A_HitlerMorph: replace a dying boss with his successor at the same spot. The new
	// actor inherits position and facing, is already hunting you, and gets his own
	// hitpoints and speed (Adolf runs at SPDPATROL*5 — faster than anything else).
	WolfAI.prototype.morph = function (a, kind, dir) {
		var cfg = bossType(kind);
		var S = statesFor(cfg);
		var n = {
			cfg: cfg, cls: 'boss', kind: kind, diff: a.diff,
			x: a.x, y: a.y, tilex: a.tilex, tiley: a.tiley,
			dir: (dir == null) ? a.dir : dir, distance: 0, speed: cfg.chase,
			hp: cfg.hp[a.diff] | 0,
			temp2: 0, ticcount: 0,
			state: S.chase1,
			flags: {
				attackmode: true, ambush: false, shootable: true,
				visible: false, active: true, hidden: false, dead: false
			},
			sprite: cfg.W,
			S: S,
			spawned: true                 // not in the map: must be re-created on load
		};
		n.ticcount = n.state.tics || 0;
		this.actors.push(n);
		this.occ.set(this._key(n.tilex, n.tiley), n);
		this.playAt(cfg.sight, n);
		if (this.env.onSpawn) this.env.onSpawn(n);   // the renderer needs to know about him
		return n;
	};

	// B.J. has no business in the occupancy grid and never turns to face you.
	WolfAI.prototype._doBJ = function (a) {
		if (a.ticcount === 0) {
			if (a.state.think) this.think(a, a.state.think);
		} else {
			a.ticcount -= this.tics;
			var guard = 0;
			while (a.ticcount <= 0 && guard++ < 32) {
				if (a.state.action) this.action(a, a.state.action);
				a.state = a.state.next;
				if (a.state.tics === 0) { a.ticcount = 0; break; }
				a.ticcount += a.state.tics;
			}
			if (a.ticcount > 0 && a.state.think) this.think(a, a.state.think);
		}
		a.sprite = a.state.spr;
	};

	// --- DoActor driver ---------------------------------------------------
	WolfAI.prototype.doActor = function (a) {
		var env = this.env;
		if (!a.flags.active && !a.flags.dead) {
			// dormant until it can see the player or hears gunfire
			if (this.checkLine(a.x, a.y, env.player.x, env.player.y) || this.noise.t > 0) a.flags.active = true;
		}
		// Vacate our own mark before thinking (we may step to another tile).
		var oldKey = this._key(a.tilex, a.tiley);
		if (this.occ.get(oldKey) === a) this.occ.delete(oldKey);

		if (a.ticcount === 0) {
			if (a.state.think) this.think(a, a.state.think);
		} else {
			a.ticcount -= this.tics;
			var guard = 0;
			while (a.ticcount <= 0 && guard++ < 32) {
				if (a.state.action) this.action(a, a.state.action);
				// An action may redirect the state (the death cam rewinds the boss to the
				// start of his death). Without this the very next line would overwrite it.
				if (a.jumpTo) {
					a.state = a.jumpTo; a.ticcount = a.jumpTics; a.jumpTo = null;
					break;
				}
				a.state = a.state.next;
				if (a.state.tics === 0) { a.ticcount = 0; break; }
				a.ticcount += a.state.tics;
			}
			if (a.ticcount > 0 && a.state.think) this.think(a, a.state.think);
		}

		// render sprite for this frame
		if (a.state.rot) a.sprite = a.state.spr + E.rotFrame(this._facing(a), a.x, a.y, env.player.x, env.player.y);
		else a.sprite = a.state.spr;

		// Re-mark the tile. A corpse claims it too (the original sets FL_NONMARK on
		// death and DoActor re-marks it whenever the tile is free) — it never blocks
		// walking, because every walk test filters on `shootable`, but it does keep a
		// door from closing on it.
		var k = this._key(a.tilex, a.tiley);
		if (a.flags.dead) {
			if (!this.occ.has(k)) this.occ.set(k, a);      // never overwrite a living actor
		} else if (a.flags.shootable) {
			this.occ.set(k, a);
		}
	};

	// Facing dirtype for rendering: use movement dir, or spawn facing when idle.
	WolfAI.prototype._facing = function (a) { return a.dir === NODIR ? (a._idleDir || 0) : a.dir; };

	WolfAI.prototype.update = function (dt) {
		this._dt = dt;
		this.tics = dt * TICS;
		if (this.noise.t > 0) this.noise.t = Math.max(0, this.noise.t - dt);

		var i, a, spent = false;
		for (i = 0; i < this.actors.length; i++) {
			a = this.actors[i];
			if (a.proj) { this._doProjectile(a); if (a.remove) spent = true; }
			else if (a.bj) this._doBJ(a);
			else this.doActor(a);
		}

		// Projectiles are the only actors that ever leave: sweep the spent ones out of
		// both the actor list and the renderer, or a long boss fight would pile them up
		// forever.
		if (spent) {
			var keep = [];
			for (i = 0; i < this.actors.length; i++) {
				a = this.actors[i];
				if (a.remove) { if (this.env.onRemove) this.env.onRemove(a); }
				else keep.push(a);
			}
			this.actors = keep;
		}
	};

	// --- Player weapons (GunAttack / KnifeAttack) -------------------------
	// Finds the closest shootable actor within the aim cone with a clear line,
	// then applies the original distance-based damage. `kind` is 'knife', 'gun'.
	WolfAI.prototype.playerFire = function (kind) {
		var env = this.env, p = env.player;
		// madenoise: a plain flag in the original. WHERE it is heard is decided entirely
		// by the area system, not by any distance or flood of our own.
		if (kind !== 'knife') this.noise.t = 0.5;
		// pick target: smallest angle to player's facing, must have LOS
		var best = null, bestDot = Math.cos(0.09), bestDist = Infinity;
		for (var i = 0; i < this.actors.length; i++) {
			var a = this.actors[i];
			if (!a.flags.shootable) continue;
			var dx = a.x - p.x, dy = a.y - p.y, dd = Math.hypot(dx, dy);
			if (dd < 0.001) { best = a; bestDist = 0; break; }
			var dot = (dx / dd) * p.dirX + (dy / dd) * p.dirY;
			if (dot < bestDot) continue;                 // outside aim cone
			if (!this.checkLine(p.x, p.y, a.x, a.y)) continue;
			if (dd < bestDist) { bestDist = dd; best = a; }
		}
		if (!best) return false;
		if (kind === 'knife' && bestDist > KNIFE_REACH) return false;
		var dx2 = Math.abs(best.tilex - (p.x | 0)), dy2 = Math.abs(best.tiley - (p.y | 0));
		var dist = dx2 > dy2 ? dx2 : dy2, r = env.rnd(), dmg;
		if (kind === 'knife') dmg = r >> 4;
		else if (dist < 2) dmg = (r / 4) | 0;
		else if (dist < 4) dmg = (r / 6) | 0;
		else { if (((env.rnd() / 12) | 0) < dist) return true; dmg = (r / 6) | 0; } // may miss at range
		this.damageActor(best, dmg);
		return true;
	};

	// ---- B.J.'s victory run ---------------------------------------------------
	// SpawnBJVictory: he appears where you are standing, heads north, and runs six
	// tiles — following the map's turn arrows exactly as a patrolling guard would —
	// before jumping.
	WolfAI.prototype.spawnBJ = function (x, y) {
		var S = bjStates();
		var a = {
			cls: 'bj', bj: true, cfg: { DEAD: BJ.W },
			x: x, y: y, tilex: x | 0, tiley: y | 0,
			dir: 2,                                   // north
			distance: 0, left: BJ.tiles,
			state: S.run1, ticcount: S.run1.tics,
			sprite: BJ.W,
			flags: { dead: false, shootable: false, visible: false, attackmode: false, active: true, ambush: false, hidden: false },
			S: S, remove: false
		};
		this.actors.push(a);
		if (this.env.onSpawn) this.env.onSpawn(a);
		return a;
	};

	WolfAI.prototype.tBJRun = function (a) {
		if (a.dir === NODIR) this.selectPathDir(a);
		if (a.dir === NODIR) { this._bjJump(a); return; }

		var move = BJ.run * this._dt, guard = 0;
		while (move > 0 && guard++ < 8) {
			if (a.distance <= 0) a.distance = 1;
			if (move < a.distance) {
				var v = DIRVEC[a.dir];
				a.x += v[0] * move; a.y += v[1] * move;
				a.tilex = a.x | 0; a.tiley = a.y | 0;
				a.distance -= move;
				break;
			}
			this._snap(a);
			move -= a.distance;
			a.distance = 0;
			this.selectPathDir(a);
			if (--a.left <= 0 || a.dir === NODIR) { this._bjJump(a); return; }
		}
	};

	WolfAI.prototype._bjJump = function (a) {
		a.state = a.S.jump1;
		a.ticcount = a.state.tics;
	};

	WolfAI.prototype.tBJJump = function (a) {
		if (a.dir === NODIR) return;
		var v = DIRVEC[a.dir], move = BJ.jump * this._dt;
		a.x += v[0] * move; a.y += v[1] * move;
		a.tilex = a.x | 0; a.tiley = a.y | 0;
	};

	// ---- Projectiles ---------------------------------------------------------
	// T_SchabbThrow / T_GiftThrow / T_FakeFire all do the same thing: aim at where the
	// player is *right now* and launch. The shot does not track you afterwards — it
	// flies straight, so sidestepping is a real defence.
	WolfAI.prototype.throwProjectile = function (from, kind, offsetDeg) {
		var cfg = PROJ[kind];
		if (!cfg) return null;
		var p = this.env.player;
		var ang = Math.atan2(p.y - from.y, p.x - from.x);
		// T_Launch fans the Death Knight's two rockets a few degrees either side of
		// your bearing, so they arrive as a spread rather than stacked on one line.
		if (offsetDeg) ang += offsetDeg * Math.PI / 180;

		var pr = {
			cls: 'proj', kind: kind, cfg: cfg, proj: true,
			x: from.x, y: from.y,
			tilex: from.x | 0, tiley: from.y | 0,
			vx: Math.cos(ang), vy: Math.sin(ang),
			frame: 0, frameT: 0,
			boomAt: -1,                       // >= 0 while the explosion plays out
			sprite: cfg.frames[0],
			flags: { dead: false, shootable: false, visible: false, attackmode: false, active: true, ambush: false, hidden: false },
			remove: false
		};
		this.actors.push(pr);
		if (cfg.launch != null && this.env.fx) this.env.fx(cfg.launch);
		if (this.env.onSpawn) this.env.onSpawn(pr);
		return pr;
	};

	// One frame of a projectile: fly, hit a wall, or hit the player.
	WolfAI.prototype._doProjectile = function (pr) {
		var cfg = pr.cfg, env = this.env, dt = this._dt;

		// An exploding rocket just plays out its animation where it stopped.
		if (pr.boomAt >= 0) {
			pr.frameT += dt * TICS;
			if (pr.frameT >= cfg.boomTics) {
				pr.frameT = 0;
				if (++pr.boomAt >= cfg.boom.length) { pr.remove = true; return; }
			}
			pr.sprite = cfg.boom[pr.boomAt];
			return;
		}

		// animate
		pr.frameT += dt * TICS;
		if (pr.frameT >= cfg.tics) {
			pr.frameT = 0;
			pr.frame = (pr.frame + 1) % cfg.frames.length;
		}

		var step = cfg.speed * dt;
		pr.x += pr.vx * step;
		pr.y += pr.vy * step;
		pr.tilex = pr.x | 0; pr.tiley = pr.y | 0;

		// A wall (or a shut door) stops it. ProjectileTryMove checks the corners of the
		// projectile's own little box, not just its centre.
		if (this._projBlocked(pr)) {
			if (cfg.boom) {
				pr.boomAt = 0; pr.frameT = 0;
				pr.sprite = cfg.boom[0];
				if (cfg.impact != null && env.fx) env.fx(cfg.impact);
			} else {
				pr.remove = true;
			}
			return;
		}

		// Close enough to the player? PROJECTILESIZE is 0.75 of a tile, per axis.
		var p = env.player;
		if (Math.abs(pr.x - p.x) < HIT_RADIUS && Math.abs(pr.y - p.y) < HIT_RADIUS) {
			env.hurtPlayer(cfg.dmg(env.rnd()), pr);
			pr.remove = true;
			return;
		}

		// The rocket sprite turns to face you as it flies.
		pr.sprite = cfg.rot
			? cfg.frames[0] + E.rotFrame(this._projDir(pr), pr.x, pr.y, p.x, p.y)
			: cfg.frames[pr.frame];
	};

	WolfAI.prototype._projBlocked = function (pr) {
		var env = this.env;
		for (var dy = -1; dy <= 1; dy += 2) {
			for (var dx = -1; dx <= 1; dx += 2) {
				var tx = (pr.x + dx * PROJ_HALF) | 0, ty = (pr.y + dy * PROJ_HALF) | 0;
				if (tx < 0 || ty < 0 || tx >= env.width || ty >= env.height) return true;
				if (env.isWall(tx, ty)) return true;
				var dr = env.doorInfo(tx, ty);
				if (dr && dr.open < 0.5) return true;
				if (env.blocked && env.blocked(tx, ty)) return true;
			}
		}
		return false;
	};

	// Which of the eight rotation frames the rocket shows: its heading, as a dirtype.
	WolfAI.prototype._projDir = function (pr) {
		var a = Math.atan2(-pr.vy, pr.vx);              // screen y grows downward
		var d = Math.round(a / (Math.PI / 4));
		return ((d % 8) + 8) % 8;
	};

	// Positional sound: attenuate by distance to the player.
	WolfAI.prototype.playAt = function (idx, a) {
		if (idx == null || idx < 0 || !this.env.sound) return;
		var p = this.env.player, dx = a.x - p.x, dy = a.y - p.y;
		var dist = Math.sqrt(dx * dx + dy * dy);
		var vol = Math.max(0.15, 1 - dist / 18); // audible out to ~18 tiles
		this.env.sound.play(idx, vol);
	};

	// Mark actors visible this frame (called by game after computing FOV).
	WolfAI.prototype.setVisible = function (a, v) { a.flags.visible = v; };

	// ---- Save / load -------------------------------------------------------
	// Actors are saved positionally: the spawn scan is deterministic, so index i
	// in this list is the same actor after a fresh startLevel() with the same
	// difficulty. Mid-animation frames (shoot/pain/die) are NOT preserved — an
	// actor resumes cleanly as dead, chasing, or as originally spawned.
	WolfAI.prototype.serialize = function () {
		var out = [];
		for (var i = 0; i < this.actors.length; i++) {
			var a = this.actors[i], f = a.flags;
			// Projectiles are transient and, crucially, they would shift every actor
			// index behind them — the save maps actors by position.
			if (a.proj || a.bj) continue;
			out.push({
				x: +a.x.toFixed(3), y: +a.y.toFixed(3), d: a.dir, hp: a.hp,
				dd: f.dead ? 1 : 0, am: f.attackmode ? 1 : 0,
				ac: f.active ? 1 : 0, ab: f.ambush ? 1 : 0,
				// Actors that were never in the map (Adolf, after the morph) must be
				// re-created on load — otherwise the finale becomes unwinnable again.
				sp: a.spawned ? a.kind : undefined
			});
		}
		return out;
	};

	WolfAI.prototype.restore = function (list) {
		if (!list) return;
		for (var i = 0; i < list.length; i++) {
			var s = list[i];
			var a = this.actors[i];
			if (!a) {
				if (!s.sp) continue;                       // nothing to rebuild from
				a = this._rebuildSpawned(s);               // re-create the morphed boss
				if (!a) continue;
			}
			var S = a.S;
			a.x = s.x; a.y = s.y;
			a.tilex = a.x | 0; a.tiley = a.y | 0;
			a.dir = (s.d == null) ? NODIR : s.d;
			a.hp = s.hp;
			a.distance = 0; a.temp2 = 0;
			a.flags.dead = !!s.dd;
			a.flags.attackmode = !!s.am;
			a.flags.active = !!s.ac;
			a.flags.ambush = !!s.ab;
			a.flags.visible = false;
			a.flags.hidden = false;
			a.flags.shootable = !s.dd;

			if (s.dd) {                       // corpse: final death frame
				a.state = S.dead; a.ticcount = 0; a.dir = NODIR;
				a.sprite = a.cfg.DEAD;
			} else if (s.am) {                // was hunting the player
				a.state = S.chase1; a.ticcount = a.state.tics || 0;
				a.speed = a.cfg.chase;
			}                                 // else: keep the freshly spawned stand/patrol state
		}
		this._rebuildOcc();
	};

	// Re-create an actor that only ever existed at runtime (currently: Adolf).
	WolfAI.prototype._rebuildSpawned = function (s) {
		var cfg = bossType(s.sp);
		if (!cfg) return null;
		var S = statesFor(cfg);
		var a = {
			cfg: cfg, cls: 'boss', kind: s.sp, diff: 0,
			x: s.x, y: s.y, tilex: s.x | 0, tiley: s.y | 0,
			dir: (s.d == null) ? NODIR : s.d,
			distance: 0, speed: cfg.chase, hp: s.hp,
			temp2: 0, ticcount: 0,
			state: S.chase1,
			flags: { attackmode: true, ambush: false, shootable: true, visible: false, active: true, hidden: false, dead: false },
			sprite: cfg.W, S: S, spawned: true
		};
		this.actors.push(a);
		if (this.env.onSpawn) this.env.onSpawn(a);
		return a;
	};

	// Occupancy grid must match the restored positions. Living actors are placed
	// first; a corpse then claims its tile only if nothing living is standing there
	// (FL_NONMARK), which is what lets a body hold a door open after a load.
	WolfAI.prototype._rebuildOcc = function () {
		this.occ.clear();
		var i, a;
		for (i = 0; i < this.actors.length; i++) {
			a = this.actors[i];
			if (!a.flags.dead && a.flags.shootable) this.occ.set(this._key(a.tilex, a.tiley), a);
		}
		for (i = 0; i < this.actors.length; i++) {
			a = this.actors[i];
			if (!a.flags.dead) continue;
			var k = this._key(a.tilex, a.tiley);
			if (!this.occ.has(k)) this.occ.set(k, a);
		}
	};

	root.WolfAI = WolfAI;
})(typeof window !== 'undefined' ? window : this);
