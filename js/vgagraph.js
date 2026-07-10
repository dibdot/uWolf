/*
 * vgagraph.js — decoder for the Wolfenstein 3D VGAGRAPH graphics lump.
 *
 * The status bar, the BJ face, the number/weapon/key icons and every other UI
 * graphic live in VGAGRAPH (not VSWAP). Decoding needs three of the original
 * files: VGADICT (a 255-node Huffman dictionary), VGAHEAD (3-byte chunk
 * offsets) and VGAGRAPH (the Huffman-compressed chunks). This is an ORIGINAL
 * implementation of the pipeline described in the GPL Wolf4SDL source
 * (id_ca.cpp: CAL_SetupGrFile / CAL_HuffExpand / CAL_ExpandGrChunk, and the
 * planar pixel layout from id_vl.cpp: VL_MemToScreen).
 *
 * Chunk numbering is version-specific; the caller passes the layout it wants
 * (WL6 by default). getPic(chunk) returns a ready-to-blit <canvas>.
 */
(function (root) {
	'use strict';

	var STRUCTPIC = 0, STARTPICS = 3;

	// Huffman expansion (CAL_HuffExpand). nodes: array of {b0,b1}; head is 254.
	// Reads bits LSB-first; node values < 256 are output bytes, >= 256 index a
	// child node (value - 256). Stops once `length` bytes are produced.
	function huffExpand(nodes, src, length) {
		var dest = new Uint8Array(length);
		var head = 254, huff = head, di = 0, si = 0;
		var val = src[si++], mask = 1, nodeval;
		while (true) {
			nodeval = (val & mask) ? nodes[huff].b1 : nodes[huff].b0;
			if (mask === 0x80) { val = src[si++]; mask = 1; } else mask <<= 1;
			if (nodeval < 256) {
				dest[di++] = nodeval;
				huff = head;
				if (di >= length) break;
			} else {
				huff = nodeval - 256;
			}
		}
		return dest;
	}

	// Deplane a 4-plane VGA pic into an RGBA byte array. Source index for pixel
	// (x,y): (y*(w/4) + x/4) + (x&3)*(w/4)*h.
	function deplane(planar, w, h, pal, rgba) {
		var wq = w >> 2;
		for (var y = 0; y < h; y++) {
			for (var x = 0; x < w; x++) {
				var col = planar[(y * wq + (x >> 2)) + (x & 3) * wq * h];
				var d = (y * w + x) * 4, p = col * 3;
				rgba[d] = pal[p]; rgba[d + 1] = pal[p + 1]; rgba[d + 2] = pal[p + 2]; rgba[d + 3] = 255;
			}
		}
		return rgba;
	}

	function VgaGraph(dictBuf, headBuf, graphBuf, pal) {
		this.pal = pal;
		this.graphBuf = graphBuf;
		this.nodes = this._parseDict(dictBuf);
		this.starts = this._parseHead(headBuf);
		this.pictable = this._parsePictable();
		this.picCache = {};
	}

	VgaGraph.prototype._parseDict = function (buf) {
		var dv = new DataView(buf);
		var nodes = new Array(255);
		for (var i = 0; i < 255; i++) {
			nodes[i] = { b0: dv.getUint16(i * 4, true), b1: dv.getUint16(i * 4 + 2, true) };
		}
		return nodes;
	};

	VgaGraph.prototype._parseHead = function (buf) {
		var b = new Uint8Array(buf);
		var n = (b.length / 3) | 0;
		var starts = new Int32Array(n);
		for (var i = 0, o = 0; i < n; i++, o += 3) {
			var v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
			starts[i] = (v === 0x00FFFFFF) ? -1 : v;
		}
		return starts;
	};

	// Locate a chunk's compressed span, returning {pos, complen} or null.
	VgaGraph.prototype._span = function (chunk) {
		if (chunk < 0 || chunk + 1 >= this.starts.length) return null;
		var pos = this.starts[chunk];
		if (pos < 0) return null;
		var next = -1;
		for (var i = chunk + 1; i < this.starts.length; i++) {
			if (this.starts[i] >= 0) { next = this.starts[i]; break; }
		}
		if (next < 0) next = this.graphBuf.byteLength;
		return { pos: pos, complen: next - pos };
	};

	// Expand a chunk: first 4 bytes are the decompressed length, the rest is
	// Huffman-compressed. Returns a Uint8Array or null if the chunk is absent.
	VgaGraph.prototype.expand = function (chunk) {
		var s = this._span(chunk);
		if (!s) return null;
		var dv = new DataView(this.graphBuf, s.pos, 4);
		var expanded = dv.getInt32(0, true);
		var src = new Uint8Array(this.graphBuf, s.pos + 4, s.complen - 4);
		return huffExpand(this.nodes, src, expanded);
	};

	// pictable comes from STRUCTPIC (chunk 0): pairs of int16 (width, height).
	VgaGraph.prototype._parsePictable = function () {
		var raw = this.expand(STRUCTPIC);
		if (!raw) return [];
		var dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
		var count = (raw.length / 4) | 0, t = new Array(count);
		for (var i = 0; i < count; i++) {
			t[i] = { w: dv.getInt16(i * 4, true), h: dv.getInt16(i * 4 + 2, true) };
		}
		return t;
	};

	VgaGraph.prototype.has = function (chunk) {
		var idx = chunk - STARTPICS;
		return idx >= 0 && idx < this.pictable.length && this._span(chunk) != null;
	};

	VgaGraph.prototype.picSize = function (chunk) {
		var idx = chunk - STARTPICS;
		return (idx >= 0 && idx < this.pictable.length) ? this.pictable[idx] : null;
	};

	// Return a <canvas> for a pic chunk (cached). Requires a DOM.
	VgaGraph.prototype.getPic = function (chunk) {
		if (this.picCache[chunk]) return this.picCache[chunk];
		var size = this.picSize(chunk);
		if (!size || size.w <= 0 || size.h <= 0) return null;
		var planar = this.expand(chunk);
		if (!planar) return null;
		var canvas = document.createElement('canvas');
		canvas.width = size.w; canvas.height = size.h;
		var ctx = canvas.getContext('2d');
		var img = ctx.createImageData(size.w, size.h);
		deplane(planar, size.w, size.h, this.pal, img.data);
		ctx.putImageData(img, 0, 0);
		this.picCache[chunk] = canvas;
		return canvas;
	};

	VgaGraph._huffExpand = huffExpand;   // exposed for tests
	VgaGraph._deplane = deplane;
	VgaGraph.STARTPICS = STARTPICS;

	root.WolfVGA = { VgaGraph: VgaGraph };
})(typeof window !== 'undefined' ? window : this);
