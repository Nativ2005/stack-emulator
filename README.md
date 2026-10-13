# x86 Stack Emulator

An interactive, in-browser emulator of the **x86 (32-bit) stack**. Write short Intel-syntax
assembly, step through it, and watch `ESP`, `EBP` and `EIP` move as values are pushed, popped,
called and returned.

**Live demo:** https://nativ2005.github.io/stack-emulator/

## Features

- **Beginner mode** (default): plain-English labels on every stack slot ("argument #1 for add()",
  "return address: when add() finishes, go back to main()", "local variable of main()"), friendly
  step explanations, and a simpler view. **Expert mode** adds `ebp±N` offsets, ASCII, flags and raw explanations.
- **Intro & tooltips**: a 60-second "New to the stack?" intro with a frame diagram, and hover hints on
  registers, slots, columns and buttons.
- **Animations**: pushed values slide in, popped slots flash, and the ESP/EBP arrows glide to their new slot.
- **Dec / Hex toggle** for values (addresses always stay hex).
- **Real stack layout**: high addresses on top, the stack grows down. `ESP`/`EBP` pointers,
  offsets relative to `EBP` (`ebp+8`, `ebp-4`, …), hex values and ASCII view.
- **Registers**: `EAX EBX ECX EDX ESI EDI ESP EBP EIP` plus `ZF SF CF OF` flags; changed values are highlighted.
- **Assembly editor**: labels, comments, memory operands like `[ebp-8]` / `[eax+ecx*4+8]`,
  byte/dword sizes, and an address-annotated listing with breakpoints.
- **Step / Back / Run**: execute one instruction at a time, **undo** steps, or run at an adjustable speed.
- **Stack playground**: `push`, `pop`, or any single instruction by hand, without a program.
- **Explanations**: every instruction says what it did to the stack, e.g. *"CALL = push return address + jump"*.
- **Stack frames**: return addresses and saved `EBP`s are labelled; the current frame is shaded.
- **Buffer overflow demos**: overwritten return addresses / saved `EBP` are flagged in red, and
  returning to `0x41414141` ("AAAA") crashes with a segfault. A ret2win example is included.

## Examples

1. Push & Pop basics
2. Function call (cdecl): arguments, `call`, prologue / epilogue, `ret`
3. Local variables: `sub esp, N`, `[ebp-4]`
4. Recursion: factorial, one frame per call
5. Buffer overflow (crash)
6. Buffer overflow (ret2win)

## Supported instructions

`push pop mov lea xchg add sub and or xor cmp test inc dec neg not shl sal shr sar imul call ret leave jmp
je/jz jne/jnz jl jg jle jge jb ja jbe jae js jns (+ aliases) nop hlt`

Execution starts at `main` (or `_start`, or the first instruction). `main` is entered as if it
had been called: the top stack slot holds a return address into `__libc_start_main`, so a final
`ret` exits the program cleanly.

## Model / simplifications

- Only the stack (`0xbffffc00`–`0xbfffffff`, 1 KiB) is mapped memory. Other addresses fault.
- Code starts at `0x08049000`. Instruction lengths approximate real x86 encodings, so addresses
  look realistic, but no machine code is generated.
- No 16-bit registers, no `mul`/`div`, no system calls.

## Run locally

It's a static site with no build step. Open `index.html`, or serve the folder:

```bash
python -m http.server 8000
```

## License

MIT
