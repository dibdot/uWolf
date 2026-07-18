/*
 * game.js
 *
 * Ties everything together: loads data, spawns the player, runs the main loop,
 * handles keyboard + touch input, opens/closes doors, collides the player
 * against the map, and draws a small minimap. Enemies are rendered as
 * billboarded, direction-correct sprites and can vocalise when approached, but
 * there is no combat AI yet (see README).
 */
(function (root) {
	'use strict';
	var RC = root.Raycaster;
	var isWall = RC.helpers.isWall, isDoor = RC.helpers.isDoor;
	var Enemies = root.WolfEnemies;
	var WolfAI = root.WolfAI;
	var DIGI = root.SoundManager ? root.SoundManager.DIGI : null;

	// Static decoration / item object codes in plane1 map (roughly) to sequential
	// sprite pages starting at SPR_STAT_0. This renders decor and pickups; a few
	// special items may be a page off, which is harmless for an explorer.
	var STAT_FIRST = 23, STAT_LAST = 74, SPR_STAT_0 = 2;
	// Static decorations that block movement (from statinfo[].block): barrels,
	// tables, pillars, armour/knight, cages, wells, stove, etc. Bullets and sight
	// pass over them (the original blocks via actorat, not the wall map). The set
	// is dataset-dependent — see the WolfVariant hook below — so it is rebuilt
	// rather than frozen; these are the WL6 defaults.
	var BLOCK_STATIC = {};
	function setBlockStatic(codes) {
		BLOCK_STATIC = {};
		codes.forEach(function (c) { BLOCK_STATIC[c] = 1; });
	}
	setBlockStatic([24, 25, 26, 28, 30, 31, 33, 34, 35, 36, 39, 40, 41, 45, 58, 59, 60, 62, 63, 68, 69]);

	// Collectible items (plane1 code -> effect), from GetBonus. `min`/`gib` gate
	// whether the item is taken (health/ammo pickups are left if not useful).
	// FM sound effects (indices into AUDIOT's effect table). These were never
	// digitised — VSWAP has no pickup sounds at all — so before opl2.js there was
	// nothing to play here but a synthesised stand-in.
	var FX = {
		NOWAY: 6, PLAYERDEATH: 9, GETKEY: 12, GETMACHINE: 30, GETAMMO: 31,
		HEALTH1: 33, HEALTH2: 34, BONUS1: 35, BONUS2: 36, BONUS3: 37,
		GETGATLING: 38, BONUS1UP: 44, BONUS4: 45
	};

	var PICKUP = {
		29: { health: 4, snd: FX.HEALTH1 },                        // dog food
		47: { health: 10, snd: FX.HEALTH1 },                       // food
		48: { health: 25, snd: FX.HEALTH2 },                       // first aid
		57: { gib: 1 }, 61: { gib: 1 },                               // gibs (only when nearly dead)
		49: { ammo: 8, snd: FX.GETAMMO },                          // ammo clip
		50: { weapon: 2, snd: FX.GETMACHINE },                     // machine gun
		51: { weapon: 3, snd: FX.GETGATLING },                     // chain gun
		52: { points: 100, treasure: 1, snd: FX.BONUS1 },          // cross
		53: { points: 500, treasure: 1, snd: FX.BONUS2 },          // chalice
		54: { points: 1000, treasure: 1, snd: FX.BONUS3 },         // bible
		55: { points: 5000, treasure: 1, snd: FX.BONUS4 },         // crown
		56: { fullheal: 1, snd: FX.BONUS1UP },                     // one-up
		43: { key: 0, snd: FX.GETKEY }, 44: { key: 1, snd: FX.GETKEY }
	};
	// The shared (WL6) collectibles above are the base; a dataset may add its own
	// (Spear of Destiny has a 25-round clip and the Spear itself). Rebuilt on a
	// variant switch so the WL6 set is never permanently mutated.
	var PICKUP_BASE = PICKUP;
	function setPickups(extra) {
		if (!extra) { PICKUP = PICKUP_BASE; return; }
		var m = {}, k;
		for (k in PICKUP_BASE) if (PICKUP_BASE.hasOwnProperty(k)) m[k] = PICKUP_BASE[k];
		for (k in extra) if (extra.hasOwnProperty(k)) m[k] = extra[k];
		PICKUP = m;
	}
	// Plane codes for the "use" (Space) mechanic.
	var PUSHABLE = 98, ELEVATOR = 21;   // PUSHABLETILE / ELEVATORTILE
	var GOLD_KEY = 43;                  // bo_key1 — what Hans and Gretel drop
	var EXITTILE = 99;                  // plane1: "at end of castle" — stepping on it wins
	var AREATILE = 107, NUMAREAS = 37;  // plane0: floor tiles carry the room they belong to
	var ALT_ELEVATOR = 107;             // plane0: stand here and use an elevator -> secret floor
	// Where the secret floor spits you back out, per episode (ElevatorBackTo[]).
	var ELEVATOR_BACK_TO = [1, 1, 7, 3, 5, 3];
	var EPISODE_FLOORS = 10;            // 8 normal + boss (index 8) + secret (index 9)

	// songs[] from wl_play.cpp: which of the 27 tracks plays on each of the 60 floors.
	// Episodes 4-6 reuse the music of 1-3; only the final secret floor differs
	// (FUNKYOU_MUS instead of PACMAN_MUS).
	var SONGS = [
		3, 11, 9, 12, 3, 11, 9, 12, 2, 0,        // episode 1  (boss: WARMARCH, secret: CORNER)
		8, 18, 17, 4, 8, 18, 4, 17, 2, 1,        // episode 2
		6, 20, 22, 21, 6, 20, 22, 21, 19, 26,    // episode 3  (secret: PACMAN)
		3, 11, 9, 12, 3, 11, 9, 12, 2, 0,        // episode 4
		8, 18, 17, 4, 8, 18, 4, 17, 2, 1,        // episode 5
		6, 20, 22, 21, 6, 20, 22, 21, 19, 15     // episode 6  (secret: FUNKYOU)
	];
	var ARROW_FIRST = 90;               // ICONARROWS: plane1 90..97 = patrol turn arrows
	var PUSH_SPEED = 70 / 128;          // tiles/sec — matches MovePWalls (128 tics/tile @ 70Hz)

	function Game(canvas, minimap) {
		this.canvas = canvas;
		this.minimap = minimap;
		if (minimap) minimap.style.display = 'none';   // hidden until the player asks
		this.rc = null;
		this.data = null;
		this.player = { x: 0, y: 0, angle: 0, dirX: 1, dirY: 0, planeX: 0, planeY: 0.66 };
		this.doors = new Map();
		this.keys = {};
		// Touch input is the on-screen D-pad + FIRE button ("Mobile controls").
		// There is no swipe-to-turn: turning lives on the pad, which is far less
		// tiring than dragging the screen around.
		this.touch = {
			fire: false,
			pad: { fwd: false, back: false, left: false, right: false }
		};
		this.moveSpeed = 3.2;   // cells / second
		this.turnSpeed = 1.7;   // radians / second at full tilt (original walk: 2.14)
		// Turning eases in rather than snapping straight to full speed. Holding the
		// key still gets you the same rate as before within a fifth of a second, but
		// a short tap now moves a fraction as far, which is what makes fine aiming
		// possible: at 60fps full speed is ~1.6 degrees per frame, and that single
		// step is what reads as a jump. Both values are live-tunable from the
		// console (game.turnSpeed / game.turnRampMin).
		this.turnRampMin = 0.15;  // fraction of turnSpeed a fresh tap starts at
		this.turnRampRate = 4.0;  // how fast it eases up to 1.0 (per second)
		this._turnRamp = 0.15;
		this._turnSign = 0;
		this.doorOpenTime = 0.5;
		this.doorStayTime = 4.0;
		this.showMap = false;
		this.running = false;
		this.pushwall = null;      // active secret-wall slide
		this._levelDone = 0;       // >0 = showing floor-stats screen
		this._doneWait = 0;        // >0 = switch thrown, waiting for LEVELDONESND
		this._episodeDone = false; // the stats screen is an EPISODE COMPLETE screen
		this._deathCam = 0;        // >0 = watching a boss go down
		this._bjRun = false;       // B.J.'s victory run is under way
		this._levelDoneReady = false;
		this._continueTap = false;
		this._campaignDone = false;
		this._pendingLevel = 0;
		this.renderScale = 1.0; // internal resolution factor (always native)
		// Combat gamestate. Weapons: 0 knife, 1 pistol, 2 machine gun, 3 chaingun.
		this.gs = null;
		this._levelIndex = 0;
		this._fireWasDown = false;
		this._playerMoving = false;
		this.resetPlayerState();
		this._bindInput();
	}

	var WP = { KNIFE: 0, PISTOL: 1, MG: 2, CHAINGUN: 3 };
	var WP_NAME = ['Knife', 'Pistol', 'MG', 'Chaingun'];
	var FIRE_CD = [0.40, 0.28, 0.12, 0.07];  // seconds between shots per weapon
	var STARTAMMO = 8;                       // what you (re)start a life with
	// POV weapon sprites in VSWAP: contiguous blocks of 5 pages each
	// (ready, atk1..atk4). Rendered bottom-centre over the scene.
	var WEAPON_BASE = [416, 421, 426, 431];
	// WL6 VGAGRAPH chunk numbers for the original status bar.
	var VGA = {
		STATUSBAR: 86, KNIFE: 91, NOKEY: 95, GOLDKEY: 96, SILVERKEY: 97,
		N_BLANK: 98, N_0: 99, FACE1A: 109
	};

	// Dataset-dependent tables. WL6 keeps the values above; a variant (e.g. Spear
	// of Destiny) supplies its own POV-weapon pages, VGAGRAPH status-bar chunks,
	// per-floor music and floor structure. Spear is one flat 21-floor campaign
	// (no episodes, no secret-elevator warp) rather than 6 episodes of 10.
	var EPISODES = true;        // false => flat run, label floors "Floor N"
	var SECRET_WARP = true;     // false => the alternate elevator just advances
	var SECRET_MAP = null;      // Spear routes its bonus floors by map number
	var PAR_TIMES = null;       // per-floor par times in minutes (wl_inter.cpp)
	var PAR_AMOUNT = 500;       // points per second saved against par
	var PERCENT100AMT = 10000;  // points for a clean 100% in a category
	if (root.WolfVariant) {
		root.WolfVariant.onUse(function (v) {
			if (!v) return;
			if (v.weaponBase) WEAPON_BASE = v.weaponBase;
			if (v.vga) VGA = v.vga;
			if (v.songs) SONGS = v.songs;
			if (v.prog) {
				EPISODE_FLOORS = v.prog.episodeFloors;
				ELEVATOR_BACK_TO = v.prog.elevatorBackTo;
				EPISODES = v.prog.episodes;
				SECRET_WARP = v.prog.secretWarp;
				SECRET_MAP = v.prog.secretMap || null;
			}
			PAR_TIMES = v.parTimes || null;
			if (v.statics) {
				if (v.statics.block) setBlockStatic(v.statics.block);
				setPickups(v.statics.pickup);
			}
		});
	}

	// Full player reset (called from the menu before the first level).
	Game.prototype.resetPlayerState = function () {
		this.gs = {
			health: 100, ammo: STARTAMMO, weapon: WP.PISTOL, chosen: WP.PISTOL,
			have: [true, true, false, false],
			score: 0, lives: 3, nextExtra: 40000, difficulty: 1, godmode: false, infiniteAmmo: false, keys: 0,
			allWeapons: false, gameOver: false,
			damageFlash: 0, fireCd: 0, dead: false, respawn: 0,
			wpnAnimT: 0, wpnAnimDur: 0, bob: 0, faceframe: 0, faceTimer: 0
		};
	};

	Game.prototype.setDifficulty = function (d) { this.gs.difficulty = d | 0; };
	Game.prototype.setGodmode = function (on) { this.gs.godmode = !!on; };
	Game.prototype.setShowMap = function (on) {
		this.showMap = !!on;
		if (this.minimap) this.minimap.style.display = this.showMap ? 'block' : 'none';
	};
	Game.prototype.toggleMap = function () { this.setShowMap(!this.showMap); };

	// Debug: list the live actors with their facing, the rotation frame the renderer
	// derives from it, and the sprite that results. If an enemy shows its back while
	// attacking, this says whether its DIRECTION is wrong (dir points away from you)
	// or its SPRITE NUMBERING is (dir correct, but the artwork is offset).
	Game.prototype.dumpActors = function () {
		if (!this.ai || !this.ai.actors) { console.log('no actors'); return; }
		var E = root.WolfEnemies, p = this.player, rows = [];
		for (var i = 0; i < this.ai.actors.length; i++) {
			var a = this.ai.actors[i];
			if (a.proj || a.bj || !a.cfg) continue;
			var name = '?';
			if (a.S) for (var k in a.S) if (a.S[k] === a.state) { name = k; break; }
			var dir = (a.dir === 8) ? 'NODIR' : a.dir;
			var facing = (a.dir === 8) ? (a._idleDir || 0) : a.dir;
			var rot = a.state && a.state.rot ? E.rotFrame(facing, a.x, a.y, p.x, p.y) : '-';
			// Angle from the actor to the player, for comparison with its facing.
			var toPlayer = Math.atan2(-(p.y - a.y), p.x - a.x) * 180 / Math.PI;
			if (toPlayer < 0) toPlayer += 360;
			rows.push({
				kind: a.kind || a.cls || 'enemy',
				state: name, rot: a.state ? !!a.state.rot : false,
				dir: dir, facingDeg: facing * 45,
				angleToPlayer: Math.round(toPlayer),
				rotFrame: rot, baseSpr: a.state ? a.state.spr : '-', sprite: a.sprite,
				hp: a.hp, dist: Math.round(Math.hypot(p.x - a.x, p.y - a.y) * 10) / 10
			});
		}
		console.log('variant ' + ((root.WolfVariant && root.WolfVariant.active) ? root.WolfVariant.active.id : '?') +
			'  player ' + (Math.round(p.x * 10) / 10) + ',' + (Math.round(p.y * 10) / 10));
		if (console.table) console.table(rows); else console.log(rows);
		return rows;
	};

	// straight out of VSWAP — the level below dumpSprite(), which only shows the
	// decoded colours. Use this to tell "the data really says colour N" from "we
	// read the wrong byte". Example: game.dumpSpritePosts(421, 24, 28).
	Game.prototype.dumpSpritePosts = function (page, colFrom, colTo) {
		if (!this.data) { console.log('no game data loaded'); return; }
		var d = this.data, abs = d.spriteStart + page, base = d.pageOffset[abs];
		if (base == null) { console.log('no chunk at abs page ' + abs); return; }
		var src = d.vswap, pal = d.pal;
		var dv = new DataView(src.buffer, base);
		var firstCol = dv.getUint16(0, true), lastCol = dv.getUint16(2, true);
		console.log('page ' + page + ' (abs ' + abs + ')  chunkOfs ' + base +
			'  len ' + d.pageLength[abs] + '  cols ' + firstCol + '..' + lastCol);
		if (colFrom == null) colFrom = firstCol;
		if (colTo == null) colTo = Math.min(lastCol, colFrom + 3);
		for (var col = Math.max(colFrom, firstCol); col <= Math.min(colTo, lastCol); col++) {
			var p = dv.getUint16(4 + (col - firstCol) * 2, true);
			var out = 'col ' + col + ' @' + p + ':';
			var guard = 0;
			while (guard++ < 64) {
				var endY = dv.getUint16(p, true);
				if (endY === 0) break;
				endY >>= 1;
				var pixOfs = dv.getInt16(p + 2, true);   // signed, see wl_formats.js
				var startY = dv.getUint16(p + 4, true) >> 1;
				p += 6;
				var idxs = [], outside = 0;
				var chunkEnd = d.pageLength[abs] || 0;
				for (var y = startY; y < endY; y++) {
					var rel = pixOfs + y;                       // byte offset inside the chunk
					var idx = src[base + rel];
					if (chunkEnd && (rel < 0 || rel >= chunkEnd)) outside++;
					idxs.push(idx + '(' + pal[idx * 3] + ',' + pal[idx * 3 + 1] + ',' + pal[idx * 3 + 2] + ')');
				}
				out += '\n    post y ' + startY + '..' + (endY - 1) + '  pixOfs ' + pixOfs +
					'  -> abs ' + (base + pixOfs + startY) +
					(outside ? '   *** ' + outside + ' byte(s) OUTSIDE the chunk (len ' + chunkEnd + ') ***' : '') +
					'\n      ' + idxs.join(' ');
			}
			console.log(out);
		}
	};

	// claims versus the columns that really received pixels. A weapon or actor that
	// renders as a narrow strip shows up here as a small "colsWithPixels" count.
	// Call game.dumpSprite(426) for a specific relative page, or game.dumpSprite()
	// for the weapon currently in hand.
	Game.prototype.dumpSprite = function (page) {
		if (!this.data) { console.log('no game data loaded'); return; }
		if (page == null) page = WEAPON_BASE[this.gs.weapon];
		var canvas;
		try { canvas = this.data.getSpriteCanvas(page); } catch (e) { console.log('decode threw: ' + e.message); return; }
		if (!canvas) { console.log('no canvas for page ' + page); return; }
		var px = canvas.getContext('2d').getImageData(0, 0, 64, 64).data;
		var cols = [], rowMin = 64, rowMax = -1, filled = 0;
		for (var x = 0; x < 64; x++) {
			var n = 0;
			for (var y = 0; y < 64; y++) {
				if (px[(y * 64 + x) * 4 + 3]) {
					n++; filled++;
					if (y < rowMin) rowMin = y;
					if (y > rowMax) rowMax = y;
				}
			}
			if (n) cols.push(x);
		}
		// Colour histogram: tells us whether an odd colour (e.g. the blue specks on
		// the weapon hand) is genuinely in the decoded sprite, or only appears once
		// the sprite is scaled and composited onto the view.
		var hist = {};
		for (var i = 0; i < 64 * 64; i++) {
			if (!px[i * 4 + 3]) continue;
			var k = px[i * 4] + ',' + px[i * 4 + 1] + ',' + px[i * 4 + 2];
			hist[k] = (hist[k] || 0) + 1;
		}
		var top = Object.keys(hist).map(function (k) { return { rgb: k, n: hist[k] }; })
			.sort(function (a, b) { return b.n - a.n; }).slice(0, 12);

		var info = {
			variant: (root.WolfVariant && root.WolfVariant.active) ? root.WolfVariant.active.id : '?',
			relPage: page,
			absPage: this.data.spriteStart + page,
			spriteStart: this.data.spriteStart,
			soundStart: this.data.soundStart,
			colsWithPixels: cols.length,
			colRange: cols.length ? (cols[0] + '..' + cols[cols.length - 1]) : 'none',
			rowRange: rowMax >= 0 ? (rowMin + '..' + rowMax) : 'none',
			opaquePixels: filled,
			topColours: top
		};
		console.log(info);

		// Coarse ASCII view of the decoded sprite (2x2 blocks): '.' transparent,
		// 'B' a strongly blue pixel, '#' anything else opaque.
		var art = '';
		for (var ay = 0; ay < 64; ay += 2) {
			var line = '';
			for (var ax = 0; ax < 64; ax += 2) {
				var o = (ay * 64 + ax) * 4;
				if (!px[o + 3]) { line += '.'; continue; }
				var r = px[o], g = px[o + 1], b = px[o + 2];
				line += (b > 110 && b > r + 40 && b > g + 20) ? 'B' : '#';
			}
			art += line + '\n';
		}
		console.log(art);
		return info;
	};

	// Debug: print the decoded plane geometry around the player, to tell whether a
	// room's size comes from the map data or from a decode problem. Call
	// game.dumpMap() (optionally a radius) from the browser console while standing
	// in the room. Legend: @ player, # wall, E elevator, + door, o object, . floor.
	Game.prototype.dumpMap = function (r) {
		r = r || 6;
		var lvl = this.level;
		if (!lvl) { console.log('no level loaded'); return; }
		var W = lvl.width, H = lvl.height, p0 = lvl.plane0, p1 = lvl.plane1;
		var px = this.player.x | 0, py = this.player.y | 0;
		var out = 'level ' + this._levelIndex + '  dims ' + W + 'x' + H + '  player ' + px + ',' + py + '\n';
		for (var y = py - r; y <= py + r; y++) {
			if (y < 0 || y >= H) continue;
			var row = '';
			for (var x = px - r; x <= px + r; x++) {
				if (x < 0 || x >= W) { row += ' '; continue; }
				var w = p0[y * W + x], o = p1[y * W + x], ch;
				if (x === px && y === py) ch = '@';
				else if (w === 21) ch = 'E';
				else if (w > 0 && w <= 63) ch = '#';
				else if (w >= 90 && w <= 101) ch = '+';
				else if (o) ch = 'o';
				else ch = '.';
				row += ch;
			}
			out += row + '\n';
		}
		console.log(out);
		return out;
	};

	// Leave the running game and hand back to the menu (Escape key / MENU button).
	// main.js supplies onMenu, which restores the menu DOM; the game state stays
	// intact, so the run can be resumed or stored into a slot from there.
	Game.prototype.exitToMenu = function () {
		if (!this.running) return;
		this.running = false;
		if (this.music) this.music.silence();      // the world is paused; so is the band
		if (this.onMenu) this.onMenu();
	};

	// Is there a run sitting in memory that could be resumed?
	Game.prototype.canResume = function () {
		return !!(this.level && this.gs && !this.gs.gameOver);
	};

	// Pick the paused run back up exactly where it was.
	Game.prototype.resume = function () {
		if (!this.canResume() || this.running) return false;
		this.running = true;
		this._last = performance.now();      // don't bill the menu time to the next frame
		this.setShowMap(this.showMap);
		if (this.music) this.music.play(SONGS[this._levelIndex % SONGS.length]);
		requestAnimationFrame(this._loop.bind(this));
		return true;
	};

	// Drop the current run entirely (after a game over), so nothing is left to resume.
	Game.prototype.clearRun = function () {
		this.running = false;
		if (this.music) this.music.stop();
		this.level = null;
		this.ai = null;
		if (this.rc) this.rc.sprites = [];
		this.resetPlayerState();
	};
	Game.prototype.setInfiniteAmmo = function (on) {
		this.gs.infiniteAmmo = !!on;
		if (on) this.gs.ammo = Math.max(this.gs.ammo, 99);
	};
	Game.prototype.setAllWeapons = function (on) {
		this.gs.allWeapons = !!on;      // remembered, so a respawn restores them
		if (!on) return;
		this.gs.have = [true, true, true, true];
		this.gs.ammo = Math.max(this.gs.ammo, 99);
	};

	Game.prototype.load = function (buffers) {
		// A run belongs to the dataset it started in. If the player switches game
		// (Wolfenstein <-> Spear) the in-memory run is from the old data, so drop it
		// — otherwise "Resume" would pick it up under the new dataset's textures.
		var vid = (root.WolfVariant && root.WolfVariant.active) ? root.WolfVariant.active.id : 'WL6';
		if (this.level && this._runVariant && this._runVariant !== vid) this.clearRun();
		this.data = new root.WolfFormats.GameData(buffers);
		this.rc = new RC(this.data, this.canvas);
		if (root.SoundManager) this.sound = new root.SoundManager(this.data);
		return this.data.levels;
	};

	Game.prototype.setAngle = function (a) {
		var p = this.player;
		p.angle = a;
		p.dirX = Math.cos(a); p.dirY = Math.sin(a);
		p.planeX = -Math.sin(a) * 0.66; p.planeY = Math.cos(a) * 0.66;
	};

	Game.prototype.startLevel = function (index) {
		var lvl = this.data.getLevel(index);
		this.level = lvl;
		this._runVariant = (root.WolfVariant && root.WolfVariant.active) ? root.WolfVariant.active.id : 'WL6';
		this._levelIndex = index;
		this.pushwall = null;
		this._levelDone = 0;
		this._doneWait = 0;
		this._episodeDone = false;
		this._deathCam = 0;
		this._bjRun = false;
		this.gs.keys = 0;      // keys are per-floor
		this._lockMsg = 0;
		this.doors.clear();

		var self = this, w = lvl.width;
		// Build the AI world view over this game's map and door state.
		this.ai = new WolfAI({
			width: lvl.width, height: lvl.height,
			isWall: function (tx, ty) {
				if (tx < 0 || ty < 0 || tx >= lvl.width || ty >= lvl.height) return true;
				return isWall(lvl.plane0[ty * w + tx]);
			},
			doorInfo: function (tx, ty) {
				if (tx < 0 || ty < 0 || tx >= lvl.width || ty >= lvl.height) return null;
				if (!isDoor(lvl.plane0[ty * w + tx])) return null;
				var d = self.doors.get(ty * w + tx);
				if (!d) return null;
				var locked = d.lock >= 1 && d.lock <= 4 && !(self._effKeys() & (1 << (d.lock - 1)));
				return { key: ty * w + tx, open: d.open, locked: locked };
			},
			doorByKey: function (k) { var d = self.doors.get(k); return d ? { key: k, open: d.open } : null; },
			openDoor: function (k) { self._openDoor(self.doors.get(k)); },
			player: self.player,
			rnd: function () { return (Math.random() * 256) | 0; },
			hurtPlayer: function (pts, actor) { self._hurtPlayer(pts, actor); },
			addScore: function (pts) { self._givePoints(pts); },
			playerMoving: function () { return self._playerMoving; },
			sound: self.sound || null,
			blocked: function (tx, ty) { return self.solidObjects.has(ty * w + tx); },
			// Hans / Gretel leave a gold key behind (KillActor -> PlaceItemType(bo_key1)).
			dropKey: function (tx, ty) { self._dropPickup(tx, ty, GOLD_KEY); },
			// Schabbs / Giftmacher / Fat Face / Adolf end the floor when they die.
			onVictory: function () { self._completeFloor('victory'); },
			// Adolf steps out of Mecha Hitler's wreck mid-level: the renderer only got
			// the actor list once, at startLevel, so a newcomer has to be added here.
			onSpawn: function (actor) { self.rc.sprites.push(actor); },
			// Projectiles are the only actors that ever disappear again.
			onRemove: function (actor) {
				var i = self.rc.sprites.indexOf(actor);
				if (i >= 0) self.rc.sprites.splice(i, 1);
			},
			// FM-only effects (missiles, syringes, flames): they were never digitised.
			fx: function (index) { if (self.music) self.music.playSfx(index); },
			onDeathCam: function (boss) { self._startDeathCam(boss); },
			// mapon == 9: the episode's secret floor. A_DeathScream has a 1-in-256
			// surprise reserved for exactly that floor.
			isSecretFloor: function () { return (self._levelIndex % EPISODE_FLOORS) === 9; },
			// The area gate: is this actor's room currently connected to the player's?
			areaAt: function (tx, ty) { return self._areaAt(tx, ty); },
			areaByPlayer: function (area) {
				if (area < 0) return true;              // a doorway belongs to no room
				return !!self.areaByPlayer[area];
			},
			// Turn-arrow tiles (plane1 90..97 = ICONARROWS) that script patrol routes.
			// Returns a dirtype 0..7 (east, NE, north, NW, west, SW, south, SE), or -1.
			arrowAt: function (tx, ty) {
				if (tx < 0 || ty < 0 || tx >= lvl.width || ty >= lvl.height) return -1;
				var t1 = lvl.plane1[ty * w + tx];
				return (t1 >= ARROW_FIRST && t1 <= ARROW_FIRST + 7) ? (t1 - ARROW_FIRST) : -1;
			},
			onKill: function () { self._stats.kills++; }
		});

		// Register doors and locate player start / sprites from plane1.
		var sprites = [];
		var startSet = false;
		var diff = this.gs.difficulty;
		this.solidObjects = new Set();
		this.pickups = new Map();
		this._stats = { floor: this._floorNumber(index), enemies: 0, kills: 0, secretsTotal: 0, secretsFound: 0, treasureTotal: 0, treasureFound: 0 };
		this._levelTime = 0;              // seconds on this floor, for the par bonus
		for (var y = 0; y < lvl.height; y++) {
			for (var x = 0; x < lvl.width; x++) {
				var t0 = lvl.plane0[y * lvl.width + x];
				if (isDoor(t0)) this.doors.set(y * lvl.width + x, { tile: t0, open: 0, state: 'closed', timer: 0, cx: x, cy: y, lock: ((t0 - 90) / 2) | 0 });
				var t1 = lvl.plane1[y * lvl.width + x];
				if (t1 >= 19 && t1 <= 22) {
					this.player.x = x + 0.5; this.player.y = y + 0.5;
					var dirs = { 19: -Math.PI / 2, 20: 0, 21: Math.PI / 2, 22: Math.PI };
					this.setAngle(dirs[t1]); startSet = true;
				} else if (t1 >= STAT_FIRST && t1 <= STAT_LAST) {
					var spr = { x: x + 0.5, y: y + 0.5, sprite: SPR_STAT_0 + (t1 - STAT_FIRST) };
					sprites.push(spr);
					if (BLOCK_STATIC[t1]) this.solidObjects.add(y * lvl.width + x);
					if (PICKUP[t1]) {
						this.pickups.set(y * lvl.width + x, { code: t1, spr: spr });
						if (PICKUP[t1].treasure) this._stats.treasureTotal++;
					}
				} else if (Enemies) {
					if (t1 === PUSHABLE) this._stats.secretsTotal++;
					var spawn = Enemies.decodeSpawn(t1);
					if (!spawn) continue;
					if (spawn.type === 'corpse' || spawn.type === 'ghost') {
						// inert: render as a static sprite, no AI
						sprites.push({ x: x + 0.5, y: y + 0.5, sprite: spawn.base });
					} else if (diff >= spawn.minDiff) {
						var a = this.ai.spawn(spawn, x + 0.5, y + 0.5, diff);
						if (a) a._idleDir = spawn.dirType;   // facing while standing
					}
				}
			}
		}
		if (!startSet) { this.player.x = lvl.width / 2; this.player.y = lvl.height / 2; this.setAngle(0); }

		// Live actors render alongside static sprites; the renderer reads x/y/sprite
		// which the AI mutates in place each frame.
		this.staticSprites = sprites;
		this._stats.enemies = this.ai.actors.length;
		// SpawnGhosts bumps killtotal AND killcount together, so the four immortal
		// ghosts on the secret floor count toward the total without ever keeping
		// you off 100% — they cannot be shot.
		for (var gi = 0; gi < this.ai.actors.length; gi++) {
			var ga = this.ai.actors[gi];
			if (ga.cfg && ga.cfg.ghost) this._stats.kills++;
		}
		if (typeof console !== 'undefined' && console.info) {
			console.info('[uWolf] level ' + (index + 1) + ', difficulty ' + diff +
				': ' + this.ai.actors.length + ' active enemies spawned');
		}
		this.rc.setLevel(lvl, this.doors);
		this.rc.sprites = sprites.concat(this.ai.actors);
		this._buildAreas();
		this._resize();
		this.setShowMap(this.showMap);
		// Each floor has its own track (songs[] in wl_play.cpp).
		if (this.music) this.music.play(SONGS[index % SONGS.length]);
		if (!this.running) { this.running = true; this._last = performance.now(); requestAnimationFrame(this._loop.bind(this)); }
	};

	Game.prototype._resize = function () {
		var cssW = this.canvas.clientWidth || window.innerWidth;
		var cssH = this.canvas.clientHeight || window.innerHeight;
		var w = Math.max(160, Math.round(cssW * this.renderScale));
		var h = Math.max(120, Math.round(cssH * this.renderScale));
		this.rc.resize(w, h);
	};

	// ---- Input -------------------------------------------------------------

	Game.prototype._bindInput = function () {
		var self = this;
		window.addEventListener('keydown', function (e) {
			if (self.sound) self.sound.resume();
			self.keys[e.code] = true;
			if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyE') self._use();
			if (e.code === 'KeyM') self.toggleMap();
			if (e.code === 'Escape') { e.preventDefault(); self.exitToMenu(); }
			if (e.code === 'F8') { e.preventDefault(); self.quickSave(); }
			if (e.code === 'F9') { e.preventDefault(); self.quickLoad(); }
			if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].indexOf(e.code) >= 0) e.preventDefault();
		});
		window.addEventListener('keyup', function (e) { self.keys[e.code] = false; });
		window.addEventListener('resize', function () { if (self.rc) self._resize(); });
		// Tap / click continues the floor-stats and game-over screens.
		this.canvas.addEventListener('pointerdown', function () { if (self._levelDone > 0) self._continueTap = true; });
	};

	// ---- Enemies (render-only) --------------------------------------------

	// Pick each rotating enemy's facing frame relative to the player, and fire a
	// one-shot vocalisation when the player first comes close. No movement or AI.
	Game.prototype._updateCombat = function (dt) {
		if (!this.ai) return;
		// The intermission is not part of the game world any more: in the original the
		// play loop has already exited, so nobody keeps shooting at you while you read
		// the floor stats.
		if (this._levelDone > 0 || this._doneWait > 0) return;
		var p = this.player, gs = this.gs;

		// decay flashes
		if (gs.damageFlash > 0) gs.damageFlash = Math.max(0, gs.damageFlash - dt * 1.5);
		if (gs.wpnAnimT > 0) gs.wpnAnimT = Math.max(0, gs.wpnAnimT - dt);
		// gentle weapon bob while walking
		gs.bob += dt * (this._playerMoving ? 7 : 0);
		// BJ face rotation frame (matches StatusDrawFace: rnd>>6, 3 -> 1)
		gs.faceTimer -= dt;
		if (gs.faceTimer <= 0) {
			gs.faceTimer = 0.5 + Math.random() * 0.5;
			var f = (Math.random() * 256) | 0; f >>= 6; if (f === 3) f = 1;
			gs.faceframe = f;
		}

		// Death / respawn: freeze the world while dead, then restart the level.
		if (gs.dead) {
			if (gs.gameOver) return;          // out of lives: wait for acknowledgement
			gs.respawn -= dt;
			if (gs.respawn <= 0) this._respawn();
			return;
		}

		// Mark which actors are visible (drives enemy aim + gives dodge modifier).
		var acts = this.ai.actors;
		for (var i = 0; i < acts.length; i++) {
			var a = acts[i];
			if (a.flags.dead) { a.flags.visible = false; continue; }
			var dx = a.x - p.x, dy = a.y - p.y, dd = Math.hypot(dx, dy) || 1;
			var dot = (dx / dd) * p.dirX + (dy / dd) * p.dirY;
			a.flags.visible = dot > 0.66 && this.ai.checkLine(p.x, p.y, a.x, a.y);
		}

		this.ai.update(dt);
		this._updateWeapon(dt);
	};

	Game.prototype._updateWeapon = function (dt) {
		var gs = this.gs, k = this.keys;
		if (gs.fireCd > 0) gs.fireCd -= dt;

		// weapon switch (1-4), only if owned
		for (var n = 0; n < 4; n++) {
			if (k['Digit' + (n + 1)] && gs.have[n]) this._switchWeapon(n);
		}

		var fireHeld = !!(k['ControlLeft'] || k['ControlRight'] || this.touch.fire);
		var auto = (gs.weapon === WP.MG || gs.weapon === WP.CHAINGUN);
		var wantFire = auto ? fireHeld : (fireHeld && !this._fireWasDown);
		this._fireWasDown = fireHeld;
		if (wantFire && gs.fireCd <= 0) this._fireWeapon();
	};

	Game.prototype._fireWeapon = function () {
		var gs = this.gs, w = gs.weapon;
		gs.fireCd = FIRE_CD[w];
		gs.wpnAnimT = gs.wpnAnimDur = FIRE_CD[w];   // play the attack frames
		if (w === WP.KNIFE) { this.ai.playerFire('knife'); return; }
		if (!gs.infiniteAmmo && gs.ammo <= 0) { this._switchWeapon(WP.KNIFE); return; }
		this.ai.playerFire('gun');
		if (this.sound && DIGI) {
			var snd = w === WP.PISTOL ? DIGI.PISTOL : (w === WP.MG ? DIGI.MGUN : DIGI.GATLING);
			this.sound.play(snd, 0.7);
		}
		if (!gs.infiniteAmmo) {
			gs.ammo--;
			if (gs.ammo <= 0) this._switchWeapon(WP.KNIFE);
		}
	};

	Game.prototype._switchWeapon = function (w) {
		var gs = this.gs;
		if (!gs.have[w]) return;
		if (w !== WP.KNIFE && gs.ammo <= 0 && !gs.infiniteAmmo) return;
		gs.weapon = w;
		if (w !== WP.KNIFE) gs.chosen = w;
	};

	// Cycle to the next owned & usable weapon (for the touch WPN button).
	Game.prototype.cycleWeapon = function () {
		var gs = this.gs;
		for (var i = 1; i <= 4; i++) {
			var w = (gs.weapon + i) % 4;
			if (gs.have[w] && (w === WP.KNIFE || gs.ammo > 0 || gs.infiniteAmmo)) { this._switchWeapon(w); return; }
		}
	};

	Game.prototype._hurtPlayer = function (pts, actor) {
		var gs = this.gs;
		if (gs.dead) return;
		if (gs.difficulty === 0) pts = pts >> 2;   // baby mode: quarter damage
		if (pts <= 0) return;

		// God mode costs no health — but the hit still registers on screen. TakeDamage()
		// skips only the health subtraction (`if (!godmode) gamestate.health -= points`)
		// and still calls StartDamageFlash(), so you can see you are being shot at.
		// (Wolf4SDL's godmode==2, the "silent" level, is the one that drops the flash;
		// we don't implement that.) The FACE, on the other hand, does NOT react: it is
		// picked purely from health, and health never moves — so BJ keeps grinning.
		gs.damageFlash = Math.min(1, gs.damageFlash + 0.25 + pts / 50);
		if (gs.godmode) return;

		gs.health -= pts;
		if (gs.health <= 0) { gs.health = 0; this._playerDied(actor); }
	};

	Game.prototype._playerDied = function () {
		var gs = this.gs;
		gs.dead = true; gs.respawn = 1.8; gs.damageFlash = 1;
		// PLAYERDEATHSND is an FM-only effect: it is not in wolfdigimap, which is why
		// there was nothing to play here before opl2.js existed. (We used to play digi
		// chunk 18 by mistake — that is DIESND, Hitler shouting "Die!".)
		this._sfx(FX.PLAYERDEATH, null);
	};

	// ---- Pickups -----------------------------------------------------------
	// If the player is standing on a collectible and it's useful, apply it and
	// remove the sprite. Useless items (medkit at full health, clip at full ammo)
	// are left on the floor, exactly as in the original GetBonus.
	Game.prototype._checkPickup = function () {
		if (!this.pickups || !this.pickups.size) return;
		var p = this.player, key = (p.y | 0) * this.level.width + (p.x | 0);
		var pk = this.pickups.get(key);
		if (pk && this._collect(pk.code)) { pk.spr.sprite = -1; this.pickups.delete(key); }
	};

	Game.prototype._collect = function (code) {
		var gs = this.gs, it = PICKUP[code];
		if (it.health != null) { if (gs.health >= 100) return false; this._heal(it.health); this._sfx(it.snd, 'health'); }
		else if (it.gib) {
			if (gs.health > 10) return false;
			this._heal(1);
			if (this.sound && DIGI) this.sound.play(DIGI.SLURPIE, 0.5);
		}
		else if (it.ammo != null) { if (gs.ammo >= 99) return false; this._giveAmmo(it.ammo); this._sfx(it.snd, 'ammo'); }
		else if (it.weapon != null) { this._giveWeapon(it.weapon); this._sfx(it.snd, 'weapon'); }
		else if (it.fullheal) {
			this._heal(99); this._giveAmmo(25);
			if (gs.lives < 9) gs.lives++;
			this._stats.treasureFound++;
			this._sfx(it.snd, '1up');
		}
		else if (it.key != null) { this.gs.keys |= (1 << it.key); this._sfx(it.snd, 'key'); }
		else if (it.complete) {
			// Spear of Destiny: GetBonus sets playstate = ex_completed, so picking it
			// up ends the floor. Deferred by a tick so the caller can still retire the
			// sprite before the level tears down.
			this._sfx(it.snd, 'treasure');
			var self = this;
			setTimeout(function () { self._completeFloor('floor'); }, 0);
		}
		else if (it.points != null) { this._givePoints(it.points); if (it.treasure) this._stats.treasureFound++; this._sfx(it.snd, 'treasure'); }
		else return false;
		return true;
	};

	// Play an FM effect if we have AUDIOT, otherwise fall back to the synthesised
	// stand-in. `fx` is an index into AUDIOT's sound-effect table.
	Game.prototype._sfx = function (fx, fallback) {
		if (this.music && fx != null && this.music.playSfx(fx)) return;
		if (this.sound && this.sound.sfx && fallback) this.sound.sfx(fallback);
	};

	Game.prototype._heal = function (n) { this.gs.health = Math.min(100, this.gs.health + n); };
	// Effective keys the player holds — god mode counts as carrying every key.
	Game.prototype._effKeys = function () { return this.gs.godmode ? 0xff : this.gs.keys; };
	Game.prototype._giveAmmo = function (n) {
		var gs = this.gs;
		if (gs.ammo === 0) gs.weapon = gs.chosen;   // knife was out: switch back
		gs.ammo = Math.min(99, gs.ammo + n);
	};
	Game.prototype._giveWeapon = function (w) {
		this._giveAmmo(6);
		this.gs.have[w] = true; this.gs.weapon = this.gs.chosen = w;
	};

	// Death handling, as the original does it (wl_game.cpp): lives is decremented
	// first, and you respawn as long as it stays above -1 — so you really do keep
	// playing while the bar shows 0 lives, and the *next* death ends the game.
	// A respawn also costs you your good weapons and spare ammo (back to the
	// pistol and STARTAMMO); the score is kept.
	Game.prototype._respawn = function () {
		var gs = this.gs;
		gs.lives -= 1;
		if (gs.lives < 0) { this._gameOver(); return; }

		gs.health = 100;
		gs.ammo = gs.infiniteAmmo ? 99 : STARTAMMO;
		gs.have = gs.allWeapons ? [true, true, true, true] : [true, true, false, false];
		gs.weapon = gs.chosen = WP.PISTOL;
		gs.dead = false; gs.damageFlash = 0;
		this.startLevel(this._levelIndex);
	};

	// Out of lives: freeze on a GAME OVER screen until the player acknowledges it,
	// then hand back to the menu (main.js supplies onGameOver).
	Game.prototype._gameOver = function () {
		var gs = this.gs;
		gs.lives = 0;          // never display -1
		gs.dead = true;        // keep the world frozen
		gs.gameOver = true;
		gs.respawn = 0;
		this._gameOverReady = false;
	};

	// ---- Doors -------------------------------------------------------------

	// ---- Areas ---------------------------------------------------------------
	// The original does not do line-of-sight or noise propagation by hand: every floor
	// tile carries the number of the room it belongs to (plane0 >= AREATILE), each door
	// joins two of them, and `areaconnect` counts the OPEN doors between any pair. From
	// the player's room a recursive flood then marks every room currently reachable
	// through open doors — and an actor in a room that is NOT marked is deaf and blind
	// to you, no matter how close he is. Doors connect the moment they *start* opening
	// and disconnect only once they are shut all the way, which is why firing just after
	// walking through a door still wakes the room behind it.
	Game.prototype._buildAreas = function () {
		var lvl = this.level, w = lvl.width, h = lvl.height;
		this.areaOf = new Int8Array(w * h);
		for (var i = 0; i < w * h; i++) {
			var t = lvl.plane0[i];
			this.areaOf[i] = (t >= AREATILE && t < AREATILE + NUMAREAS) ? (t - AREATILE) : -1;
		}

		// Which two rooms each door joins.
		var self = this;
		this.doors.forEach(function (d, key) {
			var x = key % w, y = (key / w) | 0;
			if (RC.helpers.doorVertical(d.tile)) {          // slab runs N-S: rooms east/west
				d.a1 = self._areaAt(x + 1, y);
				d.a2 = self._areaAt(x - 1, y);
			} else {                                        // rooms north/south
				d.a1 = self._areaAt(x, y - 1);
				d.a2 = self._areaAt(x, y + 1);
			}
			d.linked = false;
		});

		this.areaConnect = new Uint8Array(NUMAREAS * NUMAREAS);
		this.areaByPlayer = new Uint8Array(NUMAREAS);
		this._playerArea = this._areaAt(this.player.x | 0, this.player.y | 0);
		this._connectAreas();
	};

	Game.prototype._areaAt = function (tx, ty) {
		if (!this.areaOf || tx < 0 || ty < 0 || tx >= this.level.width || ty >= this.level.height) return -1;
		return this.areaOf[ty * this.level.width + tx];
	};

	// RecursiveConnect: flood out from the player's room through every open door.
	Game.prototype._connectAreas = function () {
		var seen = this.areaByPlayer;
		seen.fill(0);
		var start = this._playerArea;
		if (start < 0) return;                              // standing in a doorway: keep quiet
		seen[start] = 1;
		var stack = [start];
		while (stack.length) {
			var a = stack.pop();
			for (var b = 0; b < NUMAREAS; b++) {
				if (this.areaConnect[a * NUMAREAS + b] && !seen[b]) {
					seen[b] = 1;
					stack.push(b);
				}
			}
		}
	};

	// A door joins its two rooms while it is anything other than fully shut.
	Game.prototype._linkDoor = function (d, on) {
		if (!!d.linked === !!on) return;
		if (d.a1 == null || d.a1 < 0 || d.a2 == null || d.a2 < 0) { d.linked = !!on; return; }
		var step = on ? 1 : -1;
		this.areaConnect[d.a1 * NUMAREAS + d.a2] += step;
		this.areaConnect[d.a2 * NUMAREAS + d.a1] += step;
		d.linked = !!on;
		this._connectAreas();
	};

	// The player's own room, tracked as he walks. A doorway itself belongs to no room,
	// so we keep the last one he was properly in.
	Game.prototype._updatePlayerArea = function () {
		var a = this._areaAt(this.player.x | 0, this.player.y | 0);
		if (a < 0 || a === this._playerArea) return;
		this._playerArea = a;
		this._connectAreas();
	};

	// Play a positional sound effect attenuated by distance to the player.
	Game.prototype._sfxAt = function (cx, cy, idx, base) {
		if (!this.sound || !DIGI || idx == null) return;
		var p = this.player, dx = (cx + 0.5) - p.x, dy = (cy + 0.5) - p.y;
		var dist = Math.sqrt(dx * dx + dy * dy);
		this.sound.play(idx, (base || 1) * Math.max(0.12, 1 - dist / 18));
	};
	// Cardinal direction the player faces: {dx, dy, ew} (ew = east/west, needed
	// because the elevator switch only works when facing east or west).
	Game.prototype._faceDir = function () {
		var p = this.player;
		if (Math.abs(p.dirX) >= Math.abs(p.dirY))
			return p.dirX >= 0 ? { dx: 1, dy: 0, ew: true } : { dx: -1, dy: 0, ew: true };
		return p.dirY >= 0 ? { dx: 0, dy: 1, ew: false } : { dx: 0, dy: -1, ew: false };
	};

	// "Use" the tile directly ahead: push a secret wall, ride the elevator, or
	// open a door — mirroring the original Cmd_Use priority.
	Game.prototype._use = function () {
		var lvl = this.level, w = lvl.width, d = this._faceDir();
		var cx = (this.player.x | 0) + d.dx, cy = (this.player.y | 0) + d.dy;
		if (cx < 0 || cy < 0 || cx >= w || cy >= lvl.height) return;
		var idx = cy * w + cx, t0 = lvl.plane0[idx], t1 = lvl.plane1[idx];

		if (t1 === PUSHABLE && isWall(t0) && !this.pushwall) { this._startPushwall(cx, cy, d); return; }
		if (t0 === ELEVATOR && d.ew) { this._rideElevator(cx, cy); return; }
		if (isDoor(t0)) this._openDoor(this.doors.get(idx), true);
	};

	Game.prototype._openDoor = function (d, announce) {
		if (!d) return;
		if (d.lock >= 1 && d.lock <= 4 && !(this._effKeys() & (1 << (d.lock - 1)))) {
			if (announce) { this._lockMsg = 1.4; this._sfx(FX.NOWAY, 'locked'); }   // locked: needs the matching key
			return;
		}
		if (d.state === 'closed' || d.state === 'closing') {
			d.state = 'opening';
			this._linkDoor(d, true);   // "just starting to open, so connect the areas"
			this._sfxAt(d.cx, d.cy, DIGI.OPENDOOR, 0.85);
		}
	};

	// --- Elevator (level exit) ---------------------------------------------
	// The status bar shows the floor WITHIN the episode (mapon+1 => 1..10), like the
	// original — not the absolute index, which would count up to 60 and make the first
	// floor of episode 4 read as "31".
	// Which of the 27 tracks belongs to a floor (songs[] in wl_play.cpp).
	Game.prototype._songFor = function (index) {
		var i = (index == null) ? this._levelIndex : index;
		return SONGS[i % SONGS.length];
	};

	Game.prototype._floorNumber = function (index) {
		var i = (index == null) ? this._levelIndex : index;
		return (i % EPISODE_FLOORS) + 1;
	};

	Game.prototype._episodeNumber = function (index) {
		var i = (index == null) ? this._levelIndex : index;
		return ((i / EPISODE_FLOORS) | 0) + 1;
	};

	// "E3 F9". Anything that shows a position in the game uses this — the raw level
	// index is a storage detail and must never reach the player (a save on level index
	// 52 used to be listed as "Floor 53", which is not a floor that exists).
	// GivePoints: every EXTRAPOINTS the player earns an extra man, exactly as the
	// original does — the threshold walks up with the score, so a single fat pickup
	// can hand out more than one life.
	var EXTRAPOINTS = 40000;
	Game.prototype._givePoints = function (pts) {
		var gs = this.gs;
		if (!gs || !pts) return;
		gs.score += pts;
		if (gs.nextExtra == null) gs.nextExtra = EXTRAPOINTS;
		while (gs.score >= gs.nextExtra) {
			gs.nextExtra += EXTRAPOINTS;
			if (gs.lives < 9) gs.lives++;            // GiveExtraMan
			this._sfx(FX.BONUS1UP, 'bonus');
		}
	};

	// LevelCompleted's payout: PAR_AMOUNT per whole second saved against the floor's
	// par time, plus PERCENT100AMT for each category finished at 100%. A par of 0
	// (boss and secret floors) means no time bonus is on offer.
	Game.prototype._parSeconds = function (index) {
		if (!PAR_TIMES) return 0;
		var i = (index == null) ? this._levelIndex : index;
		var mins = PAR_TIMES[i];
		return (typeof mins === 'number' && mins > 0) ? mins * 60 : 0;
	};

	Game.prototype._awardEndOfFloorBonus = function () {
		var st = this._stats;
		if (!st) return;
		var pct = function (got, total) { return total > 0 ? ((got * 100 / total) | 0) : 0; };
		var par = this._parSeconds();
		var left = 0;
		if (par > 0 && this._levelTime < par) left = (par - this._levelTime) | 0;
		var bonus = left * PAR_AMOUNT;
		if (pct(st.kills, st.enemies) >= 100) bonus += PERCENT100AMT;
		if (pct(st.secretsFound, st.secretsTotal) >= 100) bonus += PERCENT100AMT;
		if (pct(st.treasureFound, st.treasureTotal) >= 100) bonus += PERCENT100AMT;
		st.timeLeft = left;
		st.parSeconds = par;
		st.elapsed = this._levelTime | 0;
		st.bonus = bonus;
		if (bonus) this._givePoints(bonus);
	};

	Game.prototype._floorLabel = function (index) {
		// Wolfenstein is six episodes of ten floors, so its labels are "E# F#".
		// Spear is one continuous 21-floor campaign and is numbered straight
		// through, exactly as the game itself counts it.
		if (!EPISODES) return 'Floor ' + this._floorNumber(index);
		return 'E' + this._episodeNumber(index) + ' F' + this._floorNumber(index);
	};

	Game.prototype._rideElevator = function (cx, cy) {
		if (this._levelDone) return;
		var lvl = this.level, w = lvl.width;
		lvl.plane0[cy * w + cx] = ELEVATOR + 1;      // flip the switch texture
		// Standing on the alternate elevator floor tile takes you to the secret floor
		// instead of the next one (ex_secretlevel).
		var under = lvl.plane0[(this.player.y | 0) * w + (this.player.x | 0)];
		this._completeFloor((SECRET_WARP && under === ALT_ELEVATOR) ? 'secret' : 'floor');
	};

	// A_StartDeathCam. The camera jumps to where you were standing when you landed the
	// killing blow, turns to face the boss, and then backs away along that line until it
	// is no longer inside a wall — so you get a clean view of him going down. Control is
	// frozen; the floor ends when his death animation finishes.
	Game.prototype._startDeathCam = function (boss) {
		if (this._deathCam > 0) return;
		var p = this.player;
		var ang = Math.atan2(boss.y - p.y, boss.x - p.x);   // from the kill spot, toward him
		var dx = Math.cos(ang), dy = Math.sin(ang);

		var dist = 1.25, cx = p.x, cy = p.y;                // 0x14000
		for (var i = 0; i < 96; i++) {
			var tx = boss.x - dx * dist, ty = boss.y - dy * dist;
			if (this._solid(tx, ty)) break;                 // gone too far: keep the last good spot
			cx = tx; cy = ty;
			dist += 0.0625;                                 // 0x1000
		}
		p.x = cx; p.y = cy;
		this.setAngle(ang);
		// Long enough to cover the replay: a beat on the freeze-frame (100 tics) plus his
		// death animation all over again.
		this._deathCam = 2.6;
	};

	// Walking onto the exit tile ends the episode. This is how the Hans and Gretel
	// floors finish (they have no death-cam): kill the boss, take his gold key, unlock
	// the door and step out of the castle — VictoryTile() spawns the BJ victory run,
	// which is where his one and only line comes from.
	Game.prototype._checkExit = function () {
		if (this._levelDone || !this.level) return;
		var lvl = this.level;
		var t1 = lvl.plane1[(this.player.y | 0) * lvl.width + (this.player.x | 0)];
		if (t1 !== EXITTILE || this._bjRun) return;
		// VictoryTile(): B.J. himself runs out of the castle and jumps. The floor is won
		// when he lands (T_BJDone) — the yell comes from him, not from us.
		this._bjRun = true;
		if (this.ai) this.ai.spawnBJ(this.player.x, this.player.y);
	};

	// Where to go next. Floors are grouped per episode (10 each: 8 normal, then the
	// boss floor, then the secret floor), and progression is NOT simply +1:
	//   'floor'   — the elevator: next floor in this episode
	//   'secret'  — the alternate elevator: jump to the episode's secret floor
	//   'victory' — the boss is down / you left the castle: the EPISODE is over.
	//               (Going +1 from the boss floor is what used to drop you into the
	//               Pac-Man secret level.)
	// Leaving the secret floor returns you to ElevatorBackTo[episode].
	Game.prototype._completeFloor = function (mode) {
		if (this._levelDone || this._doneWait > 0) return;
		var count = this.data.levels.length;
		var ep = (this._levelIndex / EPISODE_FLOORS) | 0;
		var floor = this._levelIndex % EPISODE_FLOORS;
		var next;

		if (mode === 'victory') {
			// Wolfenstein rolls on into the next episode. Spear is a single campaign:
			// once it is won there is nowhere left to go, so the run ends and the menu
			// comes back instead of dumping you on floor 1 again.
			if (!EPISODES) { this._campaignDone = true; next = this._levelIndex; }
			else next = ((ep + 1) * EPISODE_FLOORS) % count;
		} else if (SECRET_MAP) {
			// Spear routes its two bonus floors by map number rather than by an
			// episode slot: the hidden elevator on map 3 leads to map 18 and the one
			// on map 11 to map 19, and each drops you back on the floor after the one
			// you left (wl_game.cpp, FROMSECRET1 / FROMSECRET2).
			if (mode === 'secret' && SECRET_MAP.to[this._levelIndex] != null) {
				next = SECRET_MAP.to[this._levelIndex];
			} else if (SECRET_MAP.back[this._levelIndex] != null) {
				next = SECRET_MAP.back[this._levelIndex];
			} else {
				next = this._levelIndex + 1;
			}
		} else if (floor === 9) {
			// Order matters, and it is the original's: being ON the secret floor is
			// checked BEFORE the secret exit, so leaving floor 10 always drops you
			// back into the episode — even through an alternate elevator.
			next = ep * EPISODE_FLOORS + ELEVATOR_BACK_TO[ep % ELEVATOR_BACK_TO.length];
		} else if (mode === 'secret') {
			next = ep * EPISODE_FLOORS + 9;
		} else {
			next = ep * EPISODE_FLOORS + floor + 1;
		}

		// A flat campaign has no wrap-around: running past its last floor by any
		// route (boss, elevator, exit tile) means the run is simply over.
		if (!EPISODES && (this._campaignDone || next >= count)) {
			this._campaignDone = true;
			next = this._levelIndex;
		}

		this._awardEndOfFloorBonus();
		this._pendingLevel = next % count;
		this._episodeDone = (mode === 'victory');

		// The elevator — and ONLY the elevator — plays LEVELDONESND, and Cmd_Use then
		// calls SD_WaitSoundDone(): the game sits frozen with the switch thrown until
		// the sound has played out, and only then does the intermission come up. The
		// boss and exit-tile endings have their own business and play nothing here.
		if (mode === 'floor' || mode === 'secret') {
			var wait = 0;
			if (this.sound && DIGI) {
				this.sound.play(DIGI.LEVELDONE, 0.9);
				wait = this.sound.duration(DIGI.LEVELDONE);
			}
			if (wait > 0) { this._doneWait = wait; return; }   // hold, world frozen
		}
		this._showStats();
	};

	Game.prototype._showStats = function () {
		this._doneWait = 0;
		this._levelDone = 1;             // show the floor-stats screen
		this._levelDoneReady = false;    // require the "use" key to be released first
	};

	// Place a collectable item on a tile while the level is running (the original's
	// PlaceItemType). Used for the gold key Hans and Gretel leave behind.
	Game.prototype._dropPickup = function (tx, ty, code) {
		if (!this.level || !PICKUP[code]) return null;
		var idx = ty * this.level.width + tx;
		if (this.pickups.has(idx)) return null;              // something is already lying there
		var spr = { x: tx + 0.5, y: ty + 0.5, sprite: SPR_STAT_0 + (code - STAT_FIRST) };
		this.staticSprites.push(spr);
		this.rc.sprites.push(spr);
		this.pickups.set(idx, { code: code, spr: spr });
		if (PICKUP[code].treasure) this._stats.treasureTotal++;
		return spr;
	};

	// --- Pushwall (secret chamber) -----------------------------------------
	// Can a pushwall move into (tx,ty)? Blocked by walls, doors, actors, bounds.
	Game.prototype._pushBlocked = function (tx, ty) {
		var lvl = this.level, w = lvl.width;
		if (tx < 0 || ty < 0 || tx >= w || ty >= lvl.height) return true;
		var t = lvl.plane0[ty * w + tx];
		if (isWall(t) || isDoor(t)) return true;
		if (this.ai && this.ai.occAt(tx, ty)) return true;
		return false;
	};

	Game.prototype._startPushwall = function (cx, cy, d) {
		if (this._pushBlocked(cx + d.dx, cy + d.dy)) {           // nowhere to slide
			if (this.sound && DIGI) this._sfxAt(cx, cy, DIGI.SLURPIE, 0.5);
			return;
		}
		var lvl = this.level, w = lvl.width, idx = cy * w + cx;
		this.pushwall = { ax: cx, ay: cy, dx: d.dx, dy: d.dy, dist: 0, tile: lvl.plane0[idx], max: 2 };
		lvl.plane0[idx] = 0;          // vacate the origin cell (now floor)
		lvl.plane1[idx] = 0;          // remove the pushable marker
		this._stats.secretsFound++;
		this._sfxAt(cx, cy, DIGI.PUSHWALL, 0.9);
	};

	Game.prototype._updatePushwall = function (dt) {
		var pw = this.pushwall; if (!pw) return;
		var lvl = this.level, w = lvl.width;
		var prev = pw.dist;
		pw.dist += dt * PUSH_SPEED;
		// entering the second tile: make sure the far cell is free, else stop at one
		if (prev < 1 && pw.dist >= 1 && pw.max > 1) {
			if (this._pushBlocked(pw.ax + pw.dx * 2, pw.ay + pw.dy * 2)) {
				lvl.plane0[(pw.ay + pw.dy) * w + (pw.ax + pw.dx)] = pw.tile;
				this.pushwall = null; return;
			}
		}
		if (pw.dist >= pw.max) {
			var fx = pw.ax + pw.dx * pw.max, fy = pw.ay + pw.dy * pw.max;
			lvl.plane0[fy * w + fx] = pw.tile;   // wall settles in its final cell
			this.pushwall = null;
		}
	};

	Game.prototype._updateDoors = function (dt) {
		var p = this.player, pcx = p.x | 0, pcy = p.y | 0;
		var self = this;
		this.doors.forEach(function (d, key) {
			var cx = key % self.level.width, cy = (key / self.level.width) | 0;
			if (d.state === 'opening') {
				d.open += dt / self.doorOpenTime;
				if (d.open >= 1) { d.open = 1; d.state = 'open'; d.timer = self.doorStayTime; }
			} else if (d.state === 'open') {
				d.timer -= dt;
				// A door never closes on anything standing in it — the player, a live
				// actor, or a corpse. In the original, CloseDoor() simply bails out if
				// actorat[] holds anything, and a body keeps re-marking its tile, so a
				// soldier shot in a doorway props it open for good.
				var blocked = (cx === pcx && cy === pcy) ||
					!!(self.ai && self.ai.occAt(cx, cy));
				if (d.timer <= 0 && !blocked) {
					d.state = 'closing';
					self._sfxAt(cx, cy, DIGI.CLOSEDOOR, 0.85);
				}
			} else if (d.state === 'closing') {
				d.open -= dt / self.doorOpenTime;
				if (d.open <= 0) {
					d.open = 0; d.state = 'closed';
					self._linkDoor(d, false);   // "closed all the way, so disconnect the areas"
				}
			}
		});
	};

	// ---- Movement / collision ---------------------------------------------

	Game.prototype._solid = function (x, y) {
		var mx = x | 0, my = y | 0;
		if (mx < 0 || my < 0 || mx >= this.level.width || my >= this.level.height) return true;
		var t = this.level.plane0[my * this.level.width + mx];
		if (isWall(t)) return true;
		if (isDoor(t)) { var d = this.doors.get(my * this.level.width + mx); return !d || d.open < 0.85; }
		if (this.pushwall) {
			var pw = this.pushwall, f = Math.floor(pw.dist);
			var ax = pw.ax + pw.dx * f, ay = pw.ay + pw.dy * f;   // the two cells it currently overlaps
			if ((mx === ax && my === ay) || (mx === ax + pw.dx && my === ay + pw.dy)) return true;
		}
		if (this.ai) { var a = this.ai.occAt(mx, my); if (a && a.flags.shootable) return true; }
		if (this.solidObjects && this.solidObjects.has(my * this.level.width + mx)) return true;
		return false;
	};

	Game.prototype._tryMove = function (nx, ny) {
		var p = this.player, r = 0.22;
		// Axis-separated so we can slide along walls.
		if (!this._solid(nx + Math.sign(nx - p.x) * r, p.y) && !this._solid(nx, p.y + r) && !this._solid(nx, p.y - r)) {
			// If blocked only by a closed door ahead, auto-open it.
			p.x = nx;
		} else { this._autoOpenAhead(nx, p.y); }
		if (!this._solid(p.x, ny + Math.sign(ny - p.y) * r) && !this._solid(p.x + r, ny) && !this._solid(p.x - r, ny)) {
			p.y = ny;
		} else { this._autoOpenAhead(p.x, ny); }
	};

	Game.prototype._autoOpenAhead = function (x, y) {
		var mx = x | 0, my = y | 0;
		this._openDoor(this.doors.get(my * this.level.width + mx), true);
	};

	// ---- Main loop ---------------------------------------------------------

	// The frame driver. A thrown exception used to skip the requestAnimationFrame
	// call at the end and freeze the game for good (you could only escape via the
	// menu). Now the frame body is guarded: an error is reported and the loop
	// keeps running, so one bad frame can't kill the session.
	Game.prototype._loop = function (now) {
		var dt = Math.max(0, Math.min(0.05, (now - this._last) / 1000));
		this._last = now;
		try {
			this._frame(dt);
		} catch (e) {
			if (typeof console !== 'undefined') console.error('[uWolf] frame error:', e);
			this.toast('Frame error: ' + (e && e.message ? e.message : e));
		}
		if (this.running) requestAnimationFrame(this._loop.bind(this));
	};

	Game.prototype._frame = function (dt) {
		var p = this.player, k = this.keys, gs = this.gs;
		var frozen = gs.dead || this._levelDone > 0 || this._doneWait > 0 || this._deathCam > 0 || this._bjRun;

		// Out of lives: hold the GAME OVER screen until the player acknowledges.
		if (gs.gameOver) {
			var goHeld = !!(k['Space'] || k['Enter'] || k['NumpadEnter'] || k['KeyE']);
			var goTap = this._continueTap; this._continueTap = false;
			if (!goHeld && !goTap) this._gameOverReady = true;   // wait for release first
			if (this._gameOverReady && (goHeld || goTap)) {
				this.running = false;
				if (this.onGameOver) this.onGameOver();
				return;
			}
			this.rc.render(p);
			this._drawHUD();
			return;
		}

		if (this._levelDone <= 0 && !this._doneWait) this._levelTime += dt;

		// Elevator: hold the floor-stats screen until the player presses a key/taps.
		if (this._levelDone > 0) {
			var held = !!(k['Space'] || k['Enter'] || k['NumpadEnter'] || k['KeyE']);
			var tap = this._continueTap; this._continueTap = false;
			if (!held && !tap) this._levelDoneReady = true;      // wait for release first
			if (this._levelDoneReady && (held || tap)) {
				if (this._campaignDone) {                        // nothing left to play
					this._campaignDone = false;
					this.clearRun();
					this.exitToMenu();
					return;
				}
				this.startLevel(this._pendingLevel);
				this.autosave();
				return;                                          // _loop reschedules
			}
		}

		var forward = 0, strafe = 0, turn = 0;
		if (!frozen) {
			if (k['KeyW'] || k['ArrowUp']) forward += 1;
			if (k['KeyS'] || k['ArrowDown']) forward -= 1;
			if (k['KeyA']) strafe -= 1;
			if (k['KeyD']) strafe += 1;
			if (k['ArrowLeft']) turn -= 1;
			if (k['ArrowRight']) turn += 1;

			// On-screen D-pad: laid out like the original's arrow keys — up/down walk,
			// left/right turn.
			var pad = this.touch.pad;
			if (pad.fwd) forward += 1;
			if (pad.back) forward -= 1;
			if (pad.left) turn -= 1;
			if (pad.right) turn += 1;
		}

		if (turn) {
			// Reversing direction restarts the ease-in, so flicking left-right keeps
			// the same fine control as a fresh tap.
			if (turn !== this._turnSign) { this._turnRamp = this.turnRampMin; this._turnSign = turn; }
			else this._turnRamp = Math.min(1, this._turnRamp + this.turnRampRate * dt);
			this.setAngle(p.angle + turn * this.turnSpeed * this._turnRamp * dt);
		} else {
			this._turnRamp = this.turnRampMin;
			this._turnSign = 0;
		}

		this._playerMoving = false;
		if (forward || strafe) {
			var mag = Math.hypot(forward, strafe) || 1;
			var mvx = (p.dirX * forward + (-p.dirY) * strafe) / mag * this.moveSpeed * dt;
			var mvy = (p.dirY * forward + (p.dirX) * strafe) / mag * this.moveSpeed * dt;
			this._tryMove(p.x + mvx, p.y + mvy);
			this._playerMoving = true;
		}
		this._checkPickup();
		this._checkExit();
		if (this._lockMsg > 0) this._lockMsg -= dt;

		if (this._doneWait > 0) {
			this._doneWait -= dt;
			if (this._doneWait <= 0) this._showStats();
		}
		this._updatePlayerArea();
		this._updateDoors(dt);
		this._updatePushwall(dt);
		this._updateCombat(dt);
		if (this._toast && this._toast.t > 0) this._toast.t -= dt;
		if (this._deathCam > 0) this._deathCam = Math.max(0, this._deathCam - dt);
		this.rc.pushwall = this.pushwall;
		this.rc.render(p);
		this._drawHUD();
		if (this.showMap) this._drawMinimap();
	};

	// ---- HUD ---------------------------------------------------------------

	// Drawn onto the 3D canvas after the scene. The player's POV weapon comes
	// from VSWAP sprite pages (ready + four attack frames per weapon).
	Game.prototype._drawWeapon = function (ctx, W, H, barH) {
		var gs = this.gs;
		if (gs.dead) return;
		var frame = 0;
		if (gs.wpnAnimT > 0 && gs.wpnAnimDur > 0) {
			var prog = 1 - gs.wpnAnimT / gs.wpnAnimDur;       // 0..1 through the shot
			frame = 1 + Math.min(3, (prog * 4) | 0);          // atk1..atk4
		}
		var page = WEAPON_BASE[gs.weapon] + frame;
		var img;
		try { img = this.data.getSpriteCanvas(page); } catch (e) { return; }
		if (!img) return;
		var size = Math.min(W, H * 1.1) * 0.62;
		var bobX = Math.sin(gs.bob) * size * 0.02;
		var bobY = Math.abs(Math.cos(gs.bob)) * size * 0.03;
		var dx = (W - size) / 2 + bobX;
		var dy = (H - barH) - size + bobY;                  // sit just above the bar
		ctx.save();
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(img, 0, 0, 64, 64, dx, dy, size, size);
		ctx.restore();
	};

	Game.prototype._drawHUD = function () {
		var ctx = this.rc.ctx, W = this.canvas.width, H = this.canvas.height, gs = this.gs;
		if (!ctx) return;
		var vga = this.data && this.data.vga;
		var barH = vga ? Math.round(W / 320 * 40) : Math.max(18, H * 0.075);

		if (gs.damageFlash > 0) {
			ctx.save(); ctx.globalAlpha = Math.min(0.6, gs.damageFlash); ctx.fillStyle = '#b00000';
			ctx.fillRect(0, 0, W, H); ctx.restore();
		}

		this._drawWeapon(ctx, W, H, barH);

		// crosshair
		var cx = W / 2, cy = H / 2, s = Math.max(4, W / 55);
		ctx.save();
		ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = Math.max(1, W / 400);
		ctx.beginPath();
		ctx.moveTo(cx - s, cy); ctx.lineTo(cx - s * 0.35, cy);
		ctx.moveTo(cx + s * 0.35, cy); ctx.lineTo(cx + s, cy);
		ctx.moveTo(cx, cy - s); ctx.lineTo(cx, cy - s * 0.35);
		ctx.moveTo(cx, cy + s * 0.35); ctx.lineTo(cx, cy + s);
		ctx.stroke(); ctx.restore();

		if (vga) this._drawStatusBarVGA(ctx, W, H, barH, vga);
		else this._drawStatusBarCanvas(ctx, W, H, barH);

		if (this._lockMsg > 0 && !gs.dead && !(this._levelDone > 0)) {
			ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			ctx.fillStyle = '#ffd24a'; ctx.font = 'bold ' + Math.max(12, H * 0.05) + 'px monospace';
			ctx.fillText('THE DOOR IS LOCKED \u2014 FIND THE KEY', W / 2, H - barH - H * 0.06);
			ctx.restore();
		}

		if (gs.gameOver) {
			ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			ctx.globalAlpha = 0.72; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
			ctx.globalAlpha = 1;
			ctx.fillStyle = '#c0392b';
			ctx.font = 'bold ' + Math.max(20, H * 0.12) + 'px monospace';
			ctx.fillText('GAME OVER', cx, H * 0.42);
			ctx.fillStyle = '#d8d8d8';
			ctx.font = 'bold ' + Math.max(10, H * 0.035) + 'px monospace';
			ctx.fillText('SCORE ' + gs.score + '  ·  ' + this._floorLabel(), cx, H * 0.56);
			ctx.fillStyle = '#8a8a8a';
			ctx.font = Math.max(9, H * 0.028) + 'px monospace';
			ctx.fillText('press space / tap to continue', cx, H * 0.66);
			ctx.restore();
		} else if (gs.dead) {
			ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.max(16, H * 0.09) + 'px monospace';
			ctx.fillText('DEAD', cx, (H - barH) / 2); ctx.restore();
		}

		// The original fades out and prints this before replaying the kill; we keep the
		// line, since it is half the charm of the death cam.
		if (this._deathCam > 0) {
			ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			ctx.globalAlpha = Math.min(1, this._deathCam);
			ctx.fillStyle = '#ffd24a';
			ctx.font = 'bold ' + Math.max(13, H * 0.05) + 'px monospace';
			ctx.fillText("LET'S SEE THAT AGAIN!", W / 2, H * 0.16);
			ctx.restore();
		}

		// Toast (save/load feedback, error reports) — shown even while dead.
		if (this._toast && this._toast.t > 0) {
			ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			ctx.globalAlpha = Math.min(1, this._toast.t);
			ctx.font = 'bold ' + Math.max(11, H * 0.035) + 'px monospace';
			var tw = ctx.measureText(this._toast.msg).width + W * 0.05;
			var th = H * 0.06, tx = (W - tw) / 2, ty = H - barH - th - H * 0.03;
			ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(tx, ty, tw, th);
			ctx.fillStyle = '#ffd24a';
			ctx.fillText(this._toast.msg, W / 2, ty + th / 2);
			ctx.restore();
		}

		if (!gs.dead && this._levelDone > 0) {
			var st = this._stats || { floor: this._floorNumber(), enemies: 0, kills: 0, secretsTotal: 0, secretsFound: 0, treasureTotal: 0, treasureFound: 0 };
			var pct = function (a, b) { return b > 0 ? Math.round(a * 100 / b) : 100; };
			ctx.save();
			ctx.fillStyle = '#0b0b0b'; ctx.fillRect(0, 0, W, H);   // solid intermission screen
			ctx.textBaseline = 'middle';
			var cyC = H / 2;

			// Everything on this screen is laid out from the block's ACTUAL height
			// rather than from fixed offsets. The rows are variable now — TIME and
			// BONUS only appear when they apply — and the old fixed positions ran the
			// SCORE line straight into the "press a key" prompt once six rows showed.
			var titleSize = Math.max(16, H * 0.075);
			var lineSize = Math.max(11, H * 0.045);
			var promptSize = Math.max(10, H * 0.038);

			// Title text.
			var title;
			if (this._episodeDone) {
				if (EPISODES) {
					title = 'EPISODE ' + this._episodeNumber() + ' COMPLETE';
				} else {
					var vn = (root.WolfVariant && root.WolfVariant.active) ? root.WolfVariant.active.name : 'MISSION';
					title = vn.toUpperCase() + ' COMPLETE';
				}
			} else {
				title = 'FLOOR ' + st.floor + ' COMPLETE';
			}

			// The stats are laid out in fixed character columns and drawn LEFT-aligned
			// from a common origin. Centring each row as one string makes every column
			// drift, because the rows differ in length.
			ctx.font = 'bold ' + lineSize + 'px monospace';
			var charW = ctx.measureText('0').width;          // monospace: every glyph is this wide
			var LBL = 9, GOT = 3, SEP = 3, TOT = 3, PCT = 6; // column widths, in characters
			var lineChars = LBL + GOT + SEP + TOT + PCT;
			var x0 = W / 2 - (lineChars * charW) / 2;
			var pctX = x0 + (LBL + GOT + SEP + TOT) * charW; // where the percentage column starts

			var mmss = function (sec) {
				sec = Math.max(0, sec | 0);
				return ((sec / 60) | 0) + ':' + ('0' + (sec % 60)).slice(-2);
			};

			// Collect the lines first; the layout follows from how many there are.
			var lines = [];
			var statRows = [
				['KILL', st.kills, st.enemies],
				['SECRET', st.secretsFound, st.secretsTotal],
				['TREASURE', st.treasureFound, st.treasureTotal]
			];
			for (var ri = 0; ri < statRows.length; ri++) {
				var p = pct(statRows[ri][1], statRows[ri][2]);
				lines.push({
					text: padR(statRows[ri][0], LBL) + padL(statRows[ri][1], GOT) + ' / ' + padL(statRows[ri][2], TOT),
					color: '#fff',
					// a clean 100% is worth calling out, as the original does with its bonus
					text2: padL(p + '%', PCT), x2: pctX, color2: (p === 100) ? '#ffd24a' : '#fff'
				});
			}
			if (st.elapsed != null) {
				lines.push({
					text: padR('TIME', LBL) + mmss(st.elapsed) + (st.parSeconds ? '  PAR ' + mmss(st.parSeconds) : ''),
					color: (st.parSeconds && st.timeLeft > 0) ? '#ffd24a' : '#fff'
				});
			}
			if (st.bonus) {
				lines.push({ text: padR('BONUS', LBL) + padL(st.bonus, lineChars - LBL), color: '#ffd24a' });
			}
			lines.push({ text: padR('SCORE', LBL) + padL(this.gs.score, lineChars - LBL), color: '#fff' });

			// Line spacing shrinks if the list ever grows past what fits comfortably.
			var lineStep = Math.min(H * 0.08, Math.max(lineSize * 1.3, (H * 0.62) / lines.length));
			var titleGap = titleSize * 1.5;
			var promptGap = promptSize * 2.2;
			var blockH = titleGap + lines.length * lineStep + promptGap;
			var top = (H - blockH) / 2;

			ctx.textAlign = 'center';
			ctx.fillStyle = '#ffd24a';
			ctx.font = 'bold ' + titleSize + 'px monospace';
			ctx.fillText(title, W / 2, top + titleSize * 0.7);

			ctx.font = 'bold ' + lineSize + 'px monospace';
			ctx.textAlign = 'left';
			for (var li = 0; li < lines.length; li++) {
				var ln = lines[li], y = top + titleGap + li * lineStep + lineStep / 2;
				ctx.fillStyle = ln.color;
				ctx.fillText(ln.text, x0, y);
				if (ln.text2) { ctx.fillStyle = ln.color2; ctx.fillText(ln.text2, ln.x2, y); }
			}

			ctx.textAlign = 'center';
			ctx.fillStyle = (((Date.now() / 500) | 0) % 2) ? '#ffd24a' : 'rgba(255,210,74,0.35)';
			ctx.font = 'bold ' + promptSize + 'px monospace';
			ctx.fillText(this._levelDoneReady ? 'PRESS A KEY TO CONTINUE' : '\u2026',
				W / 2, top + blockH - promptSize * 0.7);
			ctx.restore();
		}
	};

	// The original 320x40 VGAGRAPH status bar, scaled to the canvas width, with
	// the health-driven BJ face, numeric fields, weapon and key icons.
	Game.prototype._drawStatusBarVGA = function (ctx, W, H, barH, vga) {
		var gs = this.gs, sc = W / 320, top = H - barH;
		ctx.save();
		ctx.imageSmoothingEnabled = false;
		var bar = vga.getPic(VGA.STATUSBAR);
		if (bar) ctx.drawImage(bar, 0, 0, bar.width, bar.height, 0, top, W, barH);

		var self = this;
		function pic(chunk, bx, by) {
			var img = vga.getPic(chunk);
			if (!img) return;
			ctx.drawImage(img, 0, 0, img.width, img.height,
				Math.round(bx * 8 * sc), Math.round(top + by * sc),
				Math.round(img.width * sc), Math.round(img.height * sc));
		}
		// right-aligned number in `width` byte-columns (LatchNumber)
		function num(bx, by, width, value) {
			var str = String(value);
			var pad = width - str.length, x = bx;
			for (var i = 0; i < pad; i++) { pic(VGA.N_BLANK, x, by); x++; }
			for (var c = Math.max(0, str.length - width); c < str.length; c++) {
				pic(VGA.N_0 + (str.charCodeAt(c) - 48), x, by); x++;
			}
		}

		num(2, 16, 2, this._floorNumber());                      // floor (within the episode)
		num(6, 16, 6, gs.score);                                 // score
		num(14, 16, 1, gs.lives);                                // lives
		num(21, 16, 3, gs.health);                               // health
		if (gs.infiniteAmmo) { pic(VGA.N_BLANK, 27, 16); pic(VGA.N_0 + 9, 28, 16); }
		else num(27, 16, 2, gs.ammo);                            // ammo
		pic(VGA.KNIFE + gs.weapon, 32, 8);                       // weapon
		var kb = this._effKeys();
		pic((kb & 1) ? VGA.GOLDKEY : VGA.NOKEY, 30, 4);          // gold key slot
		pic((kb & 2) ? VGA.SILVERKEY : VGA.NOKEY, 30, 20);       // silver key slot

		// BJ face: FACE1A + 3*tier + rotation; god mode tints it.
		var tier = gs.health > 0 ? Math.min(6, ((100 - Math.min(100, gs.health)) / 16) | 0) : 6;
		pic(VGA.FACE1A + 3 * tier + gs.faceframe, 17, 4);
		if (gs.godmode) {
			ctx.globalAlpha = 0.25; ctx.fillStyle = '#39f';
			ctx.fillRect(Math.round(17 * 8 * sc), Math.round(top + 4 * sc), Math.round(24 * sc), Math.round(32 * sc));
			ctx.globalAlpha = 1;
		}
		ctx.restore();
	};

	// Fallback HUD when the VGAGRAPH files are not loaded.
	Game.prototype._drawStatusBarCanvas = function (ctx, W, H, bh) {
		var gs = this.gs;
		ctx.save();
		ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, H - bh, W, bh);
		ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
		var fs = Math.max(9, bh * 0.46); ctx.font = 'bold ' + fs + 'px monospace';
		var cy2 = H - bh / 2;
		ctx.fillStyle = gs.health > 33 ? '#fff' : '#ff6a6a';
		ctx.fillText('HP ' + gs.health, W * 0.02, cy2);
		ctx.fillStyle = '#fff';
		ctx.fillText('AMMO ' + (gs.infiniteAmmo ? '\u221E' : gs.ammo), W * 0.19, cy2);
		ctx.fillText(WP_NAME[gs.weapon], W * 0.37, cy2);
		ctx.fillText('LIVES ' + gs.lives, W * 0.57, cy2);
		ctx.fillText('SCORE ' + gs.score, W * 0.73, cy2);
		if (gs.godmode) { ctx.fillStyle = '#7dff7d'; ctx.fillText('GOD', W * 0.90, cy2); }
		var kb2 = this._effKeys();
		if (kb2) {
			var kx = W * 0.90 - (gs.godmode ? W * 0.06 : 0);
			if (kb2 & 1) { ctx.fillStyle = '#ffd24a'; ctx.fillText('\u26B7', kx, cy2); }
			if (kb2 & 2) { ctx.fillStyle = '#cfe2ff'; ctx.fillText('\u26B7', kx - W * 0.03, cy2); }
		}
		ctx.restore();
	};

	// ---- Minimap -----------------------------------------------------------

	Game.prototype._drawMinimap = function () {
		var mm = this.minimap; if (!mm) return;
		var lvl = this.level, p = this.player;
		var view = 12; // cells radius
		var size = mm.width;
		var cell = size / (view * 2);
		var ctx = mm.getContext('2d');
		ctx.clearRect(0, 0, size, size);
		ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, size, size);
		var cx = p.x, cy = p.y;
		var secrets = [];
		for (var dy = -view; dy < view; dy++) {
			for (var dx = -view; dx < view; dx++) {
				var mx = (cx + dx) | 0, my = (cy + dy) | 0;
				if (mx < 0 || my < 0 || mx >= lvl.width || my >= lvl.height) continue;
				var idx = my * lvl.width + mx;
				var t = lvl.plane0[idx];
				if (isWall(t)) ctx.fillStyle = '#8a8a8a';
				else if (isDoor(t)) ctx.fillStyle = '#c8a24b';
				else continue;
				ctx.fillRect((mx - cx + view) * cell, (my - cy + view) * cell, cell + 0.5, cell + 0.5);
				// A pushable tile still carrying its marker is a secret you haven't
				// opened yet — _startPushwall() clears plane1, so found ones drop out
				// on their own. Collected here, drawn after the walls so nothing
				// paints over the dots.
				if (lvl.plane1[idx] === PUSHABLE) secrets.push([mx, my]);
			}
		}

		// Secret doors (comfort feature — the original never showed these).
		ctx.fillStyle = '#e03a2f';
		for (var si = 0; si < secrets.length; si++) {
			var sx = (secrets[si][0] - cx + view + 0.5) * cell;
			var sy = (secrets[si][1] - cy + view + 0.5) * cell;
			ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.4, cell * 0.32), 0, Math.PI * 2); ctx.fill();
		}
		// Player.
		ctx.fillStyle = '#48d048';
		ctx.beginPath(); ctx.arc(size / 2, size / 2, cell * 0.5, 0, Math.PI * 2); ctx.fill();
		ctx.strokeStyle = '#48d048'; ctx.beginPath();
		ctx.moveTo(size / 2, size / 2);
		ctx.lineTo(size / 2 + p.dirX * cell * 1.6, size / 2 + p.dirY * cell * 1.6); ctx.stroke();
	};


	// Fixed-width padding for the monospace stats columns.
	function padL(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
	function padR(s, n) { s = String(s); while (s.length < n) s = s + ' '; return s; }

	// ---- Save / load -------------------------------------------------------
	//
	// Everything runs client-side, so a save is just a JSON snapshot kept in the
	// browser's localStorage. Rather than dumping the whole level, we store the
	// *deltas* against a freshly parsed map (getLevel() re-parses on every call):
	// changed plane0 cells (settled pushwalls, the flipped elevator switch), door
	// states, which pickups are gone, and the actor list. Loading rebuilds the
	// floor from the data files and replays those deltas on top.

	var SAVE_VERSION = 1;
	var SAVE_PREFIX = 'uwolf.save.';

	Game.prototype.saveState = function () {
		if (!this.level || !this.data) return null;
		var lvl = this.level, gs = this.gs, self = this;

		// plane0 delta vs. the pristine map (pushwalls, elevator switch)
		var pristine = this.data.getLevel(this._levelIndex).plane0;
		var map = [];
		for (var i = 0; i < lvl.plane0.length; i++) {
			if (lvl.plane0[i] !== pristine[i]) map.push(i, lvl.plane0[i]);
		}

		// doors that are not sitting idle+closed
		var doors = [];
		this.doors.forEach(function (d, k) {
			if (d.open > 0 || d.state !== 'closed' || d.timer > 0) {
				doors.push([k, +d.open.toFixed(3), d.state, +d.timer.toFixed(2)]);
			}
		});

		// pickups already collected: plane1 is never mutated, so the original set
		// can be recomputed and compared against what is still on the floor.
		var taken = [];
		for (var idx = 0; idx < lvl.plane1.length; idx++) {
			if (PICKUP[lvl.plane1[idx]] && !this.pickups.has(idx)) taken.push(idx);
		}

		// Items dropped during play (the gold key from Hans / Gretel) are not in the
		// map at all, so they have to be listed explicitly or they'd vanish on load.
		var dropped = [];
		this.pickups.forEach(function (pk, i) {
			if (!PICKUP[lvl.plane1[i]]) dropped.push([i, pk.code]);
		});

		return {
			v: SAVE_VERSION,
			variant: (root.WolfVariant && root.WolfVariant.active) ? root.WolfVariant.active.id : 'WL6',
			ts: Date.now(),
			floor: this._levelIndex,
			player: { x: +this.player.x.toFixed(3), y: +this.player.y.toFixed(3), angle: +this.player.angle.toFixed(4) },
			gs: {
				health: gs.health, ammo: gs.ammo, weapon: gs.weapon, chosen: gs.chosen,
				have: gs.have.slice(), score: gs.score, lives: gs.lives, nextExtra: gs.nextExtra, keys: gs.keys,
				difficulty: gs.difficulty, godmode: gs.godmode, infiniteAmmo: gs.infiniteAmmo,
				allWeapons: gs.allWeapons
			},
			map: map,
			doors: doors,
			taken: taken,
			dropped: dropped,
			actors: this.ai ? this.ai.serialize() : [],
			pushwall: this.pushwall ? {
				ax: this.pushwall.ax, ay: this.pushwall.ay, dx: this.pushwall.dx, dy: this.pushwall.dy,
				dist: +this.pushwall.dist.toFixed(3), tile: this.pushwall.tile, max: this.pushwall.max
			} : null,
			levelTime: +(this._levelTime || 0).toFixed(2),
			stats: {
				floor: this._stats.floor, enemies: this._stats.enemies, kills: this._stats.kills,
				secretsTotal: this._stats.secretsTotal, secretsFound: this._stats.secretsFound,
				treasureTotal: this._stats.treasureTotal, treasureFound: this._stats.treasureFound
			}
		};
	};

	Game.prototype.applyState = function (st) {
		if (!st || st.v !== SAVE_VERSION) throw new Error('Unsupported save format');
		if (!this.data) throw new Error('Game data not loaded');
		// A save carries the dataset it was made in; refuse to apply a Wolfenstein
		// save onto Spear or vice versa (the slot keys already keep them apart, this
		// just guards F9/quick-load across a dataset switch).
		if (st.variant && root.WolfVariant && st.variant !== root.WolfVariant.active.id) {
			throw new Error('Save is from a different game (' + st.variant + ')');
		}

		// Difficulty decides which actors spawn, so it must be set before the
		// floor is rebuilt.
		this.resetPlayerState();
		this.gs.difficulty = st.gs.difficulty | 0;
		this.gs.godmode = !!st.gs.godmode;
		this.gs.infiniteAmmo = !!st.gs.infiniteAmmo;
		this.gs.allWeapons = !!st.gs.allWeapons;
		this.startLevel(st.floor);

		// replay the map delta (settled pushwalls / flipped elevator)
		for (var i = 0; i + 1 < st.map.length; i += 2) this.level.plane0[st.map[i]] = st.map[i + 1];

		// doors
		var self = this;
		(st.doors || []).forEach(function (d) {
			var door = self.doors.get(d[0]);
			if (!door) return;
			door.open = d[1]; door.state = d[2]; door.timer = d[3];
		});

		// remove collected pickups
		// items dropped during play (the boss's gold key) are re-placed first
		(st.dropped || []).forEach(function (d) {
			self._dropPickup(d[0] % self.level.width, (d[0] / self.level.width) | 0, d[1]);
		});

		(st.taken || []).forEach(function (idx) {
			var pk = self.pickups.get(idx);
			if (pk) { pk.spr.sprite = -1; self.pickups.delete(idx); }
		});

		if (this.ai) this.ai.restore(st.actors);

		// player + gamestate (after startLevel, which resets keys per floor)
		this.player.x = st.player.x; this.player.y = st.player.y;
		this.setAngle(st.player.angle);
		var g = st.gs, gs = this.gs;
		gs.health = g.health; gs.ammo = g.ammo; gs.weapon = g.weapon; gs.chosen = g.chosen;
		gs.have = g.have.slice(); gs.score = g.score; gs.lives = g.lives; gs.keys = g.keys;

		this.pushwall = st.pushwall || null;
		if (st.stats) this._stats = st.stats;
		// Keep the clock running across a save/load, otherwise reloading would hand
		// out a full time bonus for free.
		this._levelTime = (typeof st.levelTime === 'number') ? st.levelTime : 0;
		this._levelDone = 0;
		this._doneWait = 0;
		this._episodeDone = false;
		this._deathCam = 0;
		this._bjRun = false;
		return true;
	};

	// --- localStorage slots ---
	// Slot keys are namespaced by dataset so Wolfenstein and Spear saves never
	// share a slot. WL6 keeps its original un-suffixed keys for backward
	// compatibility; other datasets get a "<id>." segment (e.g. uwolf.save.SOD.auto).
	function slotKey(slot) {
		var v = (root.WolfVariant && root.WolfVariant.active) ? root.WolfVariant.active.id : 'WL6';
		return (v === 'WL6') ? SAVE_PREFIX + slot : SAVE_PREFIX + v + '.' + slot;
	}

	Game.prototype.saveToSlot = function (slot) {
		if (this.gs && (this.gs.dead || this.gs.gameOver)) {
			throw new Error('Cannot save while dead');   // would restore you on 0 health
		}
		var st = this.saveState();
		if (!st) throw new Error('Nothing to save');
		try {
			window.localStorage.setItem(slotKey(slot), JSON.stringify(st));
		} catch (e) {
			throw new Error('Could not write the save (storage full or blocked)');
		}
		return st;
	};

	Game.prototype.loadFromSlot = function (slot) {
		var raw;
		try { raw = window.localStorage.getItem(slotKey(slot)); } catch (e) { raw = null; }
		if (!raw) throw new Error('Save slot is empty');
		return this.applyState(JSON.parse(raw));
	};

	Game.prototype.deleteSlot = function (slot) {
		try { window.localStorage.removeItem(slotKey(slot)); } catch (e) { /* ignore */ }
	};

	// Metadata for the menu, without fully loading a save.
	Game.prototype.slotInfo = function (slot) {
		var raw;
		try { raw = window.localStorage.getItem(slotKey(slot)); } catch (e) { return null; }
		if (!raw) return null;
		try {
			var st = JSON.parse(raw);
			if (st.v !== SAVE_VERSION) return null;
			return {
				slot: slot, ts: st.ts,
				index: st.floor,                      // the absolute index is storage only
				label: this._floorLabel(st.floor),    // ...this is what a player sees
				episode: this._episodeNumber(st.floor),
				floor: this._floorNumber(st.floor),
				health: st.gs.health, score: st.gs.score, lives: st.gs.lives,
				nextExtra: st.gs.nextExtra != null ? st.gs.nextExtra : 40000,
				difficulty: st.gs.difficulty
			};
		} catch (e) { return null; }
	};

	Game.prototype.hasSave = function (slot) { return this.slotInfo(slot) != null; };

	// --- Convenience: quick save/load (F8/F9) + autosave on each new floor ---
	Game.prototype.toast = function (msg) { this._toast = { msg: msg, t: 2.0 }; };

	Game.prototype.quickSave = function () {
		if (!this.running || !this.level) return;
		if (this.gs.dead || this._levelDone > 0) { this.toast('Cannot save right now'); return; }
		try { this.saveToSlot('quick'); this.toast('Game saved (F9 to load)'); }
		catch (e) { this.toast(e.message); }
	};

	Game.prototype.quickLoad = function () {
		if (!this.data) return;
		try { this.loadFromSlot('quick'); this.toast('Game loaded'); }
		catch (e) { this.toast(e.message); }
	};

	Game.prototype.autosave = function () {
		try { this.saveToSlot('auto'); } catch (e) { /* autosave is best-effort */ }
	};

	root.WolfGame = Game;
})(typeof window !== 'undefined' ? window : this);
