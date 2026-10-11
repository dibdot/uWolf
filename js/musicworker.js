/*
 * musicworker.js — the FM music, rendered off the main thread.
 *
 * A plain (classic) Web Worker: it loads the same opl2.js and music.js the page
 * uses and drives createFmEngine() from them. The page asks for blocks of
 * samples and schedules them itself (WorkerSink in music.js), so a long frame
 * on the main thread cannot break the music up. Unlike an AudioWorklet, a
 * worker needs no secure context: this works over plain http:// from the
 * router.
 *
 * Messages in:  init {rate} · track {track} · silence · render {frames, gen}
 *               · fx {index, inst, block, data}
 * Messages out: block {gen, data} · fx {index, data} · error {message, index}
 */
'use strict';
importScripts('opl2.js' + self.location.search, 'music.js' + self.location.search);

var engine = null, rate = 0;

self.onmessage = function (e) {
	var m = e.data;
	try {
		if (m.type === 'init') {
			rate = m.rate;
			engine = self.WolfMusic.createFmEngine(self.OPL2, rate);
		} else if (m.type === 'track') {
			engine.setTrack(m.track);
		} else if (m.type === 'silence') {
			engine.silence();
		} else if (m.type === 'render') {
			var out = new Float32Array(m.frames);
			engine.fill(out);
			self.postMessage({ type: 'block', gen: m.gen, data: out }, [out.buffer]);
		} else if (m.type === 'fx') {
			var pcm = self.WolfMusic.renderFx(self.OPL2, rate, m).slice();
			self.postMessage({ type: 'fx', index: m.index, data: pcm }, [pcm.buffer]);
		}
	} catch (err) {
		self.postMessage({ type: 'error', message: String(err && err.message || err),
			index: m.type === 'fx' ? m.index : null });
	}
};
