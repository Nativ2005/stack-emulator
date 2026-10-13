'use strict';
/*
 * IDA-style control-flow graph: split each function into basic blocks and
 * draw green (taken) / red (not taken) / blue (unconditional) arrows.
 */
const Graph = (() => {
  const FLAG_OPS = new Set(['cmp', 'test', 'add', 'sub', 'and', 'or', 'xor', 'inc', 'dec', 'neg', 'shl', 'sal', 'shr', 'sar', 'imul']);
  const SYM = { e: '==', ne: '!=', l: '<', ge: '>=', le: '<=', g: '>', b: '<', ae: '>=', be: '<=', a: '>' };
  const NEG = { e: 'ne', ne: 'e', l: 'ge', ge: 'l', le: 'g', g: 'le', b: 'ae', ae: 'b', be: 'a', a: 'be', s: 'ns', ns: 's' };
  const UNSIGNED = new Set(['b', 'ae', 'be', 'a']);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const short = a => (a >>> 0).toString(16).slice(-4);

  /* Turn "cmp eax, 1 / jg" into "eax > 1". */
  function condText(c, f) {
    if (!f) return null;
    const a = f.args;
    let x, y = '0';
    if (f.op === 'cmp') { x = a[0].text; y = a[1].text; }
    else if (f.op === 'test') x = a[0].text === a[1].text ? a[0].text : `${a[0].text} & ${a[1].text}`;
    else x = a[0].text;
    if (c === 's' || c === 'ns') return `${y === '0' ? x : `${x} − ${y}`} ${c === 's' ? '<' : '>='} 0`;
    return `${x} ${SYM[c]} ${y}${UNSIGNED.has(c) ? ' (u)' : ''}`;
  }

  function analyze(prog) {
    const ins = prog.instrs;
    if (!ins.length) return { functions: [], fnOf: () => null };
    const idx = new Map(ins.map((x, i) => [x.addr, i]));
    const isJcc = x => x.op in Emu.JCC;
    const isTerm = x => isJcc(x) || x.op === 'jmp' || x.op === 'ret' || x.op === 'hlt';
    const target = x => {
      const o = x.args[0];
      if (!o) return null;
      if (o.t === 'label') return prog.labels[o.name];
      if (o.t === 'imm') return o.value >>> 0;
      return null;
    };

    const jumpTargets = new Set(), starts = new Set([prog.entry]);
    for (const x of ins) {
      if (isJcc(x) || x.op === 'jmp') { const t = target(x); if (t != null) jumpTargets.add(t); }
      if (x.op === 'call') { const t = target(x); if (t != null && idx.has(t)) starts.add(t); }
    }
    // A named label that can't be reached by falling through and isn't a jump target is a function too (e.g. win()).
    ins.forEach((x, i) => {
      if (x.labels.some(l => !l.startsWith('.')) && !jumpTargets.has(x.addr) && (i === 0 || isTerm(ins[i - 1]))) starts.add(x.addr);
    });

    const functions = [...starts].filter(a => idx.has(a)).sort((p, q) => p - q).map(start => {
      const seen = new Set(), leaders = new Set([start]), work = [idx.get(start)];
      while (work.length) {
        let i = work.pop();
        while (i < ins.length) {
          if (seen.has(i)) { leaders.add(ins[i].addr); break; }
          if (i !== idx.get(start) && starts.has(ins[i].addr)) break;   // fell into another function
          seen.add(i);
          const x = ins[i];
          if (isJcc(x) || x.op === 'jmp') {
            const t = target(x);
            if (t != null && idx.has(t) && !(starts.has(t) && t !== start)) { leaders.add(t); work.push(idx.get(t)); }
            if (x.op === 'jmp') break;
            if (i + 1 < ins.length) leaders.add(ins[i + 1].addr);
          } else if (x.op === 'ret' || x.op === 'hlt') break;
          i++;
        }
      }
      const order = [...seen].sort((p, q) => p - q);
      const blocks = [];
      let cur = null;
      order.forEach((i, k) => {
        const x = ins[i];
        if (!cur || leaders.has(x.addr) || order[k - 1] !== i - 1 || isTerm(ins[i - 1])) {
          cur = { id: blocks.length, start: x.addr, instrs: [] };
          blocks.push(cur);
        }
        cur.instrs.push(x);
      });
      const blockAt = new Map(blocks.map(b => [b.start, b.id]));
      const blockOf = new Map();
      blocks.forEach(b => b.instrs.forEach(x => blockOf.set(x.addr, b.id)));

      const edges = [];
      for (const b of blocks) {
        const last = b.instrs[b.instrs.length - 1];
        const nextAddr = last.next;
        if (isJcc(last)) {
          const c = Emu.JCC[last.op];
          let flagIns = null;
          for (let k = b.instrs.length - 2; k >= 0; k--) if (FLAG_OPS.has(b.instrs[k].op)) { flagIns = b.instrs[k]; break; }
          const t = target(last);
          if (blockAt.has(t)) edges.push({ from: b.id, to: blockAt.get(t), kind: 'true', label: condText(c, flagIns) || 'taken' });
          if (blockAt.has(nextAddr)) edges.push({ from: b.id, to: blockAt.get(nextAddr), kind: 'false', label: condText(NEG[c], flagIns) || 'not taken' });
        } else if (last.op === 'jmp') {
          const t = target(last);
          if (blockAt.has(t)) edges.push({ from: b.id, to: blockAt.get(t), kind: 'jmp', label: '' });
        } else if (last.op !== 'ret' && last.op !== 'hlt' && blockAt.has(nextAddr)) {
          edges.push({ from: b.id, to: blockAt.get(nextAddr), kind: 'jmp', label: '' });
        }
      }
      const first = ins[idx.get(start)];
      const name = first.labels.find(l => !l.startsWith('.')) || Emu.hex(start);
      return { name, start, blocks, edges, blockOf };
    });
    const fnOf = addr => functions.find(f => f.blockOf.has(addr)) || null;
    return { functions, fnOf, labels: prog.labels };
  }

  /* ------------------------------------------------------------ view */
  class View {
    constructor(root, { onBreakpoint }) {
      this.onBreakpoint = onBreakpoint;
      this.zoom = 1;
      this.follow = true;
      this.data = { functions: [], fnOf: () => null };
      this.fn = null;
      root.innerHTML = `
        <div class="gbar">
          <select class="gfn" data-tip="Which function to draw. Each function gets its own graph."></select>
          <label class="gfollow" data-tip="Automatically show the function that is running right now"><input type="checkbox" checked> follow</label>
          <span class="gspacer"></span>
          <button class="small gz" data-z="-1" data-tip="Zoom out">−</button>
          <button class="small gz" data-z="0" data-tip="Fit the graph to the panel">fit</button>
          <button class="small gz" data-z="1" data-tip="Zoom in">+</button>
        </div>
        <div class="glegend">
          <span><i class="gl gl-true"></i>condition true (jump)</span>
          <span><i class="gl gl-false"></i>condition false</span>
          <span><i class="gl gl-jmp"></i>always</span>
        </div>
        <div class="gscroll"><div class="gsizer"><div class="gcanvas"></div></div></div>`;
      this.sel = root.querySelector('.gfn');
      this.followBox = root.querySelector('.gfollow input');
      this.scroll = root.querySelector('.gscroll');
      this.sizer = root.querySelector('.gsizer');
      this.canvas = root.querySelector('.gcanvas');
      this.sel.addEventListener('change', () => {
        this.follow = false; this.followBox.checked = false;
        this.show(this.data.functions[this.sel.value]);
      });
      this.followBox.addEventListener('change', () => { this.follow = this.followBox.checked; if (this.state) this.update(this.state); });
      root.querySelectorAll('.gz').forEach(b => b.addEventListener('click', () => {
        const d = Number(b.dataset.z);
        this.setZoom(d === 0 ? this.fitZoom() : this.zoom * (d > 0 ? 1.2 : 1 / 1.2));
      }));
      this.canvas.addEventListener('click', e => {
        const call = e.target.closest('.gcall');
        if (call) {
          e.stopPropagation();
          this.follow = false; this.followBox.checked = false;
          this.show(this.data.functions.find(f => f.start === Number(call.dataset.fn)));
          return;
        }
        const line = e.target.closest('.gline');
        if (line) this.onBreakpoint(Number(line.dataset.addr));
      });
    }

    setData(data) {
      this.data = data;
      this.sel.innerHTML = data.functions.map((f, i) => `<option value="${i}">${esc(f.name)}()</option>`).join('');
      this.fn = null;
      this.dirty = true;
    }
    visible() { return this.scroll.offsetParent !== null; }

    show(fn) {
      this.fn = fn || null;
      this.dirty = true;
      this.build();
      if (this.state) this.update(this.state);
    }

    build() {
      if (!this.visible()) return;
      this.dirty = false;
      const fn = this.fn;
      this.canvas.innerHTML = '';
      if (!fn) { this.canvas.innerHTML = '<div class="gempty">No code to draw yet.</div>'; this.sizer.style.width = this.sizer.style.height = ''; this.canvas.style.transform = ''; return; }
      this.sel.value = String(this.data.functions.indexOf(fn));

      // 1. create the block boxes and measure them
      const boxes = fn.blocks.map(b => {
        const div = document.createElement('div');
        div.className = 'gblock';
        const labels = b.instrs[0].labels;
        const head = b.id === 0 ? `${esc(fn.name)}()` : labels.length ? esc(labels.join(', ')) + ':' : `loc_${short(b.start)}`;
        div.innerHTML = `<div class="ghead">${head}</div>` + b.instrs.map(x => {
          let extra = '';
          if (x.op === 'call' && x.args[0].t === 'label') {
            const t = this.data.functions.find(f => f.start === this.data.labels[x.args[0].name]);
            if (t) extra = ` <span class="gcall" data-fn="${t.start}" data-tip="Open the graph of ${esc(t.name)}()">↗</span>`;
          }
          return `<div class="gline" data-addr="${x.addr}"><span class="gbp"></span><span class="ga">${short(x.addr)}</span><span class="gt">${esc(x.text)}</span>${extra}</div>`;
        }).join('');
        this.canvas.appendChild(div);
        return { div, w: div.offsetWidth, h: div.offsetHeight };
      });

      // 2. layers: longest path over forward edges (blocks are in address order)
      const n = fn.blocks.length, layer = new Array(n).fill(0);
      for (let i = 0; i < n; i++)
        for (const e of fn.edges) if (e.from === i && e.to > i) layer[e.to] = Math.max(layer[e.to], layer[i] + 1);
      const L = Math.max(...layer) + 1;
      const rows = Array.from({ length: L }, () => []);
      layer.forEach((l, i) => rows[l].push(i));

      const GAP_Y = 64, GAP_X = 40, M = 20, LANE = 14;
      let leftLanes = 0, rightLanes = 0;
      for (const e of fn.edges) {
        const d = layer[e.to] - layer[e.from];
        e.route = d === 1 ? 'down' : d > 1 ? 'left' : 'right';
        e.lane = e.route === 'left' ? leftLanes++ : e.route === 'right' ? rightLanes++ : 0;
      }
      const rowW = rows.map(r => r.reduce((s, i) => s + boxes[i].w, 0) + GAP_X * Math.max(0, r.length - 1));
      const maxW = Math.max(...rowW);
      const LM = M + leftLanes * LANE + (leftLanes ? 10 : 0);
      let y = M;
      const pos = [];
      rows.forEach((r, l) => {
        let x = LM + (maxW - rowW[l]) / 2;
        const h = Math.max(...r.map(i => boxes[i].h));
        for (const i of r) { pos[i] = { x, y, w: boxes[i].w, h: boxes[i].h }; x += boxes[i].w + GAP_X; }
        y += h + GAP_Y;
      });
      const W = LM + maxW + M + rightLanes * LANE + (rightLanes ? 10 : 0);
      const H = y - GAP_Y + M;
      pos.forEach((p, i) => { boxes[i].div.style.left = p.x + 'px'; boxes[i].div.style.top = p.y + 'px'; });

      // 3. ports: two exits (false left, true right) and spread-out entries
      const outX = (e) => {
        const p = pos[e.from], outs = fn.edges.filter(o => o.from === e.from);
        if (outs.length < 2) return p.x + p.w / 2;
        return p.x + p.w * (e.kind === 'false' ? 0.3 : 0.7);
      };
      const inX = new Map();
      for (let i = 0; i < n; i++) {
        const ins = fn.edges.filter(e => e.to === i).sort((a, b) => outX(a) - outX(b));
        ins.forEach((e, k) => inX.set(e, pos[i].x + pos[i].w * (k + 1) / (ins.length + 1)));
      }

      // 4. arrows
      let svg = `<svg class="gsvg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>` +
        ['true', 'false', 'jmp'].map(k => `<marker id="gm-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="gm-${k}"/></marker>`).join('') +
        '</defs>';
      fn.edges.forEach((e, k) => {
        const s = pos[e.from], t = pos[e.to];
        const sx = outX(e), sy = s.y + s.h, ex = inX.get(e), ey = t.y - 1;
        let d;
        if (e.route === 'down') d = `M${sx},${sy} C${sx},${sy + GAP_Y / 2} ${ex},${ey - GAP_Y / 2} ${ex},${ey}`;
        else {
          const lx = e.route === 'left' ? LM - 10 - e.lane * LANE : LM + maxW + 10 + e.lane * LANE;
          const r = 8, y1 = sy + 14 + (e.lane % 3) * 3, y2 = ey - 14 - (e.lane % 3) * 3;
          const dx1 = lx > sx ? r : -r, dx2 = ex > lx ? r : -r;
          d = `M${sx},${sy} V${y1 - r} Q${sx},${y1} ${sx + dx1},${y1} H${lx - dx1} Q${lx},${y1} ${lx},${y1 - r} V${y2 + r} Q${lx},${y2} ${lx + dx2},${y2} H${ex - dx2} Q${ex},${y2} ${ex},${y2 + r} V${ey}`;
        }
        svg += `<path class="gedge ge-${e.kind}" data-edge="${k}" d="${d}" marker-end="url(#gm-${e.kind})"/>`;
        if (e.label) {
          const left = e.kind === 'false';
          svg += `<text class="glabel gl-${e.kind}" data-edge="${k}" x="${sx + (left ? -5 : 5)}" y="${sy + 15}" text-anchor="${left ? 'end' : 'start'}">${esc(e.label)}</text>`;
        }
      });
      svg += '</svg>';
      this.canvas.insertAdjacentHTML('afterbegin', svg);
      this.W = W; this.H = H;
      this.canvas.style.width = W + 'px';
      this.canvas.style.height = H + 'px';
      this.setZoom(this.fitZoom());
    }

    fitZoom() { return this.W ? Math.max(0.45, Math.min(1, (this.scroll.clientWidth - 6) / this.W)) : 1; }
    setZoom(z) {
      this.zoom = Math.max(0.3, Math.min(2, z));
      this.canvas.style.transform = `scale(${this.zoom})`;
      this.sizer.style.width = this.W * this.zoom + 'px';
      this.sizer.style.height = this.H * this.zoom + 'px';
    }

    /* Live state: current line/block, last executed line, the arrow just taken, breakpoints. */
    update(state) {
      this.state = state;
      if (!this.visible()) return;
      const { eip, lastEip, breakpoints, done } = state;
      if (this.follow) {
        const f = this.data.fnOf(eip) || (lastEip != null && this.data.fnOf(lastEip));
        if (f && f !== this.fn) { this.fn = f; this.dirty = true; }
        if (!this.fn && this.data.functions.length) { this.fn = this.data.functions[0]; this.dirty = true; }
      } else if (!this.fn && this.data.functions.length) { this.fn = this.data.functions[0]; this.dirty = true; }
      if (this.dirty) this.build();
      const fn = this.fn;
      if (!fn) return;
      this.canvas.querySelectorAll('.gline').forEach(l => {
        const a = Number(l.dataset.addr);
        l.classList.toggle('cur', a === eip && !done);
        l.classList.toggle('prev', a === lastEip);
        l.querySelector('.gbp').textContent = breakpoints.has(a) ? '●' : '';
      });
      const curBlock = fn.blockOf.get(eip);
      this.canvas.querySelectorAll('.gblock').forEach((b, i) => b.classList.toggle('gcur', i === curBlock && !done));
      this.canvas.querySelectorAll('[data-edge]').forEach(p => {
        const e = fn.edges[Number(p.dataset.edge)];
        const from = fn.blocks[e.from], to = fn.blocks[e.to];
        p.classList.toggle('hot', lastEip === from.instrs[from.instrs.length - 1].addr && eip === to.start);
      });
      const cur = this.canvas.querySelector('.gline.cur');
      if (cur) {
        const box = cur.closest('.gblock');
        const z = this.zoom, top = (box.offsetTop + cur.offsetTop) * z, left = box.offsetLeft * z;
        const s = this.scroll;
        if (top < s.scrollTop + 10 || top > s.scrollTop + s.clientHeight - 30) s.scrollTop = top - s.clientHeight / 3;
        if (left + box.offsetWidth * z < s.scrollLeft + 20 || left > s.scrollLeft + s.clientWidth - 20) s.scrollLeft = left - 20;
      }
    }
  }

  return { analyze, View };
})();
