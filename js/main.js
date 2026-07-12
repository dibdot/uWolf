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
			refreshSaves();
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
	// --- Mobile controls (the on-screen FIRE button) ---
	// Off on desktop, where it just covers the view; on by default if the browser
	// reports a touch device. The choice is remembered across reloads.
	var MOBILE_KEY = 'uwolf.mobileControls';

	function touchDevice() {
		return (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
	}

	function applyMobileControls(on) {
		$('btnFire').classList.toggle('hidden', !on);
		$('dpad').classList.toggle('hidden', !on);
		if (!on) {                                 // never leave a button stuck down
			game.touch.fire = false;
			var pad = game.touch.pad;
			pad.fwd = pad.back = pad.left = pad.right = false;
		}
		try { window.localStorage.setItem(MOBILE_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
	}

	(function initMobileControls() {
		var stored = null;
		try { stored = window.localStorage.getItem(MOBILE_KEY); } catch (e) { /* ignore */ }
		var on = (stored === null) ? touchDevice() : (stored === '1');
		$('mobileChk').checked = on;
		applyMobileControls(on);
		$('mobileChk').addEventListener('change', function () {
			applyMobileControls($('mobileChk').checked);
		});

		// Hold to fire; works for touch and mouse alike via pointer events.
		var fb = $('btnFire');
		function down(e) {
			e.preventDefault();
			game.touch.fire = true;
			if (game.sound) game.sound.resume();
			if (fb.setPointerCapture && e.pointerId != null) fb.setPointerCapture(e.pointerId);
		}
		function up(e) { if (e) e.preventDefault(); game.touch.fire = false; }
		fb.addEventListener('pointerdown', down);
		fb.addEventListener('pointerup', up);
		fb.addEventListener('pointercancel', up);
		window.addEventListener('blur', function () { up(); });   // don't fire forever if focus is lost

		// D-pad. Handled as ONE capture surface rather than five independent buttons:
		// the pointer is captured on the pad and we hit-test which segment it is over,
		// so the thumb can slide from "forward" to "turn left" without lifting — the
		// thing that makes a real D-pad feel like a D-pad. The centre is "use" (doors,
		// secret walls, elevator), which is where the old tap-to-open used to live.
		var dpad = $('dpad');
		var padBtns = Array.prototype.slice.call(dpad.querySelectorAll('.dpad-btn'));
		var activeKey = null;

		function keyAt(x, y) {
			for (var i = 0; i < padBtns.length; i++) {
				var r = padBtns[i].getBoundingClientRect();
				if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
					return padBtns[i].getAttribute('data-pad');
				}
			}
			return null;
		}

		function padClear() {
			var pad = game.touch.pad;
			pad.fwd = pad.back = pad.left = pad.right = false;
			padBtns.forEach(function (b) { b.classList.remove('held'); });
			activeKey = null;
		}

		function padSet(key) {
			if (key === activeKey) return;            // nothing changed
			padClear();
			if (!key) return;
			activeKey = key;
			if (key === 'use') { game._use(); return; }   // fires once, on entering the centre
			game.touch.pad[key] = true;
			padBtns.forEach(function (b) {
				if (b.getAttribute('data-pad') === key) b.classList.add('held');
			});
		}

		var padDown = false;
		dpad.addEventListener('pointerdown', function (e) {
			e.preventDefault();
			padDown = true;
			if (game.sound) game.sound.resume();
			if (dpad.setPointerCapture && e.pointerId != null) dpad.setPointerCapture(e.pointerId);
			padSet(keyAt(e.clientX, e.clientY));
		});
		dpad.addEventListener('pointermove', function (e) {
			if (!padDown) return;                      // ignore mouse hover
			e.preventDefault();
			padSet(keyAt(e.clientX, e.clientY));       // slide between directions
		});
		function padRelease(e) { if (e) e.preventDefault(); padDown = false; padClear(); }
		dpad.addEventListener('pointerup', padRelease);
		dpad.addEventListener('pointercancel', padRelease);

		// A lost window must not leave the player walking into a wall forever.
		window.addEventListener('blur', function () { padDown = false; padClear(); });
	})();

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
	$('btnSave').addEventListener('click', function () { game.quickSave(); });
	$('btnMenu').addEventListener('click', function () { game.exitToMenu(); });

	// Escape / MENU only pause the run — this picks it back up where it was.
	$('btnResume').addEventListener('click', function () {
		if (game.resume()) enterGame();
	});

	// Back to the menu — from the MENU button or the Escape key (game.onMenu).
	// The run stays in memory, so it can be resumed or stored into a slot here.
	game.onMenu = function () {
		$('menu').classList.remove('hidden');
		$('hud').classList.add('hidden');
		if (game.minimap) game.minimap.style.display = 'none';
		refreshSaves();
	};

	// --- Saved games (localStorage) ---
	// Slots: an autosave written on every new floor, an F8 quick-save, and three
	// manual slots. A game in progress can be stored into quick/1/2/3 from here.
	var SLOTS = [
		{ id: 'auto', name: 'Autosave', manual: false },
		{ id: 'quick', name: 'Quicksave', manual: true },
		{ id: '1', name: 'Slot 1', manual: true },
		{ id: '2', name: 'Slot 2', manual: true },
		{ id: '3', name: 'Slot 3', manual: true }
	];
	var DIFF_NAME = ['Daddy', "Don't hurt me", "Bring 'em on", 'Death incarnate'];

	function enterGame() {
		$('menu').classList.add('hidden');
		$('hud').classList.remove('hidden');
	}

	// Out of lives: the run is over — drop it, so there is nothing left to resume.
	game.onGameOver = function () {
		$('menu').classList.remove('hidden');
		$('hud').classList.add('hidden');
		if (game.minimap) game.minimap.style.display = 'none';
		var score = game.gs.score, floor = game._levelIndex + 1;
		game.clearRun();
		refreshSaves();
		say('Game over on floor ' + floor + ' — final score ' + score + '. Start a new game or load a save.');
	};

	function describe(info) {
		var d = new Date(info.ts);
		var when = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return 'Floor ' + info.floor + ' · ' + info.health + '% · ' + info.score + ' pts · ' +
			(DIFF_NAME[info.difficulty] || '?') + ' · ' + when;
	}

	function refreshSaves() {
		var list = $('savesList'), box = $('savesBox');
		if (!list) return;
		list.innerHTML = '';
		var inGame = !!(game.data && game.level && !game.gs.dead);
		var any = false;

		SLOTS.forEach(function (slot) {
			var info = game.slotInfo(slot.id);
			if (!info && !(inGame && slot.manual)) return;   // nothing to show for this slot
			any = true;

			var row = document.createElement('div');
			row.className = 'save-row';

			var txt = document.createElement('div');
			txt.className = 'save-txt';
			txt.innerHTML = '<strong>' + slot.name + '</strong><br><span>' +
				(info ? describe(info) : 'empty') + '</span>';
			row.appendChild(txt);

			var btns = document.createElement('div');
			btns.className = 'save-btns';

			if (info) {
				var bl = document.createElement('button');
				bl.textContent = 'Load';
				bl.addEventListener('click', function () {
					try { game.loadFromSlot(slot.id); enterGame(); }
					catch (e) { say('Load failed: ' + e.message, true); }
				});
				btns.appendChild(bl);
			}
			if (inGame && slot.manual) {
				var bs = document.createElement('button');
				bs.textContent = info ? 'Overwrite' : 'Save here';
				bs.addEventListener('click', function () {
					try { game.saveToSlot(slot.id); refreshSaves(); say('Saved to ' + slot.name + '.'); }
					catch (e) { say('Save failed: ' + e.message, true); }
				});
				btns.appendChild(bs);
			}
			if (info) {
				var bd = document.createElement('button');
				bd.textContent = 'Delete';
				bd.className = 'danger';
				bd.addEventListener('click', function () {
					game.deleteSlot(slot.id); refreshSaves();
				});
				btns.appendChild(bd);
			}
			row.appendChild(btns);
			list.appendChild(row);
		});

		// A paused run (Escape / MENU) can be picked straight back up.
		var resumable = game.canResume();
		$('btnResume').classList.toggle('hidden', !resumable);

		box.classList.toggle('hidden', !any);

		// Number the sections in the order they actually appear.
		var n = 2;
		if (resumable) n++;                                  // the Resume button sits first
		if (any) { $('savesLabel').textContent = n + ' · Continue a saved game'; n++; }
		$('newGameLabel').textContent = n + ' · Start a new game';
	}

	// Basic feature note.
	if (location.protocol === 'file:') {
		document.getElementById('fetchHint').textContent =
			'You are opening this from file://. Serving via uhttpd (http://) is recommended so fetch works.';
	}
})();
