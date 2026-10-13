'use strict';
(() => {
  const { hex } = Emu;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const els = {
    editor: $('editor'), gutter: $('gutter'), editorWrap: $('editorWrap'), listing: $('listing'),
    asmErrors: $('asmErrors'), status: $('status'), stack: $('stackView'), regs: $('regs'), flags: $('flags'),
    explain: $('explainNow'), log: $('log'), example: $('exampleSelect'), speed: $('speed'), speedVal: $('speedVal'),
    btnRun: $('btnRun'), btnStep: $('btnStep'), btnBack: $('btnBack'), popReg: $('popReg'),
  };

  let prog = Emu.assemble('');
  let m = new Emu.Machine(prog);
  let history = [];          // { snap, logLen, prevEip }
  let log = [];              // { addr, ins, text, fault }
  let prevRegs = null;       // registers before the last action (for highlighting)
  let lastEip = null;        // address of the last executed instruction
  let timer = null;
  let dirty = false;
  const breakpoints = new Set();

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  /* ---------------------------------------------------------- editor */
  function renderGutter(errLines = new Set()) {
    const n = els.editor.value.split('\n').length;
    let out = '';
    for (let i = 0; i < n; i++) out += errLines.has(i) ? `<span class="err">${i + 1}</span>\n` : `${i + 1}\n`;
    els.gutter.innerHTML = out;
    els.gutter.scrollTop = els.editor.scrollTop;
  }
  els.editor.addEventListener('scroll', () => { els.gutter.scrollTop = els.editor.scrollTop; });
  els.editor.addEventListener('input', () => {
    renderGutter();
    store.set('stackemu.code', els.editor.value);
    if (!dirty && prog.instrs.length) { dirty = true; renderStatus(); }
  });
  els.editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t, value } = els.editor;
      els.editor.value = value.slice(0, s) + '    ' + value.slice(t);
      els.editor.selectionStart = els.editor.selectionEnd = s + 4;
      els.editor.dispatchEvent(new Event('input'));
    }
  });

  function showTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    els.editorWrap.hidden = name !== 'editor';
    els.listing.hidden = name !== 'listing';
    if (name === 'listing') renderListing(true);
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

  function gotoLine(line) {
    showTab('editor');
    const lines = els.editor.value.split('\n');
    const start = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
    els.editor.focus();
    els.editor.setSelectionRange(start, start + lines[line].length);
    els.editor.scrollTop = Math.max(0, line * 20 - 100);
  }

  /* ---------------------------------------------------------- load */
  function assembleAndLoad() {
    stop();
    const p = Emu.assemble(els.editor.value);
    if (p.errors.length) {
      els.asmErrors.hidden = false;
      els.asmErrors.innerHTML = p.errors.map(e => `<div data-line="${e.line}">line ${e.line + 1}: ${esc(e.message)}</div>`).join('');
      els.asmErrors.querySelectorAll('div').forEach(d => d.addEventListener('click', () => gotoLine(Number(d.dataset.line))));
      renderGutter(new Set(p.errors.map(e => e.line)));
      showTab('editor');
      setStatus(`${p.errors.length} assembly error(s). Fix them and press "Assemble & Load".`, 'bad');
      return;
    }
    els.asmErrors.hidden = true;
    renderGutter();
    prog = p;
    m = new Emu.Machine(prog);
    breakpoints.clear();
    history = []; log = []; prevRegs = null; lastEip = null; dirty = false;
    setExplain(null);
    showTab('listing');
    render();
  }

  function resetMachine() {
    stop();
    m = new Emu.Machine(prog);
    history = []; log = []; prevRegs = null; lastEip = null;
    setExplain(null);
    render();
  }

  /* ---------------------------------------------------------- execution */
  function record(result, addr) {
    if (!result) return;
    log.push({ addr, ins: result.ins ? result.ins.text : '', text: result.text, fault: !!result.fault });
    setExplain(log[log.length - 1]);
  }

  function step() {
    if (m.done) { render(); return false; }
    if (!prog.instrs.length) { setExplain({ text: 'No program loaded. Write some code and press "Assemble & Load".', fault: true }); return false; }
    const snap = m.snapshot();
    const addr = m.eip;
    history.push({ snap, logLen: log.length, prevEip: lastEip });
    if (history.length > 20000) history.shift();
    prevRegs = { ...snap.regs, eip: snap.eip };
    const r = m.step();
    lastEip = addr;
    record(r, addr);
    if (m.done && !r.fault && m.status === 'fault') log.push({ addr: m.eip, ins: '', text: m.message, fault: true });
    render();
    return !m.done;
  }

  function back() {
    stop();
    const h = history.pop();
    if (!h) return;
    m.restore(h.snap);
    log.length = h.logLen;
    lastEip = h.prevEip;
    prevRegs = null;
    setExplain(log[log.length - 1] || null, true);
    render();
  }

  function immediate(text) {
    stop();
    const snap = m.snapshot();
    let r;
    try { r = m.immediate(text); }
    catch (e) {
      if (!(e instanceof Emu.AsmError)) throw e;
      setExplain({ ins: text.trim(), text: e.message, fault: true, manual: true });
      return;
    }
    if (!r) return;
    history.push({ snap, logLen: log.length, prevEip: lastEip });
    prevRegs = { ...snap.regs, eip: snap.eip };
    log.push({ addr: null, ins: r.ins.text, text: r.text, fault: !!r.fault, manual: true });
    setExplain(log[log.length - 1]);
    render();
  }

  function run() {
    if (timer) { stop(); return; }
    if (m.done || !prog.instrs.length) { step(); return; }
    els.btnRun.textContent = 'Pause ❚❚';
    els.btnRun.classList.add('active-run');
    let first = true;
    const tick = () => {
      if (!first && breakpoints.has(m.eip)) { stop(); setStatus(`Breakpoint hit at ${hex(m.eip)}.`, 'warn'); return; }
      first = false;
      if (!step()) stop();
    };
    tick();
    if (timer === null && !m.done) timer = setInterval(tick, 1000 / Number(els.speed.value));
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    els.btnRun.textContent = 'Run ▶▶';
    els.btnRun.classList.remove('active-run');
    renderStatus();
  }
  els.speed.addEventListener('input', () => {
    els.speedVal.textContent = `${els.speed.value}/s`;
    if (timer) { clearInterval(timer); timer = null; els.btnRun.textContent = 'Run ▶▶'; run(); }
  });

  /* ---------------------------------------------------------- rendering */
  function setStatus(text, kind = '') {
    els.status.className = 'status ' + kind;
    els.status.textContent = text;
  }
  function renderStatus() {
    if (m.status === 'fault') return setStatus('💥 ' + m.message, 'bad');
    if (m.status === 'exited' || m.status === 'halted') return setStatus('✔ ' + m.message, 'ok');
    if (dirty) return setStatus('Code was edited. Press "Assemble & Load" to run the new version.', 'warn');
    if (!prog.instrs.length) return setStatus('No program loaded. Write code and press "Assemble & Load", or use the playground.', 'warn');
    const where = m.sym(m.eip);
    setStatus(`${timer ? 'Running' : 'Ready'} · ${m.steps} step(s) · next: ${hex(m.eip)}${where ? ' <' + where + '>' : ''}`, timer ? 'warn' : '');
  }

  function setExplain(entry, quiet) {
    if (!entry) {
      els.explain.className = 'explain-now';
      els.explain.innerHTML = '<span class="muted">Press <b>Step ▶</b> to execute the next instruction, or use the playground to push / pop by hand.</span>';
      return;
    }
    els.explain.className = 'explain-now' + (entry.fault ? ' fault' : '');
    const head = entry.ins ? `<span class="ins">${entry.addr != null ? hex(entry.addr) + '  ' : '(manual)  '}${esc(entry.ins)}</span>` : '';
    els.explain.innerHTML = head + esc(entry.text) + (quiet ? ' <span class="muted">(stepped back)</span>' : '');
  }

  function renderLog() {
    els.log.innerHTML = log.slice(-200).reverse().map(e =>
      `<li class="${e.fault ? 'fault' : ''}"><code>${e.addr != null ? hex(e.addr).slice(6) + ' ' : '✎ '}${esc(e.ins)}</code> ${esc(e.text)}</li>`).join('');
    els.log.start = log.length;
  }

  const REG_ORDER = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'esp', 'ebp'];
  function renderRegs() {
    let html = '';
    for (const r of REG_ORDER) {
      const v = m.regs[r];
      const changed = prevRegs && prevRegs[r] !== v;
      const hint = r === 'esp' ? 'top of stack' : r === 'ebp' ? 'frame base' : String(v | 0);
      html += `<div class="reg r-${r}${changed ? ' changed' : ''}"><div class="n"><b>${r}</b><em>${hint}</em></div><div class="v">${hex(v)}</div></div>`;
    }
    const sym = m.sym(m.eip);
    const eipChanged = prevRegs && prevRegs.eip !== m.eip;
    html += `<div class="reg r-eip${eipChanged ? ' changed' : ''}"><div class="n"><b>eip</b><em>next instruction${sym ? ' · ' + esc(sym) : ''}</em></div><div class="v">${hex(m.eip)}</div></div>`;
    els.regs.innerHTML = html;
    els.flags.innerHTML = Object.entries(m.flags).map(([k, v]) => `<span class="flag${v ? ' on' : ''}" title="${{ ZF: 'zero', SF: 'sign', CF: 'carry', OF: 'overflow' }[k]} flag">${k}=${v}</span>`).join('');
  }

  function renderStack() {
    const { STACK_TOP, STACK_BASE } = Emu;
    const esp = m.regs.esp, ebp = m.regs.ebp;
    const inStack = a => a >= STACK_BASE && a < STACK_TOP;
    const espSlot = (esp & ~3) >>> 0, ebpSlot = (ebp & ~3) >>> 0;
    let bottom = Math.min(inStack(esp) ? espSlot : STACK_TOP - 4, m.low) - 4 * 5;
    bottom = Math.max(bottom, STACK_BASE);
    const frameOk = inStack(ebp) && inStack(esp) && ebp >= esp;
    let html = '';
    if (!inStack(esp)) html += `<div class="stack-gap">⚠ ESP = ${hex(esp)} points outside the stack</div>`;
    for (let a = STACK_TOP - 4; a >= bottom; a -= 4) {
      const tag = m.tags[a];
      const cls = ['srow'];
      if (inStack(esp) && a < espSlot) cls.push('free');
      if (frameOk && a >= espSlot && a <= ebpSlot) cls.push('frame');
      if (frameOk && a === ebpSlot) cls.push('frame-top');
      if (m.writes.has(a)) cls.push('changed');
      if (tag && (tag.kind === 'ret' || tag.kind === 'ebp')) cls.push('k-' + tag.kind);
      if (tag && tag.corrupt) cls.push('corrupt');
      const v = m.read(a, 4);
      let ascii = '';
      for (let i = 0; i < 4; i++) { const b = (v >>> (8 * i)) & 0xff; ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·'; }
      const ptrs = (a === espSlot ? '<span class="ptr esp">ESP</span>' : '') + (a === ebpSlot ? '<span class="ptr ebp">EBP</span>' : '');
      let off = '';
      if (inStack(ebp)) { const d = (a - ebp) | 0; off = d === 0 ? 'ebp' : `ebp${d > 0 ? '+' : '−'}${Math.abs(d)}`; }
      else if (inStack(esp)) { const d = (a - esp) | 0; off = d === 0 ? 'esp' : `esp${d > 0 ? '+' : '−'}${Math.abs(d)}`; }
      let note = tag ? tag.text : '';
      if (tag && tag.corrupt) note = (tag.kind === 'ret' ? 'return address' : 'saved EBP') + ' OVERWRITTEN!';
      if (!note && cls.includes('free') && v !== 0) note = 'stale data (already popped)';
      html += `<div class="${cls.join(' ')}" data-addr="${a}"><span class="ptrs">${ptrs}</span><span class="addr">${hex(a)}</span><span class="off">${off}</span><span class="val">${hex(v)}</span><span class="ascii">${esc(ascii)}</span><span class="note" title="${esc(note)}">${esc(note)}</span></div>`;
    }
    if (bottom > STACK_BASE) html += `<div class="stack-gap">… lower addresses (unused) down to ${hex(STACK_BASE)}</div>`;
    els.stack.innerHTML = html;
    const row = els.stack.querySelector('.ptr.esp');
    if (row) {
      const el = row.closest('.srow');
      const top = el.offsetTop, h = els.stack.clientHeight;
      if (top < els.stack.scrollTop + 30 || top > els.stack.scrollTop + h - 90) els.stack.scrollTop = Math.max(0, top - h + 150);
    }
  }

  function renderListing(force) {
    if (els.listing.hidden && !force) return;
    if (!prog.instrs.length) { els.listing.innerHTML = '<div class="lst-label">; no program loaded</div>'; return; }
    let html = '';
    for (const ins of prog.instrs) {
      for (const l of ins.labels) html += `<div class="lst-label">${esc(l)}:</div>`;
      const cls = ['lst-row'];
      if (ins.addr === m.eip && !m.done) cls.push('cur');
      if (ins.addr === lastEip) cls.push('prev');
      html += `<div class="${cls.join(' ')}" data-addr="${ins.addr}" title="click to toggle a breakpoint"><span class="bp">${breakpoints.has(ins.addr) ? '●' : ''}</span><span class="addr">${hex(ins.addr)}</span><span>    ${esc(ins.text)}</span></div>`;
    }
    els.listing.innerHTML = html;
    const cur = els.listing.querySelector('.cur') || els.listing.querySelector('.prev');
    if (cur) {
      const top = cur.offsetTop, h = els.listing.clientHeight;
      if (top < els.listing.scrollTop + 20 || top > els.listing.scrollTop + h - 40) els.listing.scrollTop = Math.max(0, top - h / 3);
    }
  }
  els.listing.addEventListener('click', e => {
    const row = e.target.closest('.lst-row');
    if (!row) return;
    const a = Number(row.dataset.addr);
    breakpoints.has(a) ? breakpoints.delete(a) : breakpoints.add(a);
    renderListing();
  });

  function render() {
    renderRegs();
    renderStack();
    renderListing();
    renderLog();
    renderStatus();
    els.btnBack.disabled = history.length === 0;
    els.btnStep.disabled = m.done;
  }

  /* ---------------------------------------------------------- wiring */
  $('btnAssemble').addEventListener('click', assembleAndLoad);
  els.btnStep.addEventListener('click', () => { stop(); step(); });
  els.btnBack.addEventListener('click', back);
  els.btnRun.addEventListener('click', run);
  $('btnReset').addEventListener('click', resetMachine);
  $('btnPush').addEventListener('click', () => immediate('push ' + $('pushVal').value));
  $('btnPop').addEventListener('click', () => immediate('pop ' + els.popReg.value));
  $('btnExec').addEventListener('click', () => immediate($('execLine').value));
  $('pushVal').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnPush').click(); });
  $('execLine').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnExec').click(); });
  $('btnClearLog').addEventListener('click', () => { log = []; history.forEach(h => { h.logLen = 0; }); setExplain(null); renderLog(); });

  els.popReg.innerHTML = Emu.REG32.map(r => `<option>${r}</option>`).join('');

  EXAMPLES.forEach((ex, i) => els.example.add(new Option(ex.name, i)));
  els.example.addEventListener('change', () => {
    els.editor.value = EXAMPLES[els.example.value].code;
    store.set('stackemu.code', els.editor.value);
    assembleAndLoad();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); assembleAndLoad(); return; }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); stop(); step(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  });

  const root = document.documentElement;
  const savedTheme = store.get('stackemu.theme');
  if (savedTheme) root.dataset.theme = savedTheme;
  else if (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) root.dataset.theme = 'light';
  $('themeBtn').addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    store.set('stackemu.theme', root.dataset.theme);
  });

  $('stackRange').textContent = `${hex(Emu.STACK_BASE)}–${hex(Emu.STACK_TOP - 1)}`;
  els.speedVal.textContent = `${els.speed.value}/s`;
  els.editor.value = store.get('stackemu.code') || EXAMPLES[0].code;
  renderGutter();
  assembleAndLoad();
})();
