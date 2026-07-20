/*
 * main.js — menu / loading glue.
 *
 * Detects which datasets are present in the page folder — Wolfenstein 3D
 * (VSWAP/MAPHEAD/GAMEMAPS.WL6, + optional VGAGRAPH/VGAHEAD/VGADICT/AUDIOHED/
 * AUDIOT.WL6) and/or Spear of Destiny (the same names with a .SOD extension) —
 * and loads the selected one, activating its engine profile via WolfVariant.
 * Files are matched case-insensitively.
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
				// The game labels floors per dataset (E# F# for Wolfenstein's
				// episodes, plain "Floor #" for Spear's single campaign).
				o.value = lv.index;
				o.textContent = game._floorLabel(lv.index) + ' — ' + lv.name;
				sel.appendChild(o);
			});
			setupMusic(buffers);
			$('levelBox').classList.remove('hidden');
			refreshSaves();
			say('Loaded ' + game.data.numWalls + ' wall textures, ' + game.data.numSprites +
				' sprites, ' + levels.length + ' levels.' +
				(game.data.vga ? ' Original status bar + face enabled.' : '') +
				(game.music ? ' Music and FM effects available.' : ''));
		} catch (e) {
			say('Could not parse data: ' + e.message, true);
		}
	}

	// --- Load from the web server (same folder as this page) ---
	// Candidate file names are matched case-insensitively, per dataset extension:
	// WL6 for Wolfenstein 3D, SOD for Spear of Destiny. The selected dataset also
	// switches the engine's numeric profile via WolfVariant (see variants.js).
	var variantSel = $('variantSel');

	function candidates(ext) {
		var lo = ext.toLowerCase();
		var pair = function (stem) { return [stem + '.' + ext, (stem + '.' + lo)]; };
		return {
			req: { VSWAP: pair('VSWAP'), MAPHEAD: pair('MAPHEAD'), GAMEMAPS: pair('GAMEMAPS') },
			opt: {
				VGAGRAPH: pair('VGAGRAPH'), VGAHEAD: pair('VGAHEAD'), VGADICT: pair('VGADICT'),
				AUDIOHED: pair('AUDIOHED'), AUDIOT: pair('AUDIOT')
			}
		};
	}

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

	// Probe which datasets have their required VSWAP present, so the selector only
	// offers what is actually in the folder (and auto-picks when only one is).
	function probe(ext) { return fetchFirst(candidates(ext).req.VSWAP).then(function () { return true; }).catch(function () { return false; }); }

	function currentVariantId() { return variantSel ? variantSel.value : 'WL6'; }

	function loadFromServer() {
		var id = currentVariantId();
		var v = window.WolfVariant.get(id) || window.WolfVariant.active;
		window.WolfVariant.use(v.id);           // activate the numeric profile first
		var ext = v.ext;
		say('Loading ' + v.name + ' data…');
		var C = candidates(ext);
		var optional = function (list) { return fetchFirst(list).catch(function () { return null; }); };
		Promise.all([
			fetchFirst(C.req.VSWAP), fetchFirst(C.req.MAPHEAD), fetchFirst(C.req.GAMEMAPS),
			optional(C.opt.VGAGRAPH), optional(C.opt.VGAHEAD), optional(C.opt.VGADICT),
			optional(C.opt.AUDIOHED), optional(C.opt.AUDIOT)
		])
			.then(function (b) {
				var buffers = { VSWAP: b[0], MAPHEAD: b[1], GAMEMAPS: b[2], variant: v.id };
				if (b[3] && b[4] && b[5]) { buffers.VGAGRAPH = b[3]; buffers.VGAHEAD = b[4]; buffers.VGADICT = b[5]; }
				if (b[6] && b[7]) { buffers.AUDIOHED = b[6]; buffers.AUDIOT = b[7]; }
				afterLoad(buffers);
			})
			.catch(function () {
				say('No ' + v.name + ' data here. Add VSWAP.' + ext + ', MAPHEAD.' + ext +
					' and GAMEMAPS.' + ext + ' to this folder, then press Retry.', true);
			});
	}

	// On open: probe both datasets, populate the selector with the ones present,
	// then load. If only one is present it is auto-selected; if none, prompt.
	function initDatasets() {
		Promise.all([probe('WL6'), probe('SOD')]).then(function (have) {
			var present = [];
			if (have[0]) present.push('WL6');
			if (have[1]) present.push('SOD');
			if (variantSel) {
				variantSel.innerHTML = '';
				window.WolfVariant.list().forEach(function (v) {
					var o = document.createElement('option');
					o.value = v.id;
					o.textContent = v.name;
					o.disabled = present.indexOf(v.id) < 0;
					variantSel.appendChild(o);
				});
				if (present.length) variantSel.value = present[0];
			}
			if (present.length) loadFromServer();
			else say('No game data found. Add your VSWAP/MAPHEAD/GAMEMAPS (.WL6 for Wolfenstein or .SOD for Spear of Destiny) here, then press Retry.', true);
		});
	}

	if (variantSel) variantSel.addEventListener('change', loadFromServer);
	$('btnFetch').addEventListener('click', loadFromServer);
	initDatasets();   // auto-detect + load from the webroot on open

	// --- Start / HUD ---
	// --- Music (OPL2 / FM synthesis) ---
	// AUDIOHED + AUDIOT are optional; without them the checkbox stays off and disabled.
	var MUSIC_KEY = 'uwolf.music';

	function setupMusic(buffers) {
		var box = $('musicChk');
		game.music = null;

		if (!window.WolfMusic || !buffers.AUDIOHED || !buffers.AUDIOT || !game.sound) {
			box.checked = false;
			box.disabled = true;
			box.parentNode.title = 'Needs AUDIOHED.WL6 and AUDIOT.WL6';
			return;
		}
		try {
			var audio = new window.WolfMusic.WolfAudio(buffers.AUDIOHED, buffers.AUDIOT);
			if (!audio.musicCount()) throw new Error('no tracks');
			game.music = new window.WolfMusic.MusicPlayer(game.sound.context(), audio);
		} catch (e) {
			game.music = null;
			box.checked = false;
			box.disabled = true;
			return;
		}

		box.disabled = false;
		var stored = null;
		try { stored = window.localStorage.getItem(MUSIC_KEY); } catch (e) { /* ignore */ }
		box.checked = (stored === null) ? true : (stored === '1');    // on by default, as in the original
		game.music.setEnabled(box.checked);
	}

	$('musicChk').addEventListener('change', function () {
		var on = $('musicChk').checked;
		try { window.localStorage.setItem(MUSIC_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
		if (game.music) game.music.setEnabled(on);
	});

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
			game.setNoclip($('noclipChk').checked);
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
		var score = game.gs.score, where = game._floorLabel();
		game.clearRun();
		refreshSaves();
		say('Game over on ' + where + ' — final score ' + score + '. Start a new game or load a save.');
	};

	// Formatted explicitly rather than via toLocaleString(): the latter would follow
	// whatever locale the browser happens to be in, so the same save would read
	// "3/7/2026, 9:05 PM" on one machine and "03.07.2026, 21:05" on the next.
	function two(n) { return (n < 10 ? '0' : '') + n; }

	function stamp(ts) {
		var d = new Date(ts);
		return two(d.getDate()) + '/' + two(d.getMonth() + 1) + '/' + d.getFullYear() +
			' ' + two(d.getHours()) + ':' + two(d.getMinutes());
	}

	function describe(info) {
		return info.label + ' · ' + info.health + '% · ' + info.score + ' pts · ' +
			(DIFF_NAME[info.difficulty] || '?') + ' · ' + stamp(info.ts);
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

		if (any) $('savesLabel').textContent = 'Continue a saved game';
		$('newGameLabel').textContent = 'Start a new game';
	}

	// Basic feature note.
	if (location.protocol === 'file:') {
		document.getElementById('fetchHint').textContent =
			'You are opening this from file://. Serving via uhttpd (http://) is recommended so fetch works.';
	}
})();
