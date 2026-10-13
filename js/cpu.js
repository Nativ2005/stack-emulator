'use strict';
/*
 * x86 (32-bit, Intel syntax) mini assembler + CPU focused on the stack.
 * Only the stack segment is real memory; everything else faults.
 */
const Emu = (() => {
  const REG32 = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'];
  const REG8 = {
    al: ['eax', 0], bl: ['ebx', 0], cl: ['ecx', 0], dl: ['edx', 0],
    ah: ['eax', 8], bh: ['ebx', 8], ch: ['ecx', 8], dh: ['edx', 8],
  };
  const CODE_BASE = 0x08049000;
  const STACK_TOP = 0xC0000000;          // first address *above* the stack
  const STACK_SIZE = 0x400;              // 1 KiB of stack
  const STACK_BASE = STACK_TOP - STACK_SIZE;
  const EXIT_ADDR = 0xF7C21519;          // fake "__libc_start_main+..." return address

  const JCC = {
    je: 'e', jz: 'e', jne: 'ne', jnz: 'ne',
    jl: 'l', jnge: 'l', jge: 'ge', jnl: 'ge', jle: 'le', jng: 'le', jg: 'g', jnle: 'g',
    jb: 'b', jc: 'b', jnae: 'b', jae: 'ae', jnb: 'ae', jnc: 'ae',
    jbe: 'be', jna: 'be', ja: 'a', jnbe: 'a', js: 's', jns: 'ns',
  };
  const ARITY = {
    push: [1, 1], pop: [1, 1], mov: [2, 2], lea: [2, 2], xchg: [2, 2],
    add: [2, 2], sub: [2, 2], and: [2, 2], or: [2, 2], xor: [2, 2], cmp: [2, 2], test: [2, 2],
    imul: [2, 3], inc: [1, 1], dec: [1, 1], neg: [1, 1], not: [1, 1],
    shl: [2, 2], sal: [2, 2], shr: [2, 2], sar: [2, 2],
    call: [1, 1], jmp: [1, 1], ret: [0, 1], leave: [0, 0], nop: [0, 0], hlt: [0, 0],
  };
  const IGNORED_DIRECTIVES = /^(section|segment|global|extern|bits|default|align)\b|^\.(text|data|bss|globl|global|intel_syntax|section|type|size)\b/i;

  const hex = (v, w = 8) => '0x' + (v >>> 0).toString(16).padStart(w, '0');
  const fits8 = v => (v | 0) >= -128 && (v | 0) <= 127;
  const norm = (v, size) => (size === 1 ? v & 0xff : v >>> 0);
  const signed = (v, size) => (size === 1 ? ((v & 0xff) << 24) >> 24 : v | 0);

  class AsmError extends Error { constructor(msg, line) { super(msg); this.line = line; } }
  class Fault extends Error {}

  /* ------------------------------------------------------------ parsing */

  function stripComment(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === ';' || c === '#') return s.slice(0, i);
    }
    return s;
  }

  function splitArgs(s) {
    const out = [];
    let depth = 0, q = null, cur = '';
    for (const c of s) {
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; cur += c; continue; }
      if (c === '[') depth++;
      if (c === ']') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function parseImm(s) {
    s = s.trim();
    let m;
    if ((m = s.match(/^(['"])(.)\1$/))) return m[2].charCodeAt(0);
    let neg = false;
    if (s.startsWith('-')) { neg = true; s = s.slice(1).trim(); }
    else if (s.startsWith('+')) s = s.slice(1).trim();
    let v = null;
    if (/^0x[0-9a-f]+$/i.test(s)) v = parseInt(s.slice(2), 16);
    else if (/^[0-9][0-9a-f]*h$/i.test(s)) v = parseInt(s.slice(0, -1), 16);
    else if (/^0b[01]+$/i.test(s)) v = parseInt(s.slice(2), 2);
    else if (/^\d+$/.test(s)) v = parseInt(s, 10);
    if (v === null || v > 0xFFFFFFFF) return null;
    return (neg ? -v : v) >>> 0;
  }

  function parseAddr(inner) {
    const m = { base: null, index: null, scale: 1, disp: 0 };
    const expr = inner.replace(/\s+/g, '').toLowerCase();
    if (!expr) throw new Error('empty memory operand []');
    const terms = expr.match(/[+-]?[^+-]+/g);
    if (!terms || terms.join('') !== expr) throw new Error(`bad memory operand [${inner}]`);
    for (let t of terms) {
      let sign = 1;
      if (t[0] === '-') { sign = -1; t = t.slice(1); } else if (t[0] === '+') t = t.slice(1);
      let sm;
      if (REG32.includes(t)) {
        if (sign < 0) throw new Error(`can't subtract a register in [${inner}]`);
        if (!m.base) m.base = t;
        else if (!m.index) m.index = t;
        else throw new Error(`too many registers in [${inner}]`);
        continue;
      }
      if ((sm = t.match(/^([a-z]{3})\*([1248])$/)) || (sm = t.match(/^([1248])\*([a-z]{3})$/))) {
        const reg = REG32.includes(sm[1]) ? sm[1] : sm[2];
        const scale = Number(REG32.includes(sm[1]) ? sm[2] : sm[1]);
        if (!REG32.includes(reg) || sign < 0 || m.index) throw new Error(`bad index in [${inner}]`);
        m.index = reg; m.scale = scale;
        continue;
      }
      const v = parseImm(t);
      if (v === null) throw new Error(`bad address term "${t}" in [${inner}]`);
      m.disp = (m.disp + sign * (v | 0)) | 0;
    }
    return m;
  }

  function parseOperand(raw) {
    let s = raw.trim();
    let size = null, m;
    if ((m = s.match(/^(byte|word|dword)(\s+ptr)?\s*(\[.*\])$/i))) {
      if (m[1].toLowerCase() === 'word') throw new Error('16-bit (word) operands are not supported');
      size = m[1].toLowerCase() === 'byte' ? 1 : 4;
      s = m[3];
    }
    const low = s.toLowerCase();
    if (REG32.includes(low)) return { t: 'reg', reg: low, text: low };
    if (low in REG8) return { t: 'reg8', reg: REG8[low][0], shift: REG8[low][1], text: low };
    if (/^(ax|bx|cx|dx|si|di|bp|sp)$/.test(low)) throw new Error('16-bit registers are not supported, use the 32-bit ones (eax, ebp, ...)');
    if (s.startsWith('[') && s.endsWith(']')) return { t: 'mem', size, ...parseAddr(s.slice(1, -1)), text: raw.trim() };
    const v = parseImm(s);
    if (v !== null) return { t: 'imm', value: v, text: s };
    if (/^[A-Za-z_.$][\w.$]*$/.test(s)) return { t: 'label', name: s, text: s };
    throw new Error(`can't understand operand "${raw.trim()}"`);
  }

  const isRM = o => o.t === 'reg' || o.t === 'reg8' || o.t === 'mem';
  const isImm = o => o.t === 'imm' || o.t === 'label';

  function opSize(args) {
    if (args.some(a => a.t === 'reg8')) return 1;
    if (args.some(a => a.t === 'reg')) return 4;
    const m = args.find(a => a.t === 'mem');
    return (m && m.size) || 4;
  }

  function validate(op, a) {
    const [lo, hi] = JCC[op] ? [1, 1] : ARITY[op];
    if (a.length < lo || a.length > hi)
      throw new Error(`"${op}" takes ${lo === hi ? lo : lo + '-' + hi} operand(s), got ${a.length}`);
    if (a.filter(x => x.t === 'mem').length > 1) throw new Error('x86 does not allow two memory operands');
    if (a.some(x => x.t === 'reg') && a.some(x => x.t === 'reg8') && op !== 'shl' && op !== 'shr' && op !== 'sar' && op !== 'sal')
      throw new Error('operand size mismatch (mixing 32-bit and 8-bit registers)');
    const regs32 = x => x.t === 'reg';
    switch (op) {
      case 'push':
        if (a[0].t === 'reg8') throw new Error('push needs a 32-bit operand');
        if (a[0].t === 'mem' && a[0].size === 1) throw new Error('push needs a 32-bit operand');
        break;
      case 'pop':
        if (!(a[0].t === 'reg' || (a[0].t === 'mem' && a[0].size !== 1))) throw new Error('pop needs a 32-bit register or memory operand');
        break;
      case 'lea':
        if (!regs32(a[0]) || a[1].t !== 'mem') throw new Error('usage: lea reg32, [address]');
        break;
      case 'call': case 'jmp':
        if (a[0].t === 'reg8' || (a[0].t === 'mem' && a[0].size === 1)) throw new Error(`${op} target must be 32-bit`);
        break;
      case 'ret':
        if (a.length && a[0].t !== 'imm') throw new Error('usage: ret  or  ret <imm>');
        break;
      case 'inc': case 'dec': case 'neg': case 'not':
        if (!isRM(a[0])) throw new Error(`${op} needs a register or memory operand`);
        break;
      case 'shl': case 'sal': case 'shr': case 'sar':
        if (!isRM(a[0])) throw new Error(`${op} needs a register or memory destination`);
        if (!(a[1].t === 'imm' || (a[1].t === 'reg8' && a[1].text === 'cl'))) throw new Error(`${op} count must be an immediate or cl`);
        break;
      case 'imul':
        if (!regs32(a[0])) throw new Error('imul destination must be a 32-bit register');
        if (a.length === 2 && !(isRM(a[1]) || isImm(a[1]))) throw new Error('bad imul source');
        if (a.length === 3 && !(isRM(a[1]) && isImm(a[2]))) throw new Error('usage: imul reg, r/m, imm');
        break;
      case 'xchg':
        if (!isRM(a[0]) || !isRM(a[1])) throw new Error('xchg needs register/memory operands');
        break;
      default:
        if (JCC[op]) { if (a[0].t !== 'label' && a[0].t !== 'imm') throw new Error(`${op} needs a label`); break; }
        if (a.length === 2 && !isRM(a[0])) throw new Error(`destination of ${op} must be a register or memory`);
    }
  }

  function memLen(m) {
    let n = 1;
    if (m.index || m.base === 'esp') n++;
    if (!m.base && !m.index) return n + 4;
    if (m.disp === 0 && m.base !== 'ebp') return n;
    return n + (fits8(m.disp) ? 1 : 4);
  }

  /* Approximate real encoding lengths so addresses look like a real disassembly. */
  function instrSize(op, a) {
    const mem = a.find(x => x.t === 'mem');
    switch (op) {
      case 'push': return a[0].t === 'reg' ? 1 : a[0].t === 'imm' ? (fits8(a[0].value) ? 2 : 5) : a[0].t === 'label' ? 5 : 1 + memLen(a[0]);
      case 'pop': return a[0].t === 'reg' ? 1 : 1 + memLen(a[0]);
      case 'ret': return a.length ? 3 : 1;
      case 'leave': case 'nop': case 'hlt': return 1;
      case 'call': case 'jmp': return a[0].t === 'reg' ? 2 : a[0].t === 'mem' ? 1 + memLen(a[0]) : 5;
      case 'inc': case 'dec': return a[0].t === 'reg' ? 1 : a[0].t === 'reg8' ? 2 : 1 + memLen(a[0]);
    }
    if (JCC[op]) return 6;
    let n = 1 + (mem ? memLen(mem) : 1);
    const imm = a.find(isImm);
    if (imm) {
      if (op === 'mov' && a[0].t === 'reg') return 5;
      if (op === 'mov' && a[0].t === 'reg8') return 2;
      if (opSize(a) === 1 || ['shl', 'sal', 'shr', 'sar'].includes(op)) n += 1;
      else if (op !== 'mov' && op !== 'test' && imm.t === 'imm' && fits8(imm.value)) n += 1;
      else n += 4;
    }
    return n;
  }

  function parseLine(text, lineNo) {
    const m = text.match(/^(\S+)\s*(.*)$/);
    const op = m[1].toLowerCase();
    if (!ARITY[op] && !JCC[op]) throw new AsmError(`unknown instruction "${m[1]}"`, lineNo);
    let args;
    try {
      args = splitArgs(m[2]).map(parseOperand);
      validate(op, args);
    } catch (e) { throw new AsmError(e.message, lineNo); }
    return { op, args, text: `${op}${args.length ? ' ' + args.map(x => x.text).join(', ') : ''}`, line: lineNo };
  }

  function assemble(src) {
    const instrs = [], labels = {}, errors = [];
    let pending = [];
    src.split(/\r?\n/).forEach((raw, i) => {
      let line = stripComment(raw).trim();
      let m;
      while ((m = line.match(/^([A-Za-z_.$][\w.$]*)\s*:(.*)$/))) {
        if (m[1] in labels || pending.includes(m[1])) errors.push(new AsmError(`label "${m[1]}" defined twice`, i));
        pending.push(m[1]);
        line = m[2].trim();
      }
      if (!line || IGNORED_DIRECTIVES.test(line)) return;
      try {
        const ins = parseLine(line, i);
        ins.labels = pending;
        pending.forEach(l => { labels[l] = instrs.length; });
        pending = [];
        instrs.push(ins);
      } catch (e) { errors.push(e instanceof AsmError ? e : new AsmError(e.message, i)); }
    });
    let addr = CODE_BASE;
    for (const ins of instrs) {
      ins.addr = addr;
      ins.size = instrSize(ins.op, ins.args);
      addr += ins.size;
      ins.next = addr;
    }
    const end = addr;
    for (const l of Object.keys(labels)) labels[l] = labels[l] < instrs.length ? instrs[labels[l]].addr : end;
    pending.forEach(l => { labels[l] = end; });
    for (const ins of instrs)
      for (const a of ins.args)
        if (a.t === 'label' && !(a.name in labels)) errors.push(new AsmError(`unknown label "${a.name}"`, ins.line));
    errors.sort((x, y) => x.line - y.line);
    const byAddr = new Map(instrs.map(x => [x.addr, x]));
    const entry = labels.main ?? labels._start ?? CODE_BASE;
    return { instrs, labels, byAddr, entry, end, errors };
  }

  /* ------------------------------------------------------------ machine */

  class Machine {
    constructor(prog) { this.prog = prog; this.reset(); }

    reset() {
      this.regs = { eax: 0, ebx: 0, ecx: 0, edx: 0, esi: 0, edi: 0, ebp: 0, esp: STACK_TOP - 4 };
      this.eip = this.prog.entry;
      this.flags = { ZF: 0, SF: 0, CF: 0, OF: 0 };
      this.mem = new Uint8Array(STACK_SIZE);
      this.tags = {};
      this.low = STACK_TOP - 4;
      this.status = 'ready';
      this.message = '';
      this.steps = 0;
      this.writes = new Set();
      this.writeRaw(STACK_TOP - 4, 4, EXIT_ADDR);
      this.calls = [];   // active function calls: { fn, retSlot }
      this.entryName = this.sym(this.prog.entry) || 'main';
      this.tags[STACK_TOP - 4] = {
        kind: 'ret', fn: this.entryName,
        text: 'return address → __libc_start_main (whoever called main)',
        plain: `return address: when ${this.entryName}() finishes, the program ends`,
      };
    }

    snapshot() {
      return {
        regs: { ...this.regs }, eip: this.eip, flags: { ...this.flags }, mem: this.mem.slice(),
        tags: JSON.parse(JSON.stringify(this.tags)), low: this.low, status: this.status,
        message: this.message, steps: this.steps, calls: this.calls.map(c => ({ ...c })),
      };
    }
    restore(s) {
      Object.assign(this, {
        regs: { ...s.regs }, eip: s.eip, flags: { ...s.flags }, mem: s.mem.slice(),
        tags: JSON.parse(JSON.stringify(s.tags)), low: s.low, status: s.status, message: s.message, steps: s.steps,
        calls: s.calls.map(c => ({ ...c })),
      });
      this.writes = new Set();
    }

    get done() { return this.status === 'exited' || this.status === 'halted' || this.status === 'fault'; }

    /* memory */
    off(a, size) {
      a >>>= 0;
      if (a < STACK_BASE || a + size > STACK_TOP)
        throw new Fault(`Segmentation fault: memory access at ${hex(a)} is outside the stack (${hex(STACK_BASE)}–${hex(STACK_TOP - 1)})`);
      return a - STACK_BASE;
    }
    read(a, size) {
      const o = this.off(a, size);
      let v = 0;
      for (let i = size - 1; i >= 0; i--) v = v * 256 + this.mem[o + i];
      return v >>> 0;
    }
    writeRaw(a, size, v) {
      const o = this.off(a, size);
      for (let i = 0; i < size; i++) this.mem[o + i] = (v >>> (8 * i)) & 0xff;
    }
    write(a, size, v, tag) {
      a >>>= 0;
      const first = (a & ~3) >>> 0, last = ((a + size - 1) & ~3) >>> 0;
      const old = {};
      for (let s = first; s <= last; s += 4) old[s] = this.inRange(s) ? this.read(s, 4) : null;
      this.writeRaw(a, size, v);
      for (let s = first; s <= last; s += 4) {
        this.writes.add(s);
        this.low = Math.min(this.low, s);
        const t = this.tags[s];
        if (tag) this.tags[s] = tag;
        else if (t && (t.kind === 'ret' || t.kind === 'ebp')) { if (old[s] !== this.read(s, 4)) t.corrupt = true; }
        else delete this.tags[s];
      }
    }
    inRange(a) { return a >= STACK_BASE && a + 4 <= STACK_TOP; }

    push(v, tag) {
      this.regs.esp = (this.regs.esp - 4) >>> 0;
      this.write(this.regs.esp, 4, v, tag);
    }
    pop() {
      const v = this.read(this.regs.esp, 4);
      this.regs.esp = (this.regs.esp + 4) >>> 0;
      return v;
    }

    /* operands */
    ea(o) {
      return ((o.base ? this.regs[o.base] : 0) + (o.index ? this.regs[o.index] * o.scale : 0) + o.disp) >>> 0;
    }
    val(o, size) {
      switch (o.t) {
        case 'reg': return this.regs[o.reg];
        case 'reg8': return (this.regs[o.reg] >>> o.shift) & 0xff;
        case 'imm': return norm(o.value, size);
        case 'label': return this.prog.labels[o.name];
        case 'mem': return this.read(this.ea(o), size);
      }
    }
    set(o, size, v) {
      switch (o.t) {
        case 'reg': this.regs[o.reg] = v >>> 0; break;
        case 'reg8': this.regs[o.reg] = ((this.regs[o.reg] & ~(0xff << o.shift)) | ((v & 0xff) << o.shift)) >>> 0; break;
        case 'mem': this.write(this.ea(o), size, v); break;
      }
    }
    where(o) { return o.t === 'mem' ? `${o.text} (address ${hex(this.ea(o))})` : o.text.toUpperCase(); }

    sym(addr) {
      addr >>>= 0;
      if (addr === EXIT_ADDR) return '__libc_start_main+0x89';
      if (addr < CODE_BASE || addr >= this.prog.end) return null;
      let best = null;
      for (const [name, a] of Object.entries(this.prog.labels))
        if (a <= addr && !name.startsWith('.') && (!best || a > best[1])) best = [name, a];
      if (!best) return hex(addr);
      return addr === best[1] ? best[0] : `${best[0]}+${(addr - best[1]).toString(16).replace(/^/, '0x')}`;
    }

    setZS(r, size) {
      this.flags.ZF = norm(r, size) === 0 ? 1 : 0;
      this.flags.SF = (norm(r, size) >>> (size * 8 - 1)) & 1;
    }
    alu(op, a, b, size) {
      const sb = size === 1 ? 0x80 : 0x80000000, F = this.flags;
      let r;
      switch (op) {
        case 'add':
          r = norm(a + b, size);
          F.CF = a + b > (size === 1 ? 0xff : 0xffffffff) ? 1 : 0;
          F.OF = !((a ^ b) & sb) && ((a ^ r) & sb) ? 1 : 0;
          break;
        case 'sub': case 'cmp':
          r = norm(a - b, size);
          F.CF = a < b ? 1 : 0;
          F.OF = ((a ^ b) & sb) && ((a ^ r) & sb) ? 1 : 0;
          break;
        case 'and': case 'test': r = norm(a & b, size); F.CF = F.OF = 0; break;
        case 'or': r = norm(a | b, size); F.CF = F.OF = 0; break;
        case 'xor': r = norm(a ^ b, size); F.CF = F.OF = 0; break;
      }
      this.setZS(r, size);
      return r;
    }
    cond(c) {
      const { ZF, SF, CF, OF } = this.flags;
      return {
        e: ZF, ne: !ZF, l: SF !== OF, ge: SF === OF, le: ZF || SF !== OF, g: !ZF && SF === OF,
        b: CF, ae: !CF, be: CF || ZF, a: !CF && !ZF, s: SF, ns: !SF,
      }[c] ? true : false;
    }
    flagStr() { return Object.entries(this.flags).map(([k, v]) => `${k}=${v}`).join(' '); }

    /* execution */
    step() {
      if (this.done) return null;
      if (!this.prog.instrs.length) return { text: 'No program loaded. Write some code and press "Assemble & Load".', fault: true };
      const ins = this.prog.byAddr.get(this.eip);
      if (!ins) { this.status = 'fault'; this.message = `Segmentation fault: EIP ${hex(this.eip)} is not a valid instruction`; return { text: this.message, fault: true }; }
      return this.run(ins, ins.next, false);
    }
    /* Execute an instruction typed by hand without advancing EIP (immediate mode). */
    immediate(text) {
      const line = stripComment(text).trim();
      if (!line) return null;
      const ins = parseLine(line, 0);
      for (const a of ins.args)
        if (a.t === 'label' && !(a.name in this.prog.labels)) throw new AsmError(`unknown label "${a.name}"`, 0);
      const before = { status: this.status, message: this.message, eip: this.eip };
      if (this.status === 'fault' || this.status === 'halted') this.status = 'ready';
      const r = this.run(ins, this.eip, true);
      // A manual op that doesn't touch EIP can't fix a crash caused by a bad EIP.
      if (this.status === 'ready' && before.status === 'fault' && this.eip === before.eip && !this.prog.byAddr.has(this.eip)) {
        this.status = before.status;
        this.message = before.message;
      }
      return r;
    }
    /* ---- function / frame bookkeeping (used for plain-English labels) */
    curFn() { return this.calls.length ? this.calls[this.calls.length - 1].fn : this.entryName; }
    callerFn() {
      const n = this.calls.length;
      return n >= 2 ? this.calls[n - 2].fn : n === 1 ? this.entryName : null;
    }
    /* Which function's frame a stack slot belongs to. */
    ownerOf(a) {
      for (let i = this.calls.length - 1; i >= 0; i--) if (a < this.calls[i].retSlot) return this.calls[i].fn;
      return this.entryName;
    }
    baseName(addr) { const s = this.sym(addr); return s ? s.replace(/\+.*$/, '') : null; }

    run(ins, next, manual) {
      this.writes = new Set();
      const start = this.eip;
      const pre = { regs: { ...this.regs }, eip: start, next, fn: this.curFn() };
      this.eip = next;
      let text, plain;
      try {
        text = this.exec(ins);
        this.steps++;
        this.calls = this.calls.filter(c => c.retSlot >= this.regs.esp);
        plain = this.plain(ins, pre) || text;
      } catch (e) {
        if (!(e instanceof Fault)) throw e;
        this.eip = start;
        this.status = 'fault';
        this.message = e.message;
        return { ins, text: e.message, plain: '💥 Crash! ' + e.message.replace(/^Segmentation fault: /, 'The program tried a ') + '. Only the stack is real memory in this emulator.', fault: true };
      }
      if (this.status === 'halted') return { ins, text, plain };
      if (this.eip === EXIT_ADDR) {
        this.status = 'exited';
        this.message = `Program returned from main → exited with EAX = ${this.regs.eax} (${hex(this.regs.eax)})`;
      } else if (!this.prog.byAddr.has(this.eip) && !(manual && this.eip === start)) {
        this.status = 'fault';
        const bytes = [0, 8, 16, 24].map(s => (this.eip >>> s) & 0xff);
        const ascii = bytes.every(b => b >= 0x20 && b < 0x7f) ? ` — those bytes are the text "${String.fromCharCode(...bytes)}"! The return address was overwritten.` : '';
        this.message = this.eip === this.prog.end
          ? 'Execution ran past the last instruction (forgot a "ret" or "hlt"?)'
          : `Segmentation fault: EIP = ${hex(this.eip)} is not a valid instruction address${ascii}`;
      } else if (this.status !== 'exited') this.status = 'ready';
      return { ins, text, plain };
    }

    /* ---- friendly, jargon-light explanation of what an instruction did */
    fv(v) {
      const s = v | 0;
      return Math.abs(s) < 1e6 ? String(s) : hex(v);
    }
    describe(o) {
      if (o.t === 'reg') return o.reg.toUpperCase();
      if (o.t === 'reg8') return `${o.text.toUpperCase()} (one byte of ${o.reg.toUpperCase()})`;
      if (o.t === 'imm') return this.fv(o.value);
      if (o.t === 'label') return `the address of ${o.name}`;
      if (o.base === 'ebp' && !o.index) {
        const d = o.disp;
        if (d >= 8 && d % 4 === 0) return `argument #${(d - 8) / 4 + 1} [ebp+${d}]`;
        if (d === 4) return 'the return-address slot [ebp+4]';
        if (d === 0) return 'the saved-EBP slot [ebp]';
        if (d < 0) return `the local variable at [ebp${d}]`;
      }
      if (o.base === 'esp' && !o.index && o.disp === 0) return 'the top of the stack [esp]';
      return `memory ${o.text}`;
    }
    plain(ins, pre) {
      const a = ins.args, R = this.regs, op = ins.op, fn = pre.fn;
      if (JCC[op]) {
        const names = {
          e: 'equal', ne: 'not equal', l: 'less than', ge: 'greater than or equal', le: 'less than or equal',
          g: 'greater than', b: 'below (unsigned)', ae: 'above or equal (unsigned)', be: 'below or equal (unsigned)',
          a: 'above (unsigned)', s: 'negative', ns: 'not negative',
        };
        const jumped = this.eip !== pre.next;
        return `Checks the result of the last comparison: was it "${names[JCC[op]]}"? ` +
          (jumped ? `Yes → jump to ${a[0].text}.` : 'No → just continue with the next line.');
      }
      switch (op) {
        case 'push': {
          const v = this.read(R.esp, 4);
          if (a[0].t === 'reg' && a[0].reg === 'ebp')
            return `Start of ${fn}() (the "prologue"): saves the caller's EBP on the stack so it can be restored when ${fn}() finishes. ESP moved down 4 bytes to the new top.`;
          const what = a[0].t === 'imm' ? `the number ${this.fv(v)}` : `${this.describe(a[0])} (${this.fv(v)})`;
          return `Put ${what} on top of the stack. The stack grows DOWN, so ESP moved down by 4 bytes (one slot) and now points at the new top.`;
        }
        case 'pop': {
          const v = this.read(pre.regs.esp, 4);
          if (a[0].t === 'reg' && a[0].reg === 'ebp')
            return `End of ${fn}(): takes the saved EBP (${this.fv(v)}) off the stack, so EBP points at the caller's frame again. ESP moved up 4 bytes.`;
          return `Took the top value (${this.fv(v)}) off the stack and put it into ${this.describe(a[0])}. ESP moved UP by 4 bytes; the old slot is now free space.`;
        }
        case 'mov': {
          if (a[0].t === 'reg' && a[1].t === 'reg' && a[0].reg === 'ebp' && a[1].reg === 'esp')
            return `EBP = ESP. EBP now marks the base of ${fn}()'s frame: its arguments are above it ([ebp+8], [ebp+12], …) and its local variables go below it ([ebp-4], …).`;
          if (a[0].t === 'reg' && a[1].t === 'reg' && a[0].reg === 'esp' && a[1].reg === 'ebp')
            return `ESP = EBP: throws away ${fn}()'s local variables in one go. ESP is back at the saved EBP.`;
          const size = opSize(a);
          const v = a[0].t === 'mem' ? this.read(this.ea(a[0]), size) : this.val(a[0], size);
          if (a[1].t === 'mem') return `Read ${this.describe(a[1])}, which holds ${this.fv(v)}, and copied it into ${this.describe(a[0])}.`;
          if (a[0].t === 'mem') return `Stored ${a[1].t === 'imm' ? this.fv(v) : `${this.describe(a[1])} (${this.fv(v)})`} into ${this.describe(a[0])}.`;
          return `${this.describe(a[0])} = ${a[1].t === 'imm' ? this.fv(v) : `${this.describe(a[1])} = ${this.fv(v)}`}.`;
        }
        case 'lea':
          return `${a[0].reg.toUpperCase()} = the ADDRESS of ${this.describe(a[1])} (${hex(R[a[0].reg])}). It now points to that slot; nothing was read from memory.`;
        case 'add': case 'sub': case 'and': case 'or': case 'xor': {
          if (a[0].t === 'reg' && a[0].reg === 'esp' && a[1].t === 'imm') {
            const n = a[1].value | 0, s = n === 4 ? '' : 's';
            if (op === 'sub') return `Made room for local variables: ESP moved down ${n} bytes (${n / 4} slot${s}). That space now belongs to ${fn}().`;
            if (op === 'add') return `Removed ${n / 4} slot${s} from the top of the stack (ESP moved up ${n} bytes), e.g. arguments that are not needed anymore after a call.`;
          }
          if (op === 'xor' && a[0].t === 'reg' && a[1].t === 'reg' && a[0].reg === a[1].reg)
            return `${a[0].reg.toUpperCase()} = 0 (XOR-ing a register with itself is a quick way to set it to zero).`;
          const size = opSize(a), sym = { add: '+', sub: '−', and: 'AND', or: 'OR', xor: 'XOR' }[op];
          const now = a[0].t === 'mem' ? this.read(this.ea(a[0]), size) : this.val(a[0], size);
          const old = a[0].t === 'reg' ? pre.regs[a[0].reg] : null;
          const rhs = a[1].t === 'imm' ? this.fv(a[1].value) : this.describe(a[1]);
          return old !== null
            ? `${this.describe(a[0])} = ${this.fv(old)} ${sym} ${rhs} = ${this.fv(now)}.`
            : `${this.describe(a[0])} ${sym}= ${rhs} → now ${this.fv(now)}.`;
        }
        case 'cmp': case 'test': {
          const size = opSize(a);
          const rhs = a[1].t === 'imm' ? this.fv(a[1].value) : `${this.describe(a[1])} (${this.fv(this.val(a[1], size))})`;
          return `Compared ${this.describe(a[0])} (${this.fv(this.val(a[0], size))}) with ${rhs}. Nothing is stored; the answer is kept in the flags for the next conditional jump.`;
        }
        case 'inc': case 'dec': case 'neg': case 'not': case 'imul': case 'shl': case 'sal': case 'shr': case 'sar': {
          const size = a[0].t === 'reg8' || (a[0].t === 'mem' && a[0].size === 1) ? 1 : 4;
          const now = a[0].t === 'mem' ? this.read(this.ea(a[0]), size) : this.val(a[0], size);
          const what = { inc: 'Added 1', dec: 'Subtracted 1', neg: 'Flipped the sign', not: 'Flipped all bits', imul: 'Multiplied', shl: 'Shifted left', sal: 'Shifted left', shr: 'Shifted right', sar: 'Shifted right' }[op];
          return `${what}: ${this.describe(a[0])} is now ${this.fv(now)}.`;
        }
        case 'call': {
          const name = this.baseName(this.eip) || hex(this.eip), n = this.lastArgCount;
          const args = n ? ` The ${n} value${n > 1 ? 's' : ''} pushed just before ${n > 1 ? 'are its arguments' : 'is its argument'}.` : '';
          return `Calling ${name}(). First the CPU pushes the RETURN ADDRESS (where ${fn}() should continue afterwards), then it jumps to ${name}.${args}`;
        }
        case 'ret': {
          const tag = this.tags[pre.regs.esp];
          if (this.eip === EXIT_ADDR) return `${fn}() is finished. It returns to the code that started the program, so the program ends. Its return value (EAX) is ${this.fv(R.eax)}.`;
          if ((tag && tag.corrupt) || !this.prog.byAddr.has(this.eip))
            return `${fn}() tries to return, but the return address on the stack was OVERWRITTEN with ${hex(this.eip)}. The CPU blindly jumps there!`;
          return `${fn}() is finished: the CPU takes the return address off the stack and jumps back into ${this.baseName(this.eip)}(). ESP moved up 4 bytes. Return value (EAX) = ${this.fv(R.eax)}.`;
        }
        case 'leave':
          return `Cleanup at the end of ${fn}(): throws away its local variables (ESP = EBP) and restores the caller's EBP (pop ebp). ESP now points at the return address, ready for "ret".`;
        case 'jmp': return `Jump to ${a[0].text}. (A plain jump does not touch the stack, unlike call.)`;
        case 'nop': return 'Does nothing.';
        case 'hlt': return `The CPU stopped (hlt). EAX = ${this.fv(R.eax)}.`;
      }
      return null;
    }

    exec(ins) {
      const a = ins.args, R = this.regs, F = this.flags, op = ins.op;
      if (JCC[op]) {
        const target = this.val(a[0], 4);
        if (this.cond(JCC[op])) { this.eip = target; return `Condition true (${this.flagStr()}) → jumped to ${a[0].text} (${hex(target)}).`; }
        return `Condition false (${this.flagStr()}) → no jump, continue with the next instruction.`;
      }
      switch (op) {
        case 'push': {
          const v = this.val(a[0], 4), old = R.esp;
          const tag = a[0].t === 'reg' && a[0].reg === 'ebp'
            ? {
              kind: 'ebp', fn: this.curFn(), text: "saved EBP (caller's frame base)",
              plain: this.callerFn()
                ? `saved EBP: remembers where ${this.callerFn()}()'s frame starts`
                : `saved EBP of the code that started ${this.curFn()}()`,
            }
            : { kind: 'push', fn: this.curFn(), text: `pushed ${a[0].text}`, plain: `value pushed by ${this.curFn()}()` };
          this.push(v, tag);
          return `ESP ${hex(old)} → ${hex(R.esp)} (ESP − 4), then wrote ${hex(v)} to [ESP]. The stack grows toward LOWER addresses.`;
        }
        case 'pop': {
          const addr = R.esp, v = this.pop();
          this.set(a[0], 4, v);
          const extra = a[0].t === 'reg' && a[0].reg === 'ebp' ? " EBP is restored to the caller's frame." : '';
          return `Read ${hex(v)} from [ESP] (${hex(addr)}) into ${this.where(a[0])}, then ESP += 4 → ${hex(R.esp)}.${extra} The value still sits in memory, but it is below ESP now, so it counts as free space.`;
        }
        case 'mov': {
          const size = opSize(a), v = this.val(a[1], size);
          const where = this.where(a[0]);
          this.set(a[0], size, v);
          return `${where} = ${hex(v, size * 2)}${a[1].t === 'mem' ? ` (read from ${this.where(a[1])})` : ''}.`;
        }
        case 'lea': {
          const v = this.ea(a[1]);
          R[a[0].reg] = v;
          return `${a[0].text.toUpperCase()} = address of ${a[1].text} = ${hex(v)}. LEA only computes the address, it does not read memory.`;
        }
        case 'xchg': {
          const size = opSize(a), x = this.val(a[0], size), y = this.val(a[1], size);
          this.set(a[0], size, y); this.set(a[1], size, x);
          return `Swapped ${a[0].text} and ${a[1].text}.`;
        }
        case 'add': case 'sub': case 'and': case 'or': case 'xor': case 'cmp': case 'test': {
          const size = opSize(a), x = this.val(a[0], size), y = this.val(a[1], size);
          const where = this.where(a[0]);
          const r = this.alu(op, x, y, size);
          if (op === 'cmp' || op === 'test')
            return `Compared ${hex(x, size * 2)} with ${hex(y, size * 2)} (${op === 'cmp' ? 'subtraction' : 'AND'} without storing). Flags: ${this.flagStr()}.`;
          this.set(a[0], size, r);
          let note = '';
          if (a[0].t === 'reg' && a[0].reg === 'esp' && a[1].t === 'imm')
            note = op === 'sub' ? ` Moved ESP down by ${y} bytes = reserved space for local variables.` : op === 'add' ? ` Moved ESP up by ${y} bytes = discarded ${y / 4} stack slot(s) (e.g. the arguments after a call).` : '';
          return `${where} = ${hex(x, size * 2)} ${{ add: '+', sub: '−', and: '&', or: '|', xor: '^' }[op]} ${hex(y, size * 2)} = ${hex(r, size * 2)}. Flags: ${this.flagStr()}.${note}`;
        }
        case 'inc': case 'dec': {
          const size = opSize(a), x = this.val(a[0], size), cf = F.CF;
          const r = this.alu(op === 'inc' ? 'add' : 'sub', x, 1, size);
          F.CF = cf;
          this.set(a[0], size, r);
          return `${this.where(a[0])} = ${hex(r, size * 2)}. Flags: ${this.flagStr()}.`;
        }
        case 'neg': {
          const size = opSize(a), x = this.val(a[0], size);
          const r = this.alu('sub', 0, x, size);
          F.CF = x !== 0 ? 1 : 0;
          this.set(a[0], size, r);
          return `${this.where(a[0])} = −${hex(x, size * 2)} = ${hex(r, size * 2)}.`;
        }
        case 'not': {
          const size = opSize(a), r = norm(~this.val(a[0], size), size);
          this.set(a[0], size, r);
          return `${this.where(a[0])} = ${hex(r, size * 2)} (all bits flipped).`;
        }
        case 'shl': case 'sal': case 'shr': case 'sar': {
          const size = a[0].t === 'reg8' || (a[0].t === 'mem' && a[0].size === 1) ? 1 : 4;
          const c = this.val(a[1], 1) & 31, x = this.val(a[0], size);
          if (!c) return 'Shift by 0: nothing changes.';
          let r;
          if (op === 'shr') { r = norm(x >>> c, size); F.CF = (x >>> (c - 1)) & 1; }
          else if (op === 'sar') { r = norm(signed(x, size) >> c, size); F.CF = (signed(x, size) >> (c - 1)) & 1; }
          else { r = norm(x << c, size); F.CF = (x >>> (size * 8 - c)) & 1; }
          this.setZS(r, size);
          this.set(a[0], size, r);
          return `${this.where(a[0])} = ${hex(r, size * 2)}. Flags: ${this.flagStr()}.`;
        }
        case 'imul': {
          const x = a.length === 3 ? this.val(a[1], 4) : R[a[0].reg];
          const y = this.val(a.length === 3 ? a[2] : a[1], 4);
          const r = Math.imul(x, y);
          F.CF = F.OF = (x | 0) * (y | 0) !== r ? 1 : 0;
          R[a[0].reg] = r >>> 0;
          return `${a[0].text.toUpperCase()} = ${x | 0} × ${y | 0} = ${r}.`;
        }
        case 'call': {
          const target = this.val(a[0], 4), ret = this.eip, old = R.esp;
          const name = this.baseName(target) || hex(target), cur = this.curFn();
          // The values pushed right before the call (inside this frame) are its arguments.
          let slot = R.esp, n = 0;
          const inFrame = s => !this.inRange(R.ebp) || s < R.ebp;
          while (n < 8 && this.inRange(slot) && this.tags[slot] && this.tags[slot].kind === 'push' && this.tags[slot].fn === cur && inFrame(slot)) {
            n++;
            this.tags[slot] = { kind: 'arg', fn: cur, text: `arg ${n} of ${name}`, plain: `argument #${n} for ${name}()` };
            slot += 4;
          }
          this.lastArgCount = n;
          this.push(ret, {
            kind: 'ret', fn: name, text: `return address → ${this.sym(ret) || hex(ret)}`,
            plain: `return address: when ${name}() finishes, go back to ${cur}()`,
          });
          this.calls.push({ fn: name, retSlot: R.esp });
          this.eip = target;
          return `CALL = push return address + jump. ESP ${hex(old)} → ${hex(R.esp)}, wrote the return address ${hex(ret)} (the instruction right after the call) to [ESP], then EIP = ${hex(target)}${this.sym(target) ? ' (' + this.sym(target) + ')' : ''}.`;
        }
        case 'ret': {
          const slot = R.esp, tag = this.tags[slot];
          const v = this.pop();
          if (a.length) R.esp = (R.esp + a[0].value) >>> 0;
          this.eip = v;
          const where = this.sym(v);
          let text = `RET = pop EIP. Read ${hex(v)} from [ESP] (${hex(slot)}) into EIP, ESP → ${hex(R.esp)}${a.length ? ` (+4 and +${a[0].value} for the arguments)` : ''}. Execution continues at ${where || hex(v)}.`;
          if (tag && tag.corrupt) text += ' ⚠ This return address was OVERWRITTEN after the call pushed it!';
          return text;
        }
        case 'leave': {
          const oldEsp = R.esp;
          R.esp = R.ebp;
          R.ebp = this.pop();
          const t = this.tags[(R.esp - 4) >>> 0];
          return `LEAVE = "mov esp, ebp" + "pop ebp". ESP ${hex(oldEsp)} → ${hex((R.esp - 4) >>> 0)} (locals discarded), then popped the saved EBP: EBP = ${hex(R.ebp)}, ESP = ${hex(R.esp)}. ESP now points at the return address.${t && t.corrupt ? ' ⚠ The saved EBP had been overwritten!' : ''}`;
        }
        case 'jmp': {
          const target = this.val(a[0], 4);
          this.eip = target;
          return `Unconditional jump to ${a[0].text} (${hex(target)}). The stack is not touched (unlike CALL).`;
        }
        case 'nop': return 'No operation.';
        case 'hlt':
          this.status = 'halted';
          this.message = `HLT: CPU halted. EAX = ${this.regs.eax} (${hex(this.regs.eax)})`;
          return 'Halted the CPU.';
      }
      throw new Error('unimplemented: ' + op);
    }
  }

  return {
    assemble, Machine, AsmError, hex, signed,
    REG32, CODE_BASE, STACK_TOP, STACK_BASE, STACK_SIZE, EXIT_ADDR,
    ops: Object.keys(ARITY), jcc: Object.keys(JCC), JCC,
  };
})();
