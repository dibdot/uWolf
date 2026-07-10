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
	// Static decorations that block movement (from WL6 statinfo[].block): barrels,
	// tables, pillars, armour/knight, cages, wells, stove, etc. Bullets and sight
	// pass over them (the original blocks via actorat, not the wall map).
	var BLOCK_STATIC = {};
	[24, 25, 26, 28, 30, 31, 33, 34, 35, 36, 39, 40, 41, 45, 58, 59, 60, 62, 63, 68, 69]
		.forEach(function (c) { BLOCK_STATIC[c] = 1; });

	// Collectible items (plane1 code -> effect), from GetBonus. `min`/`gib` gate
	// whether the item is taken (health/ammo pickups are left if not useful).
	var PICKUP = {
		29: { health: 4 }, 47: { health: 10 }, 48: { health: 25 },   // dog food / food / first aid
		57: { gib: 1 }, 61: { gib: 1 },                               // gibs (only when nearly dead)
		49: { ammo: 8 },                                              // ammo clip
		50: { weapon: 2 }, 51: { weapon: 3 },                         // machine gun / chain gun
		52: { points: 100, treasure: 1 }, 53: { points: 500, treasure: 1 },
		54: { points: 1000, treasure: 1 }, 55: { points: 5000, treasure: 1 }, // cross/chalice/bible/crown
		56: { fullheal: 1 },                                          // one-up (heal + ammo + extra life)
		43: { key: 0 }, 44: { key: 1 }                               // gold key / silver key
	};
	// Plane codes for the "use" (Space) mechanic.
	var PUSHABLE = 98, ELEVATOR = 21;   // PUSHABLETILE / ELEVATORTILE
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
		this.touch = { move: { active: false, dx: 0, dy: 0 }, look: { active: false, dx: 0 }, id: { move: null, look: null }, fire: false };
		this.moveSpeed = 3.2;   // cells / second
		this.turnSpeed = 1.7;   // radians / second (lower = finer aiming)
		this.doorOpenTime = 0.5;
		this.doorStayTime = 4.0;
		this.showMap = false;
		this.running = false;
		this.pushwall = null;      // active secret-wall slide
		this._levelDone = 0;       // >0 = showing floor-stats screen
		this._levelDoneReady = false;
		this._continueTap = false;
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
	// POV weapon sprites in VSWAP: contiguous blocks of 5 pages each
	// (ready, atk1..atk4). Rendered bottom-centre over the scene.
	var WEAPON_BASE = [416, 421, 426, 431];
	// WL6 VGAGRAPH chunk numbers for the original status bar.
	var VGA = {
		STATUSBAR: 86, KNIFE: 91, NOKEY: 95, GOLDKEY: 96, SILVERKEY: 97,
		N_BLANK: 98, N_0: 99, FACE1A: 109
	};

	// Full player reset (called from the menu before the first level).
	Game.prototype.resetPlayerState = function () {
		this.gs = {
			health: 100, ammo: 8, weapon: WP.PISTOL, chosen: WP.PISTOL,
			have: [true, true, false, false],
			score: 0, lives: 3, difficulty: 1, godmode: false, infiniteAmmo: false, keys: 0,
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
	Game.prototype.setInfiniteAmmo = function (on) {
		this.gs.infiniteAmmo = !!on;
		if (on) this.gs.ammo = Math.max(this.gs.ammo, 99);
	};
	Game.prototype.setAllWeapons = function (on) {
		if (!on) return;
		this.gs.have = [true, true, true, true];
		this.gs.ammo = Math.max(this.gs.ammo, 99);
	};

	Game.prototype.load = function (buffers) {
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
		this._levelIndex = index;
		this.pushwall = null;
		this._levelDone = 0;
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
			addScore: function (pts) { self.gs.score += pts; },
			playerMoving: function () { return self._playerMoving; },
			sound: self.sound || null,
			blocked: function (tx, ty) { return self.solidObjects.has(ty * w + tx); },
			onKill: function () { self._stats.kills++; }
		});

		// Register doors and locate player start / sprites from plane1.
		var sprites = [];
		var startSet = false;
		var diff = this.gs.difficulty;
		this.solidObjects = new Set();
		this.pickups = new Map();
		this._stats = { floor: index + 1, enemies: 0, kills: 0, secretsTotal: 0, secretsFound: 0, treasureTotal: 0, treasureFound: 0 };
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
		if (typeof console !== 'undefined' && console.info) {
			console.info('[uWolf] level ' + (index + 1) + ', difficulty ' + diff +
				': ' + this.ai.actors.length + ' active enemies spawned');
		}
		this.rc.setLevel(lvl, this.doors);
		this.rc.sprites = sprites.concat(this.ai.actors);
		this._resize();
		this.setShowMap(this.showMap);
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
			if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].indexOf(e.code) >= 0) e.preventDefault();
		});
		window.addEventListener('keyup', function (e) { self.keys[e.code] = false; });
		window.addEventListener('resize', function () { if (self.rc) self._resize(); });
		// Tap / click continues the floor-stats screen.
		this.canvas.addEventListener('pointerdown', function () { if (self._levelDone > 0) self._continueTap = true; });

		// Touch: left half = move stick, right half = look drag.
		var c = this.canvas;
		c.addEventListener('touchstart', function (e) { self._touchStart(e); }, { passive: false });
		c.addEventListener('touchmove', function (e) { self._touchMove(e); }, { passive: false });
		c.addEventListener('touchend', function (e) { self._touchEnd(e); }, { passive: false });
		c.addEventListener('touchcancel', function (e) { self._touchEnd(e); }, { passive: false });
	};

	Game.prototype._touchStart = function (e) {
		e.preventDefault();
		if (this.sound) this.sound.resume();
		for (var i = 0; i < e.changedTouches.length; i++) {
			var t = e.changedTouches[i];
			if (t.clientX < window.innerWidth / 2 && this.touch.id.move === null) {
				this.touch.id.move = t.identifier;
				this.touch.move.ox = t.clientX; this.touch.move.oy = t.clientY;
				this.touch.move.active = true; this.touch.move.dx = 0; this.touch.move.dy = 0;
			} else if (this.touch.id.look === null) {
				this.touch.id.look = t.identifier;
				this.touch.look.ox = t.clientX; this.touch.look.active = true; this.touch.look.dx = 0;
			}
		}
	};

	Game.prototype._touchMove = function (e) {
		e.preventDefault();
		for (var i = 0; i < e.changedTouches.length; i++) {
			var t = e.changedTouches[i];
			if (t.identifier === this.touch.id.move) {
				this.touch.move.dx = (t.clientX - this.touch.move.ox) / 60;
				this.touch.move.dy = (t.clientY - this.touch.move.oy) / 60;
			} else if (t.identifier === this.touch.id.look) {
				this.touch.look.dx = (t.clientX - this.touch.look.ox) / 90;
				this.touch.look.ox = t.clientX; // relative look
			}
		}
	};

	Game.prototype._touchEnd = function (e) {
		for (var i = 0; i < e.changedTouches.length; i++) {
			var id = e.changedTouches[i].identifier;
			if (id === this.touch.id.move) {
				// A quick tap in the left half acts as "use".
				if (Math.abs(this.touch.move.dx) < 0.15 && Math.abs(this.touch.move.dy) < 0.15) this._use();
				this.touch.id.move = null; this.touch.move.active = false; this.touch.move.dx = 0; this.touch.move.dy = 0;
			} else if (id === this.touch.id.look) {
				this.touch.id.look = null; this.touch.look.active = false; this.touch.look.dx = 0;
			}
		}
	};

	// ---- Enemies (render-only) --------------------------------------------

	// Pick each rotating enemy's facing frame relative to the player, and fire a
	// one-shot vocalisation when the player first comes close. No movement or AI.
	Game.prototype._updateCombat = function (dt) {
		if (!this.ai) return;
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
		if (gs.godmode || gs.dead) return;
		if (gs.difficulty === 0) pts = pts >> 2;   // baby mode: quarter damage
		if (pts <= 0) return;
		gs.health -= pts;
		gs.damageFlash = Math.min(1, gs.damageFlash + 0.25 + pts / 50);
		if (gs.health <= 0) { gs.health = 0; this._playerDied(actor); }
	};

	Game.prototype._playerDied = function () {
		var gs = this.gs;
		gs.dead = true; gs.respawn = 1.8; gs.damageFlash = 1;
		if (this.sound && DIGI) this.sound.play(DIGI.DIE, 0.9);
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
		if (it.health != null) { if (gs.health >= 100) return false; this._heal(it.health); this._sfx('health'); }
		else if (it.gib) {
			if (gs.health > 10) return false;
			this._heal(1);
			if (this.sound && DIGI) this.sound.play(DIGI.SLURPIE, 0.5);
		}
		else if (it.ammo != null) { if (gs.ammo >= 99) return false; this._giveAmmo(it.ammo); this._sfx('ammo'); }
		else if (it.weapon != null) { this._giveWeapon(it.weapon); this._sfx('weapon'); }
		else if (it.fullheal) {
			this._heal(99); this._giveAmmo(25);
			if (gs.lives < 9) gs.lives++;
			this._stats.treasureFound++;
			this._sfx('1up');
		}
		else if (it.key != null) { this.gs.keys |= (1 << it.key); this._sfx('key'); }
		else if (it.points != null) { gs.score += it.points; if (it.treasure) this._stats.treasureFound++; this._sfx('treasure'); }
		else return false;
		return true;
	};

	Game.prototype._sfx = function (name) { if (this.sound && this.sound.sfx) this.sound.sfx(name); };

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

	Game.prototype._respawn = function () {
		var gs = this.gs;
		gs.lives -= 1;
		if (gs.lives < 0) { gs.lives = 3; gs.score = 0; }   // endless: full restart
		gs.health = 100; gs.ammo = Math.max(gs.ammo, 8);
		gs.weapon = gs.have[WP.PISTOL] ? WP.PISTOL : WP.KNIFE;
		gs.chosen = gs.weapon; gs.dead = false; gs.damageFlash = 0;
		this.startLevel(this._levelIndex);
	};

	// ---- Doors -------------------------------------------------------------

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
			if (announce) { this._lockMsg = 1.4; this._sfx('locked'); }   // locked: needs the matching key
			return;
		}
		if (d.state === 'closed' || d.state === 'closing') {
			d.state = 'opening';
			this._sfxAt(d.cx, d.cy, DIGI.OPENDOOR, 0.85);
		}
	};

	// --- Elevator (level exit) ---------------------------------------------
	Game.prototype._rideElevator = function (cx, cy) {
		if (this._levelDone) return;
		this.level.plane0[cy * this.level.width + cx] = ELEVATOR + 1; // flip the switch texture
		if (this.sound && DIGI) this.sound.play(DIGI.LEVELDONE, 0.9);
		var count = this.data.levels.length;
		this._pendingLevel = (this._levelIndex + 1) % count;   // next floor (wraps)
		this._levelDone = 1;             // show the floor-stats screen
		this._levelDoneReady = false;    // require the "use" key to be released first
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
				if (d.timer <= 0 && !(cx === pcx && cy === pcy)) {
					d.state = 'closing';
					self._sfxAt(cx, cy, DIGI.CLOSEDOOR, 0.85);
				}
			} else if (d.state === 'closing') {
				d.open -= dt / self.doorOpenTime;
				if (d.open <= 0) { d.open = 0; d.state = 'closed'; }
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

	Game.prototype._loop = function (now) {
		var dt = Math.min(0.05, (now - this._last) / 1000);
		this._last = now;
		var p = this.player, k = this.keys, gs = this.gs;
		var frozen = gs.dead || this._levelDone > 0;

		// Elevator: hold the floor-stats screen until the player presses a key/taps.
		if (this._levelDone > 0) {
			var held = !!(k['Space'] || k['Enter'] || k['NumpadEnter'] || k['KeyE']);
			var tap = this._continueTap; this._continueTap = false;
			if (!held && !tap) this._levelDoneReady = true;      // wait for release first
			if (this._levelDoneReady && (held || tap)) {
				this.startLevel(this._pendingLevel);
				requestAnimationFrame(this._loop.bind(this)); // startLevel won't reschedule while running
				return;
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

			if (this.touch.move.active) { forward -= clamp(this.touch.move.dy, -1, 1); strafe += clamp(this.touch.move.dx, -1, 1); }
			if (this.touch.look.active) { turn += clamp(this.touch.look.dx * 4, -2.2, 2.2); this.touch.look.dx = 0; }
		}

		if (turn) this.setAngle(p.angle + turn * this.turnSpeed * dt);

		this._playerMoving = false;
		if (forward || strafe) {
			var mag = Math.hypot(forward, strafe) || 1;
			var mvx = (p.dirX * forward + (-p.dirY) * strafe) / mag * this.moveSpeed * dt;
			var mvy = (p.dirY * forward + (p.dirX) * strafe) / mag * this.moveSpeed * dt;
			this._tryMove(p.x + mvx, p.y + mvy);
			this._playerMoving = true;
		}
		this._checkPickup();
		if (this._lockMsg > 0) this._lockMsg -= dt;

		this._updateDoors(dt);
		this._updatePushwall(dt);
		this._updateCombat(dt);
		this.rc.pushwall = this.pushwall;
		this.rc.render(p);
		this._drawHUD();
		if (this.showMap) this._drawMinimap();

		if (this.running) requestAnimationFrame(this._loop.bind(this));
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

		if (gs.dead) {
			ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.max(16, H * 0.09) + 'px monospace';
			ctx.fillText('DEAD', cx, (H - barH) / 2); ctx.restore();
		} else if (this._levelDone > 0) {
			var st = this._stats || { floor: this._levelIndex + 1, enemies: 0, kills: 0, secretsTotal: 0, secretsFound: 0, treasureTotal: 0, treasureFound: 0 };
			var pct = function (a, b) { return b > 0 ? Math.round(a * 100 / b) : 100; };
			ctx.save();
			ctx.fillStyle = '#0b0b0b'; ctx.fillRect(0, 0, W, H);   // solid intermission screen
			ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			var cyC = H / 2;
			ctx.fillStyle = '#ffd24a'; ctx.font = 'bold ' + Math.max(16, H * 0.075) + 'px monospace';
			ctx.fillText('FLOOR ' + st.floor + ' COMPLETE', W / 2, cyC - H * 0.24);
			ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.max(11, H * 0.045) + 'px monospace';
			var rows = [
				'KILL     ' + st.kills + ' / ' + st.enemies + '    ' + pct(st.kills, st.enemies) + '%',
				'SECRET   ' + st.secretsFound + ' / ' + st.secretsTotal + '    ' + pct(st.secretsFound, st.secretsTotal) + '%',
				'TREASURE ' + st.treasureFound + ' / ' + st.treasureTotal + '    ' + pct(st.treasureFound, st.treasureTotal) + '%',
				'SCORE    ' + this.gs.score
			];
			for (var ri = 0; ri < rows.length; ri++) ctx.fillText(rows[ri], W / 2, cyC - H * 0.09 + ri * H * 0.08);
			ctx.fillStyle = (((Date.now() / 500) | 0) % 2) ? '#ffd24a' : 'rgba(255,210,74,0.35)';
			ctx.font = 'bold ' + Math.max(10, H * 0.038) + 'px monospace';
			ctx.fillText(this._levelDoneReady ? 'PRESS A KEY TO CONTINUE' : '\u2026', W / 2, cyC + H * 0.33);
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

		num(2, 16, 2, this._levelIndex + 1);                     // floor
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
		for (var dy = -view; dy < view; dy++) {
			for (var dx = -view; dx < view; dx++) {
				var mx = (cx + dx) | 0, my = (cy + dy) | 0;
				if (mx < 0 || my < 0 || mx >= lvl.width || my >= lvl.height) continue;
				var t = lvl.plane0[my * lvl.width + mx];
				if (isWall(t)) ctx.fillStyle = '#8a8a8a';
				else if (isDoor(t)) ctx.fillStyle = '#c8a24b';
				else continue;
				ctx.fillRect((mx - cx + view) * cell, (my - cy + view) * cell, cell + 0.5, cell + 0.5);
			}
		}
		// Player.
		ctx.fillStyle = '#48d048';
		ctx.beginPath(); ctx.arc(size / 2, size / 2, cell * 0.5, 0, Math.PI * 2); ctx.fill();
		ctx.strokeStyle = '#48d048'; ctx.beginPath();
		ctx.moveTo(size / 2, size / 2);
		ctx.lineTo(size / 2 + p.dirX * cell * 1.6, size / 2 + p.dirY * cell * 1.6); ctx.stroke();
	};

	function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

	root.WolfGame = Game;
})(typeof window !== 'undefined' ? window : this);
