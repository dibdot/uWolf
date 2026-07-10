/*
 * main.js — menu / loading glue.
 *
 * Loads the registered Wolfenstein 3D (v1.4) data: VSWAP.WL6 / MAPHEAD.WL6 /
 * GAMEMAPS.WL6, plus optional VGAGRAPH.WL6 / VGAHEAD.WL6 / VGADICT.WL6 for the
 * original status bar. Files are matched by name; only the WL6 set is targeted.
 */
(function () {
	'use strict';

	var $ = function (id) { return document.getElementById(id); };
	var game = new window.WolfGame($('screen'), $('minimap'));
	window.game = game; // exposed for console inspection (e.g. game.sound.play(i))

	var status = $('status');
	function say(msg, err) { status.textContent = msg; status.className = 'status' + (err ? ' err' : ''); }

	function afterLoad(buffers) {
		try {
			var levels = game.load(buffers);
			var sel = $('levelSel');
			sel.innerHTML = '';
			levels.forEach(function (lv) {
				var o = document.createElement('option');
				o.value = lv.index; o.textContent = (lv.index + 1) + ' — ' + lv.name;
				sel.appendChild(o);
			});
			$('levelBox').classList.remove('hidden');
			say('Loaded ' + game.data.numWalls + ' wall textures, ' + game.data.numSprites +
				' sprites, ' + levels.length + ' levels.' +
				(game.data.vga ? ' Original status bar + face enabled.' : ''));
		} catch (e) {
			say('Could not parse data: ' + e.message, true);
		}
	}

	// --- Load from the web server (same folder as this page) ---
	var CANDIDATES = {
		VSWAP: ['VSWAP.WL6', 'vswap.wl6'],
		MAPHEAD: ['MAPHEAD.WL6', 'maphead.wl6'],
		GAMEMAPS: ['GAMEMAPS.WL6', 'gamemaps.wl6']
	};
	// Optional — only needed for the original status bar / BJ face.
	var CANDIDATES_OPT = {
		VGAGRAPH: ['VGAGRAPH.WL6', 'vgagraph.wl6'],
		VGAHEAD: ['VGAHEAD.WL6', 'vgahead.wl6'],
		VGADICT: ['VGADICT.WL6', 'vgadict.wl6']
	};

	function fetchFirst(list) {
		var i = 0;
		return new Promise(function (resolve, reject) {
			(function next() {
				if (i >= list.length) { reject(new Error('none of: ' + list.join(', '))); return; }
				var name = list[i++];
				fetch(name).then(function (r) {
					if (!r.ok) throw new Error(r.status);
					return r.arrayBuffer();
				}).then(resolve).catch(next);
			})();
		});
	}

	function loadFromServer() {
		say('Loading game data…');
		var optional = function (list) { return fetchFirst(list).catch(function () { return null; }); };
		Promise.all([
			fetchFirst(CANDIDATES.VSWAP), fetchFirst(CANDIDATES.MAPHEAD), fetchFirst(CANDIDATES.GAMEMAPS),
			optional(CANDIDATES_OPT.VGAGRAPH), optional(CANDIDATES_OPT.VGAHEAD), optional(CANDIDATES_OPT.VGADICT)
		])
			.then(function (b) {
				var buffers = { VSWAP: b[0], MAPHEAD: b[1], GAMEMAPS: b[2] };
				if (b[3] && b[4] && b[5]) { buffers.VGAGRAPH = b[3]; buffers.VGAHEAD = b[4]; buffers.VGADICT = b[5]; }
				afterLoad(buffers);
			})
			.catch(function () {
				say('Game data not found in this folder. Add VSWAP.WL6, MAPHEAD.WL6 and GAMEMAPS.WL6 here, then press Retry.', true);
			});
	}

	$('btnFetch').addEventListener('click', loadFromServer);
	loadFromServer();   // auto-load from the webroot on open

	// --- Start / HUD ---
	$('btnStart').addEventListener('click', function () {
		var idx = parseInt($('levelSel').value, 10);
		try {
			game.resetPlayerState();
			game.setDifficulty(parseInt($('diffSel').value, 10) || 0);
			game.setGodmode($('godChk').checked);
			game.setAllWeapons($('allWpnChk').checked);
			game.setInfiniteAmmo($('ammoChk').checked);
			game.startLevel(idx);
			$('menu').classList.add('hidden');
			$('hud').classList.remove('hidden');
		} catch (e) { say('Level failed: ' + e.message, true); }
	});

	$('btnMap').addEventListener('click', function () { game.toggleMap(); });
	$('btnWpn').addEventListener('click', function () { game.cycleWeapon(); });
	$('btnMenu').addEventListener('click', function () {
		game.running = false; $('menu').classList.remove('hidden'); $('hud').classList.add('hidden');
		if (game.minimap) game.minimap.style.display = 'none';
	});

	// Basic feature note.
	if (location.protocol === 'file:') {
		document.getElementById('fetchHint').textContent =
			'You are opening this from file://. Serving via uhttpd (http://) is recommended so fetch works.';
	}
})();
