'use strict';
(() => {
  const { hex } = Emu;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const els = {
    editor: $('editor'), gutter: $('gutter'), editorWrap: $('editorWrap'), listing: $('listing'),
    asmErrors: $('asmErrors'), status: $('status'), stack: $('stackView'), regs: $('regs'), flags: $('flags'),
    explain: $('explainNow'), log: $('log'), example: $('exampleSelect'), speed: $('speed'), speedVal: $('speedVal'),
    btnRun: $('btnRun'), btnStep: $('btnStep'), btnBack: $('btnBack'), popReg: $('popReg'), intro: $('intro'), tip: $('tip'),
  };

  let prog = Emu.assemble('');
  let m = new Emu.Machine(prog);
  let history = [];          // { snap, logLen, prevEip }
  let log = [];              // { addr, ins, text, plain, fault }
  let prevRegs = null;       // registers before the last action (for highlighting + animation)
  let lastEip = null;        // address of the last executed instruction
  let timer = null;
  let dirty = false;
  const breakpoints = new Set();

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const settings = {
    mode: store.get('stackemu.mode') || 'beginner',
    num: store.get('stackemu.num') || 'dec',
  };
  const beginner = () => settings.mode === 'beginner';

  /* ---------------------------------------------------------- formatting */
  const isAddr = v => (v >= Emu.STACK_BASE && v < Emu.STACK_TOP) || (v >= Emu.CODE_BASE && v < prog.end) || v === Emu.EXIT_ADDR;
  /* Value for display. In decimal mode, addresses stay hex (a decimal address means nothing to anyone). */
  /* Huge numbers are clearer in hex too (e.g. 0x41414141 = "AAAA" rather than 1094795585). */
  function fmt(v) {
    if (settings.num === 'hex' || isAddr(v) || Math.abs(v | 0) >= 1e6) return hex(v);
    return String(v | 0);
  }
  function fmtAlt(v) {
    if (settings.num === 'hex') return String(v | 0);
    return isAddr(v) ? 'address' : hex(v);
  }

  const REG_INFO = {
    eax: ['return value', 'EAX: general-purpose register. When a function finishes, its RETURN VALUE is left in EAX.'],
    ebx: ['general', 'EBX: general-purpose register, can hold any value.'],
    ecx: ['counter', 'ECX: general-purpose register, often used as a loop COUNTER.'],
    edx: ['general', 'EDX: general-purpose register.'],
    esi: ['general', 'ESI: general-purpose register ("source index").'],
    edi: ['pointer', 'EDI: general-purpose register ("destination index"), often a pointer you write through.'],
    esp: ['top of stack', 'ESP, the Stack Pointer: always holds the address of the TOP of the stack (the last value pushed). push moves it down 4, pop moves it up 4.'],
    ebp: ['frame anchor', "EBP, the Base Pointer: a fixed anchor for the current function. Arguments are at [ebp+8], [ebp+12]…, local variables at [ebp-4], [ebp-8]…"],
    eip: ['next instruction', 'EIP, the Instruction Pointer: address of the NEXT instruction the CPU will run. call, ret and jumps change it.'],
  };
  const SLOT_TIPS = {
    ret: 'Return address. "call" saved the address of the next instruction here, so "ret" knows where to continue after the function is done.',
    ebp: "Saved EBP. At the start of a function, \"push ebp\" stores the caller's EBP here; \"pop ebp\" or \"leave\" restores it at the end.",
    arg: 'Argument. The caller pushes arguments before "call". Inside the function they are read as [ebp+8], [ebp+12], …',
    local: 'Local variable space. "sub esp, N" reserves it; the function uses it as [ebp-4], [ebp-8], …',
    push: 'A value put on the stack with "push".',
    data: 'A value on the stack.',
    free: 'Free space: it is below ESP, so it is not part of the stack anymore. The old value stays in memory until something overwrites it.',
    corrupt: 'OVERWRITTEN! Something wrote past the end of a buffer (a buffer overflow) and replaced this important value.',
  };
  const FLAG_TIPS = {
    ZF: 'Zero flag: 1 if the last result was zero (e.g. cmp of two equal values).',
    SF: 'Sign flag: 1 if the last result was negative.',
    CF: 'Carry flag: 1 if the last unsigned operation carried / borrowed.',
    OF: 'Overflow flag: 1 if the last signed operation overflowed.',
  };

  /* ---------------------------------------------------------- tooltips */
  let tipFor = null;
  function showTip(el) {
    tipFor = el;
    els.tip.textContent = el.dataset.tip;
    els.tip.hidden = false;
    const r = el.getBoundingClientRect(), t = els.tip.getBoundingClientRect();
    let x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    let y = r.bottom + 8;
    if (y + t.height > window.innerHeight - 8) y = r.top - t.height - 8;
    els.tip.style.left = x + 'px';
    els.tip.style.top = y + 'px';
  }
  function hideTip() { els.tip.hidden = true; tipFor = null; }
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) return hideTip();
    if (el !== tipFor) showTip(el);
  });
  document.addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el) showTip(el); });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('scroll', hideTip, true);

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
    log.push({ addr, ins: r.ins ? r.ins.text : '', text: r.text, plain: r.plain, fault: !!r.fault });
    if (m.status === 'fault' && !r.fault) log.push({ addr: m.eip, ins: '', text: m.message, plain: '💥 Crash! ' + m.message, fault: true });
    setExplain(log[log.length - 1]);
    render(true);
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
    log.push({ addr: null, ins: r.ins.text, text: r.text, plain: r.plain, fault: !!r.fault, manual: true });
    setExplain(log[log.length - 1]);
    render(true);
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
    if (beginner())
      return setStatus(`${timer ? 'Running…' : 'Ready.'} Now inside ${m.curFn()}(). ${m.steps} step(s) done.${timer ? '' : ' Press Step ▶ to run the highlighted line.'}`, timer ? 'warn' : '');
    setStatus(`${timer ? 'Running' : 'Ready'} · ${m.steps} step(s) · next: ${hex(m.eip)}${where ? ' <' + where + '>' : ''}`, timer ? 'warn' : '');
  }

  function setExplain(entry, quiet) {
    if (!entry) {
      els.explain.className = 'explain-now';
      els.explain.innerHTML = '<span class="muted">Press <b>Step ▶</b> to run the next instruction, or use the playground to push / pop by hand. The explanation shows up here.</span>';
      return;
    }
    els.explain.className = 'explain-now' + (entry.fault ? ' fault' : '');
    void els.explain.offsetWidth; // restart the fade-in animation
    els.explain.classList.add('fresh');
    const head = entry.ins ? `<span class="ins">${entry.addr != null ? (beginner() ? '' : hex(entry.addr) + '  ') : '(by hand)  '}${esc(entry.ins)}</span>` : '';
    const body = beginner() && entry.plain ? entry.plain : entry.text;
    els.explain.innerHTML = head + esc(body) + (quiet ? ' <span class="muted">(stepped back)</span>' : '');
  }

  function renderLog() {
    els.log.innerHTML = log.slice(-200).reverse().map(e => {
      const where = e.addr != null ? (beginner() ? '' : hex(e.addr).slice(6) + ' ') : '✎ ';
      return `<li class="${e.fault ? 'fault' : ''}"><code>${where}${esc(e.ins)}</code> ${esc(beginner() && e.plain ? e.plain : e.text)}</li>`;
    }).join('');
    els.log.start = log.length;
  }

  const REG_ORDER = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'esp', 'ebp'];
  function renderRegs(animate) {
    const cell = (r, v, changed, hint) =>
      `<div class="reg r-${r}${changed ? ' changed' : ''}" data-tip="${esc(REG_INFO[r][1])}"><div class="n"><b>${r}</b><em>${esc(hint)}</em></div><div class="v">${r === 'eip' ? hex(v) : fmt(v)}</div></div>`;
    let html = '';
    for (const r of REG_ORDER) {
      const v = m.regs[r];
      const hint = beginner() ? REG_INFO[r][0] : fmtAlt(v);
      html += cell(r, v, animate && prevRegs && prevRegs[r] !== v, hint);
    }
    const sym = m.sym(m.eip);
    const eipHint = beginner() ? `next: line in ${m.baseName(m.eip) || '?'}()` : (sym || 'next instruction');
    html += cell('eip', m.eip, animate && prevRegs && prevRegs.eip !== m.eip, eipHint);
    els.regs.innerHTML = html;
    els.flags.innerHTML = Object.entries(m.flags).map(([k, v]) => `<span class="flag${v ? ' on' : ''}" data-tip="${FLAG_TIPS[k]}">${k}=${v}</span>`).join('');
  }

  /* Stack rows + floating ESP/EBP arrows that glide between slots. */
  els.stack.innerHTML = '<div id="stackRows"></div>' +
    `<div class="ptr esp" id="ptrEsp" data-tip="${esc(REG_INFO.esp[1])}">ESP</div>` +
    `<div class="ptr ebp" id="ptrEbp" data-tip="${esc(REG_INFO.ebp[1])}">EBP</div>`;
  const stackRows = $('stackRows'), ptrEsp = $('ptrEsp'), ptrEbp = $('ptrEbp');

  function renderStack(animate) {
    const { STACK_TOP, STACK_BASE } = Emu;
    const esp = m.regs.esp, ebp = m.regs.ebp;
    const inStack = a => a >= STACK_BASE && a < STACK_TOP;
    const espSlot = (esp & ~3) >>> 0, ebpSlot = (ebp & ~3) >>> 0;
    let bottom = Math.min(inStack(esp) ? espSlot : STACK_TOP - 4, m.low) - 4 * 5;
    bottom = Math.max(bottom, STACK_BASE);
    const frameOk = inStack(ebp) && inStack(esp) && ebp >= esp;
    const prevEsp = animate && prevRegs ? prevRegs.esp : null;
    const B = beginner();
    let html = '';
    if (!inStack(esp)) html += `<div class="stack-gap">⚠ ESP = ${hex(esp)} points outside the stack</div>`;
    for (let a = STACK_TOP - 4; a >= bottom; a -= 4) {
      const tag = m.tags[a];
      const free = inStack(esp) && a < espSlot;
      const cls = ['srow'];
      if (free) cls.push('free');
      if (frameOk && a >= espSlot && a <= ebpSlot) cls.push('frame');
      if (frameOk && a === ebpSlot) cls.push('frame-top');
      if (animate && m.writes.has(a)) cls.push('changed');
      if (prevEsp !== null && esp < prevEsp && a >= espSlot && a < prevEsp) cls.push('anim-push');
      const justPopped = prevEsp !== null && esp > prevEsp && a >= prevEsp && a < espSlot;
      if (justPopped) cls.push('anim-pop');

      const v = m.read(a, 4);
      // What is this slot?
      let kind = tag ? tag.kind : null;
      if (!kind && !free) kind = frameOk && a < ebpSlot && a >= espSlot ? 'local' : 'data';
      if (free) kind = 'free';
      if (tag && tag.corrupt) cls.push('corrupt');
      if (kind) cls.push('k-' + kind);

      let note;
      const text4 = [0, 8, 16, 24].map(sh => (v >>> sh) & 0xff);
      const asText = text4.every(b => b >= 0x20 && b < 0x7f) ? ` with "${String.fromCharCode(...text4)}"` : '';
      if (tag && tag.corrupt) note = B ? `${tag.kind === 'ret' ? 'return address' : 'saved EBP'} OVERWRITTEN${asText}! (was: ${tag.plain || tag.text})` : `${tag.kind === 'ret' ? 'return address' : 'saved EBP'} OVERWRITTEN!`;
      else if (free) note = B ? (justPopped ? 'free: just popped ↑' : v ? 'free (old value left over)' : 'free') : (tag || v ? 'stale data (already popped)' : '');
      else if (tag) note = B ? tag.plain || tag.text : tag.text;
      else if (kind === 'local') note = B ? `local variable of ${m.ownerOf(a)}()` : '';
      else note = B ? `data of ${m.ownerOf(a)}()` : '';
      const tip = SLOT_TIPS[tag && tag.corrupt ? 'corrupt' : kind] || '';

      let ascii = '';
      for (let i = 0; i < 4; i++) { const b = (v >>> (8 * i)) & 0xff; ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·'; }
      let off = '';
      if (inStack(ebp)) { const d = (a - ebp) | 0; off = d === 0 ? 'ebp' : `ebp${d > 0 ? '+' : '−'}${Math.abs(d)}`; }
      else if (inStack(esp)) { const d = (a - esp) | 0; off = d === 0 ? 'esp' : `esp${d > 0 ? '+' : '−'}${Math.abs(d)}`; }
      html += `<div class="${cls.join(' ')}" data-addr="${a}"><span class="ptrs"></span><span class="addr">${hex(a)}</span><span class="off">${off}</span><span class="val" data-tip="${esc(`${hex(v)} = ${v | 0} in decimal`)}">${fmt(v)}</span><span class="ascii">${esc(ascii)}</span><span class="note"${tip ? ` data-tip="${esc(tip)}"` : ''}>${esc(note)}</span></div>`;
    }
    if (bottom > STACK_BASE) html += `<div class="stack-gap">… lower addresses (unused) down to ${hex(STACK_BASE)}</div>`;
    stackRows.innerHTML = html;

    const place = (ptr, slot, ok) => {
      const row = ok && stackRows.querySelector(`.srow[data-addr="${slot}"]`);
      if (!row) { ptr.hidden = true; return; }
      if (ptr.hidden || !animate) { ptr.classList.add('no-anim'); ptr.hidden = false; }
      ptr.style.top = row.offsetTop + (row.offsetHeight - ptr.offsetHeight) / 2 + 'px';
      void ptr.offsetWidth;
      ptr.classList.remove('no-anim');
    };
    place(ptrEsp, espSlot, inStack(esp));
    place(ptrEbp, ebpSlot, inStack(ebp));
    ptrEsp.textContent = B ? 'ESP ▸' : 'ESP';
    ptrEbp.classList.toggle('shift', !ptrEsp.hidden);

    const row = stackRows.querySelector(`.srow[data-addr="${espSlot}"]`);
    if (row) {
      const top = row.offsetTop, h = els.stack.clientHeight;
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

  function render(animate = false) {
    renderRegs(animate);
    renderStack(animate);
    renderListing();
    renderLog();
    renderStatus();
    els.btnBack.disabled = history.length === 0;
    els.btnStep.disabled = m.done;
  }

  /* ---------------------------------------------------------- settings */
  function applySettings() {
    document.body.classList.toggle('beginner', beginner());
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === settings.mode));
    document.querySelectorAll('#numSeg button').forEach(b => b.classList.toggle('on', b.dataset.num === settings.num));
    setExplain(log[log.length - 1] || null);
    render();
  }
  document.querySelectorAll('#modeSeg button').forEach(b => b.addEventListener('click', () => {
    settings.mode = b.dataset.mode; store.set('stackemu.mode', settings.mode); applySettings();
  }));
  document.querySelectorAll('#numSeg button').forEach(b => b.addEventListener('click', () => {
    settings.num = b.dataset.num; store.set('stackemu.num', settings.num); applySettings();
  }));

  els.intro.hidden = store.get('stackemu.introClosed') === '1';
  $('introClose').addEventListener('click', () => { els.intro.hidden = true; store.set('stackemu.introClosed', '1'); });
  $('introBtn').addEventListener('click', () => { els.intro.hidden = false; store.set('stackemu.introClosed', '0'); els.intro.scrollIntoView({ behavior: 'smooth' }); });

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
    store.set('stackemu.example', els.example.value);
    store.set('stackemu.code', '');   // only code the user typed is remembered
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
  // Restore code the user typed; otherwise load the current version of the last example.
  const savedEx = store.get('stackemu.example');
  // Older versions saved every example they loaded; drop that once so updated examples show up.
  const savedCode = savedEx === null ? '' : store.get('stackemu.code');
  els.example.value = savedEx !== null && EXAMPLES[savedEx] ? savedEx : '1';
  els.editor.value = savedCode || EXAMPLES[els.example.value].code;
  renderGutter();
  assembleAndLoad();
  applySettings();
})();
