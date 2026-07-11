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
			W: 99, DEAD: 134,
			JUMP: [[135, 10, 0], [136, 10, 1], [137, 10, 0], [135, 10, 0], [99, 10, 0]],
			DIE: [[131, 15, 1], [132, 15, 0], [133, 15, 0]],
			patrol: spd(1500), chase: spd(3000), sight: DIGI.DOGBARK, fire: -1,
			hp: HP.dog, pts: 200, dog: true
		}
	};

	var BOSS = { // [W1, SHOOT1, DIE1, DEAD, sightSound]
		hans: [296, 300, 304, 303, DIGI.GUTENTAG], gretel: [385, 389, 393, 392, DIGI.GUTENTAG],
		gift: [360, 364, 366, 369, DIGI.GUTENTAG], fat: [396, 400, 404, 407, DIGI.GUTENTAG],
		schabbs: [307, 311, 313, 316, DIGI.SCHABBSHA], fake: [321, 325, 328, 333, DIGI.TOTHUND],
		mecha: [334, 338, 342, 341, DIGI.GUTENTAG]
	};
	function bossType(kind) {
		var b = BOSS[kind] || BOSS.hans;
		return {
			W: b[0], SHOOT: [[b[1], 30, 1]], DIE: [[b[2], 15, 1], [b[2] + 1, 15, 0], [b[2] + 2, 15, 0]],
			DEAD: b[3], patrol: spd(512), chase: spd(1536), sight: b[4], fire: DIGI.BOSSFIRE,
			hp: HP.boss, pts: 5000, boss: true, betterShot: true
		};
	}

	// --- Build a per-type state graph -------------------------------------
	// State: {rot, spr, tics, think, action, next}. Walk states rotate (sprite =
	// spr + rotationframe); attack/pain/die states are single-frame.
	function buildStates(cfg) {
		function st(rot, spr, tics, think, action) {
			return { rot: rot, spr: spr, tics: tics, think: think, action: action, next: null };
		}
		var S = {};
		var chaseThink = cfg.dog ? 'dogchase' : 'chase';

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
				var s = st(false, f[0], f[1], null, f[2] ? 'shoot' : null);
				if (prev) prev.next = s; else first = s;
				prev = s;
			}
			prev.next = S.chase1; S.shoot1 = first;
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
		var dead = st(false, cfg.DEAD, 0, null, null); dead.next = dead;
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
		this.noise = { t: 0, tiles: null }; // last gunfire: reachable tiles + seconds
	}

	WolfAI.prototype.reset = function () { this.actors = []; this.occ.clear(); this.noise.t = 0; this.noise.tiles = null; };

	// Flood-fill floor tiles reachable from (sx,sy) WITHOUT crossing any door,
	// adding them to `seen`. If `collect`, also return the open-door tiles bordering
	// this region (as a flat [x,y,x,y,...] list). Used to build the noise area.
	WolfAI.prototype._floodRoomFloor = function (sx, sy, seen, collect) {
		var env = this.env, W = env.width, H = env.height;
		var DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
		var q = [sx, sy], head = 0, doors = collect ? [] : null;
		while (head < q.length) {
			var cx = q[head++], cy = q[head++];
			for (var i = 0; i < 4; i++) {
				var nx = cx + DX[i], ny = cy + DY[i];
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				if (env.isWall(nx, ny)) continue;
				var dr = env.doorInfo(nx, ny);
				if (dr) { if (collect && dr.open >= 0.5) doors.push(nx, ny); continue; } // never cross a door here
				var k = ny * W + nx;
				if (seen.has(k)) continue;
				seen.add(k); q.push(nx, ny);
			}
		}
		return doors;
	};

	// Tiles that hear a shot from (sx,sy): the player's room plus every room ONE
	// open door away (closed doors and walls block; a second door is not crossed).
	// Mirrors the original's area connectivity, kept to a single hop.
	WolfAI.prototype._floodNoise = function (sx, sy) {
		var W = this.env.width;
		var seen = new Set([sy * W + sx]);
		var doors = this._floodRoomFloor(sx, sy, seen, true);   // current room + its open doors
		for (var i = 0; i < doors.length; i += 2) {
			var dx = doors[i], dy = doors[i + 1], dk = dy * W + dx;
			if (seen.has(dk)) continue;
			seen.add(dk);                                         // the doorway itself is heard
			this._floodRoomFloor(dx, dy, seen, false);            // the adjacent room only (no further doors)
		}
		return seen;
	};

	WolfAI.prototype.hearsNoise = function (a) {
		return this.noise.t > 0 && this.noise.tiles != null &&
			this.noise.tiles.has(a.tiley * this.env.width + a.tilex);
	};
	WolfAI.prototype._key = function (tx, ty) { return ty * this.env.width + tx; };
	WolfAI.prototype.occAt = function (tx, ty) { return this.occ.get(this._key(tx, ty)) || null; };

	// Build an actor from a spawn descriptor. Returns null for non-actors.
	WolfAI.prototype.spawn = function (spawn, x, y, difficulty) {
		var cfg;
		if (spawn.type === 'boss') cfg = bossType(spawn.boss);
		else if (TYPES[spawn.type]) cfg = TYPES[spawn.type];
		else return null; // corpse / ghost handled elsewhere
		var S = statesFor(cfg);
		var a = {
			cfg: cfg, cls: spawn.type,
			x: x, y: y, tilex: x | 0, tiley: y | 0,
			dir: spawn.rotate ? spawn.dirType : NODIR,
			distance: 0, speed: cfg.patrol,
			hp: cfg.hp[difficulty] | 0,
			temp2: 0, ticcount: 0,
			state: spawn.patrol ? S.path1 : S.stand,
			flags: { attackmode: false, ambush: false, shootable: true, visible: false, active: false, hidden: false, dead: false },
			sprite: cfg.boss ? cfg.W : (spawn.rotate ? cfg.S + spawn.dirType : cfg.W),
			S: S
		};
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
			var los = this.checkLine(a.x, a.y, env.player.x, env.player.y);
			if (a.flags.ambush) { if (!los) return false; a.flags.ambush = false; }
			else if (!this.hearsNoise(a) && !los) return false;
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
		}
	};
	WolfAI.prototype.action = function (a, key) {
		switch (key) {
			case 'shoot': this.tShoot(a); break;
			case 'bite': this.tBite(a); break;
			case 'scream': this.deathScream(a); break;
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
			if (env.rnd() < chance) { a.state = a.S.shoot1; a.ticcount = a.state.tics; return; }
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
			this.selectChaseDir(a); if (a.dir === NODIR) return;
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
	};

	WolfAI.prototype.tBite = function (a) {
		var env = this.env, p = env.player;
		this.playAt(DIGI.DOGATTACK, a);
		if (Math.abs(p.x - a.x) - 1 <= 0.0 && Math.abs(p.y - a.y) - 1 <= 0.0) {
			if (env.rnd() < 180) env.hurtPlayer(env.rnd() >> 4, a);
		}
	};

	WolfAI.prototype.deathScream = function (a) {
		var d = DIGI, s;
		switch (a.cls) {
			case 'mutant': s = d.AHHG; break;
			case 'officer': s = d.NEINSOVAS; break;
			case 'ss': s = d.LEBEN; break;
			case 'dog': s = d.DOGDEATH; break;
			case 'boss': s = d.MEINGOTT; break;
			default: // guard: random death scream
				var pool = [d.DEATH1, d.DEATH2, 34, 35, 40, 41, 42];
				s = pool[this.env.rnd() % pool.length]; break;
		}
		this.playAt(s, a);
	};

	// --- Damage from the player -------------------------------------------
	WolfAI.prototype.damageActor = function (a, damage) {
		if (!a.flags.attackmode) { damage <<= 1; this.firstSighting(a); }
		a.hp -= damage;
		if (a.hp <= 0) { this.killActor(a); return; }
		var S = a.S;
		if (S.pain) { a.state = (a.hp & 1) ? S.pain : S.pain1; a.ticcount = a.state.tics; }
	};

	WolfAI.prototype.killActor = function (a) {
		a.hp = 0;
		a.flags.shootable = false;
		a.flags.dead = true;
		a.dir = NODIR;
		this.occ.delete(this._key(a.tilex, a.tiley));
		a.state = a.S.die1; a.ticcount = a.state.tics || 0;
		this.env.addScore(a.cfg.pts);
		this.env.onKill && this.env.onKill(a);
	};

	// --- DoActor driver ---------------------------------------------------
	WolfAI.prototype.doActor = function (a) {
		var env = this.env;
		if (!a.flags.active && !a.flags.dead) {
			// dormant until it can see the player or hears gunfire
			if (this.checkLine(a.x, a.y, env.player.x, env.player.y) || this.hearsNoise(a)) a.flags.active = true;
		}
		if (!a.flags.dead) this.occ.delete(this._key(a.tilex, a.tiley));

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

		// render sprite for this frame
		if (a.state.rot) a.sprite = a.state.spr + E.rotFrame(this._facing(a), a.x, a.y, env.player.x, env.player.y);
		else a.sprite = a.state.spr;

		if (!a.flags.dead && a.flags.shootable) this.occ.set(this._key(a.tilex, a.tiley), a);
	};

	// Facing dirtype for rendering: use movement dir, or spawn facing when idle.
	WolfAI.prototype._facing = function (a) { return a.dir === NODIR ? (a._idleDir || 0) : a.dir; };

	WolfAI.prototype.update = function (dt) {
		this._dt = dt;
		this.tics = dt * TICS;
		if (this.noise.t > 0) this.noise.t = Math.max(0, this.noise.t - dt);
		for (var i = 0; i < this.actors.length; i++) this.doActor(this.actors[i]);
	};

	// --- Player weapons (GunAttack / KnifeAttack) -------------------------
	// Finds the closest shootable actor within the aim cone with a clear line,
	// then applies the original distance-based damage. `kind` is 'knife', 'gun'.
	WolfAI.prototype.playerFire = function (kind) {
		var env = this.env, p = env.player;
		if (kind !== 'knife') {
			this.noise.t = 0.5;
			this.noise.tiles = this._floodNoise(p.x | 0, p.y | 0); // heard in the connected area
		}
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
			out.push({
				x: +a.x.toFixed(3), y: +a.y.toFixed(3), d: a.dir, hp: a.hp,
				dd: f.dead ? 1 : 0, am: f.attackmode ? 1 : 0,
				ac: f.active ? 1 : 0, ab: f.ambush ? 1 : 0
			});
		}
		return out;
	};

	WolfAI.prototype.restore = function (list) {
		if (!list) return;
		var n = Math.min(list.length, this.actors.length);
		for (var i = 0; i < n; i++) {
			var a = this.actors[i], s = list[i], S = a.S;
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

	// Occupancy grid must match the restored positions.
	WolfAI.prototype._rebuildOcc = function () {
		this.occ.clear();
		for (var i = 0; i < this.actors.length; i++) {
			var a = this.actors[i];
			if (a.flags.dead || !a.flags.shootable) continue;
			this.occ.set(this._key(a.tilex, a.tiley), a);
		}
	};

	root.WolfAI = WolfAI;
})(typeof window !== 'undefined' ? window : this);
