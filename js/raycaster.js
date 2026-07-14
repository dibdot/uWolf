/*
 * raycaster.js
 *
 * A classic DDA raycaster (lodev-style camera model). Walls are drawn as
 * scaled 1px texture slices via drawImage, which keeps the whole thing fast
 * enough for phones without a per-pixel software loop. Doors live at the
 * centre of their cell and slide sideways; sprites are billboarded and
 * occluded against the wall depth buffer.
 */
(function (root) {
	'use strict';

	function isWall(t) { return t > 0 && t <= 63; }
	function isDoor(t) { return t >= 90 && t <= 101; }
	function doorVertical(t) { return (t & 1) === 0; } // even codes = vertical slab

	// Every wall tile has TWO textures in VSWAP — a light one and a darker one — and
	// which you see depends on which face of the block the ray struck:
	//
	//     horizwall[i] = (i-1)*2      the north/south faces   (HitHorizWall)
	//     vertwall[i]  = (i-1)*2 + 1  the east/west faces     (HitVertWall)
	//
	// That IS Wolfenstein's lighting: there is no shading at runtime, the artists simply
	// drew a darker variant for one orientation. `side` here is the raycaster's own: 0
	// means the ray crossed an X boundary, i.e. it hit an east/west face — so side 0
	// takes the *vertical* page, the odd one. Getting this backwards is invisible on
	// most walls (the two variants are the same bricks) but not on the elevator, whose
	// two faces are a lever and a blank panel.
	function wallTexPage(t, side, numWalls) {
		var p = (t - 1) * 2 + (side === 0 ? 1 : 0);
		if (p < 0) p = 0;
		if (p >= numWalls) p = numWalls - 1;
		return p;
	}

	// Doors work the same way (HitVertDoor / HitHorizDoor), from DOORWALL = 98.
	function doorTexPage(t, side, numWalls) {
		var base;
		if (t === 100 || t === 101) base = 102;        // elevator door
		else if (t >= 92 && t <= 95) base = 104;       // locked (gold/silver)
		else base = 98;                                // normal door
		var p = base + (side === 0 ? 1 : 0);
		if (p >= numWalls) p = numWalls - 1;
		return p;
	}

	function Raycaster(gameData, canvas) {
		this.data = gameData;
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d', { alpha: false });
		this.ctx.imageSmoothingEnabled = false;
		this.zbuffer = null;
		this.ceilColor = '#383838';
		this.floorColor = '#707070';
		this.depthShade = false; // subtle distance darkening on top of two-tone
		this.pushwall = null;    // set by the game each frame while a secret slides
	}

	// Ray vs. the sliding secret wall (a unit block at a fractional position).
	// Returns { perpDist, texX, tex, side } or null.
	Raycaster.prototype._pushwallHit = function (posX, posY, rayDirX, rayDirY) {
		var pw = this.pushwall;
		var bx0 = pw.ax + pw.dx * pw.dist, by0 = pw.ay + pw.dy * pw.dist;
		var bx1 = bx0 + 1, by1 = by0 + 1;
		var invx = 1 / rayDirX, invy = 1 / rayDirY;
		var tx0 = (bx0 - posX) * invx, tx1 = (bx1 - posX) * invx;
		if (tx0 > tx1) { var a = tx0; tx0 = tx1; tx1 = a; }
		var ty0 = (by0 - posY) * invy, ty1 = (by1 - posY) * invy;
		if (ty0 > ty1) { var b = ty0; ty0 = ty1; ty1 = b; }
		var tenter = tx0 > ty0 ? tx0 : ty0;
		var texit = tx1 < ty1 ? tx1 : ty1;
		if (!(tenter === tenter) || tenter > texit || texit < 0 || tenter < 0) return null;
		var side, texX;
		if (tx0 > ty0) {                         // entered on a constant-x face
			side = 0;
			texX = (((posY + tenter * rayDirY) - by0) * 64) | 0;
			if (rayDirX > 0) texX = 63 - texX;
		} else {                                 // entered on a constant-y face
			side = 1;
			texX = (((posX + tenter * rayDirX) - bx0) * 64) | 0;
			if (rayDirY < 0) texX = 63 - texX;
		}
		if (texX < 0) texX = 0; if (texX > 63) texX = 63;
		var page = wallTexPage(pw.tile, side, this.data.numWalls);
		return { perpDist: tenter, texX: texX, tex: this.data.getWallCanvas(page, false), side: side };
	};

	Raycaster.prototype.setLevel = function (level, doors) {
		this.level = level;
		this.doors = doors; // Map: cellIndex -> {tile, open}
	};

	Raycaster.prototype._plane0 = function (x, y) {
		if (x < 0 || y < 0 || x >= this.level.width || y >= this.level.height) return 1;
		return this.level.plane0[y * this.level.width + x];
	};

	Raycaster.prototype.resize = function (w, h) {
		this.canvas.width = w;
		this.canvas.height = h;
		this.ctx.imageSmoothingEnabled = false;
		this.zbuffer = new Float32Array(w);
	};

	Raycaster.prototype.render = function (player) {
		var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
		var data = this.data, lvl = this.level, doors = this.doors;

		// Ceiling / floor.
		ctx.fillStyle = this.ceilColor; ctx.fillRect(0, 0, W, H / 2);
		ctx.fillStyle = this.floorColor; ctx.fillRect(0, H / 2, W, H / 2);

		var posX = player.x, posY = player.y;
		var dirX = player.dirX, dirY = player.dirY;
		var planeX = player.planeX, planeY = player.planeY;
		var zb = this.zbuffer;

		for (var x = 0; x < W; x++) {
			var cameraX = 2 * x / W - 1;
			var rayDirX = dirX + planeX * cameraX;
			var rayDirY = dirY + planeY * cameraX;
			var mapX = posX | 0, mapY = posY | 0;
			var deltaX = Math.abs(1 / rayDirX), deltaY = Math.abs(1 / rayDirY);
			var stepX, stepY, sideDistX, sideDistY;
			if (rayDirX < 0) { stepX = -1; sideDistX = (posX - mapX) * deltaX; }
			else { stepX = 1; sideDistX = (mapX + 1 - posX) * deltaX; }
			if (rayDirY < 0) { stepY = -1; sideDistY = (posY - mapY) * deltaY; }
			else { stepY = 1; sideDistY = (mapY + 1 - posY) * deltaY; }

			var hit = 0, side = 0, perpDist = 0, texX = 0, tex = null;
			var guard = 0;
			while (!hit && guard++ < 256) {
				if (sideDistX < sideDistY) { sideDistX += deltaX; mapX += stepX; side = 0; }
				else { sideDistY += deltaY; mapY += stepY; side = 1; }
				var t = this._plane0(mapX, mapY);

				if (isDoor(t)) {
					var st = doors.get(mapY * lvl.width + mapX);
					var open = st ? st.open : 0;
					if (doorVertical(t)) {
						var planePosX = mapX + 0.5;
						var pd = (planePosX - posX) / rayDirX;
						var yHit = posY + pd * rayDirY;
						if (pd > 0 && (yHit | 0) === mapY) {
							var frac = yHit - mapY;
							if (frac >= open) {                 // solid part of slab
								perpDist = pd; side = 0;
								texX = ((frac - open) * 64) | 0;
								tex = data.getWallCanvas(doorTexPage(t, 0, data.numWalls), false);
								hit = 1;
							}
						}
					} else {
						var planePosY = mapY + 0.5;
						var pd2 = (planePosY - posY) / rayDirY;
						var xHit = posX + pd2 * rayDirX;
						if (pd2 > 0 && (xHit | 0) === mapX) {
							var frac2 = xHit - mapX;
							if (frac2 >= open) {
								perpDist = pd2; side = 1;
								texX = ((frac2 - open) * 64) | 0;
								tex = data.getWallCanvas(doorTexPage(t, 1, data.numWalls), false);
								hit = 1;
							}
						}
					}
					// If not hit, ray passes through the opening -> keep stepping.
				} else if (isWall(t)) {
					if (side === 0) perpDist = (mapX - posX + (1 - stepX) / 2) / rayDirX;
					else perpDist = (mapY - posY + (1 - stepY) / 2) / rayDirY;
					var wallX;
					if (side === 0) wallX = posY + perpDist * rayDirY;
					else wallX = posX + perpDist * rayDirX;
					wallX -= Math.floor(wallX);
					texX = (wallX * 64) | 0;
					// Flip so textures aren't mirrored, matching original orientation.
					if (side === 0 && rayDirX > 0) texX = 63 - texX;
					if (side === 1 && rayDirY < 0) texX = 63 - texX;
					tex = data.getWallCanvas(wallTexPage(t, side, data.numWalls), false);
					hit = 1;
				}
			}
			// A sliding secret wall is a unit block at a fractional position; test it
			// against this ray and take it if nearer than the DDA wall hit.
			if (this.pushwall) {
				var ph = this._pushwallHit(posX, posY, rayDirX, rayDirY);
				if (ph && (!hit || ph.perpDist < perpDist)) {
					hit = 1; perpDist = ph.perpDist; texX = ph.texX; tex = ph.tex; side = ph.side;
				}
			}
			if (!hit || perpDist <= 0) { zb[x] = 1e9; continue; }
			zb[x] = perpDist;

			var lineH = (H / perpDist) | 0;
			var drawStart = (-lineH / 2 + H / 2) | 0;
			if (texX < 0) texX = 0; if (texX > 63) texX = 63;
			ctx.drawImage(tex, texX, 0, 1, 64, x, drawStart, 1, lineH);

			if (this.depthShade && perpDist > 3) {
				var a = Math.min(0.6, (perpDist - 3) * 0.06);
				ctx.fillStyle = 'rgba(0,0,0,' + a + ')';
				ctx.fillRect(x, drawStart, 1, lineH);
			}
		}

		this._renderSprites(player);
	};

	Raycaster.prototype._renderSprites = function (player) {
		if (!this.sprites || !this.sprites.length) return;
		var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
		var posX = player.x, posY = player.y;
		var dirX = player.dirX, dirY = player.dirY, planeX = player.planeX, planeY = player.planeY;
		var zb = this.zbuffer, data = this.data;

		// Sort far -> near.
		var order = this.sprites.map(function (s, i) {
			var dx = s.x - posX, dy = s.y - posY; return { i: i, d: dx * dx + dy * dy };
		}).sort(function (a, b) { return b.d - a.d; });

		var invDet = 1 / (planeX * dirY - dirX * planeY);
		for (var k = 0; k < order.length; k++) {
			var sp = this.sprites[order[k].i];
			if (sp.sprite == null || sp.sprite < 0) continue;   // collected / hidden
			var relX = sp.x - posX, relY = sp.y - posY;
			var tX = invDet * (dirY * relX - dirX * relY);
			var tY = invDet * (-planeY * relX + planeX * relY); // depth
			if (tY <= 0.1) continue;
			var screenX = ((W / 2) * (1 + tX / tY)) | 0;
			var size = Math.abs((H / tY)) | 0;
			var drawStartY = (-size / 2 + H / 2) | 0;
			var startX = (-size / 2 + screenX);
			var canvasSprite = data.getSpriteCanvas(sp.sprite);
			var iStart = Math.max(0, Math.floor(startX));
			var iEnd = Math.min(W - 1, Math.floor(startX + size));
			for (var stripe = iStart; stripe <= iEnd; stripe++) {
				if (tY >= zb[stripe]) continue;
				var texX = (((stripe - startX) * 64 / size)) | 0;
				if (texX < 0 || texX > 63) continue;
				ctx.drawImage(canvasSprite, texX, 0, 1, 64, stripe, drawStartY, 1, size);
			}
		}
	};

	Raycaster.helpers = { isWall: isWall, isDoor: isDoor, doorVertical: doorVertical,
		wallTexPage: wallTexPage, doorTexPage: doorTexPage };
	root.Raycaster = Raycaster;
})(typeof window !== 'undefined' ? window : this);
