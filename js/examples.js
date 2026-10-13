'use strict';
const EXAMPLES = [
  {
    name: '1. Push & Pop basics',
    code: `; Push & Pop basics
; Every PUSH moves ESP DOWN by 4 and writes a value.
; Every POP reads the value at ESP and moves ESP UP by 4.
; The stack is LIFO: Last In, First Out.

main:
    push ebp            ; prologue: save the caller's EBP
    mov ebp, esp        ;           EBP = base of this function's frame
    mov eax, 0x11111111
    mov ebx, 0x22222222
    push eax            ; ESP -= 4 ; [ESP] = EAX
    push ebx            ; ESP -= 4 ; [ESP] = EBX
    push 0x33333333     ; you can push an immediate value too
    pop ecx             ; ECX = 0x33333333 (the LAST thing pushed)
    pop edx             ; EDX = 0x22222222
    pop esi             ; ESI = 0x11111111
    xor eax, eax        ; return 0
    pop ebp             ; epilogue: restore the caller's EBP
    ret                 ; return from main -> program exits
`,
  },
  {
    name: '2. Function call (cdecl)',
    code: `; int add(int a, int b)  called as  add(5, 7)
; cdecl: arguments are pushed RIGHT-TO-LEFT,
; the caller removes them after the call, result in EAX.

main:
    push ebp
    mov ebp, esp
    push 7              ; argument b
    push 5              ; argument a
    call add            ; push return address, jump to add
    add esp, 8          ; caller cleans up the 2 arguments
    ; EAX = 12 here
    leave
    ret

add:
    push ebp            ; prologue: save the caller's EBP
    mov ebp, esp        ;           EBP = base of the new frame
    mov eax, [ebp+8]    ; a   ([ebp+4] is the return address)
    add eax, [ebp+12]   ; b
    pop ebp             ; epilogue: restore caller's EBP
    ret                 ; pop the return address into EIP
`,
  },
  {
    name: '3. Local variables',
    code: `; Local variables live BELOW EBP:  [ebp-4], [ebp-8], ...
; Arguments live ABOVE EBP:        [ebp+8], [ebp+12], ...

main:
    push ebp
    mov ebp, esp
    sub esp, 8              ; reserve room for 2 locals (int x, y)
    mov dword [ebp-4], 10   ; x = 10
    mov dword [ebp-8], 32   ; y = 32
    mov eax, [ebp-4]
    add eax, [ebp-8]        ; eax = x + y = 42
    mov esp, ebp            ; free the locals ...
    pop ebp                 ; ... these two lines = "leave"
    ret
`,
  },
  {
    name: '4. Recursion: factorial',
    code: `; int fact(int n) { return n <= 1 ? 1 : n * fact(n-1); }
; Watch a new stack frame appear for every recursive call.

main:
    push ebp            ; prologue: save the caller's EBP
    mov ebp, esp        ;           EBP = base of this function's frame
    push 4
    call fact           ; fact(4)
    add esp, 4
    pop ebp
    ret                 ; EAX = 24

fact:
    push ebp
    mov ebp, esp
    mov eax, [ebp+8]    ; eax = n
    cmp eax, 1
    jg .recurse
    mov eax, 1          ; base case: return 1
    jmp .done
.recurse:
    dec eax
    push eax            ; argument n-1
    call fact           ; eax = fact(n-1)
    add esp, 4
    imul eax, [ebp+8]   ; eax = n * fact(n-1)
.done:
    pop ebp
    ret
`,
  },
  {
    name: '5. Buffer overflow (crash)',
    code: `; Classic stack buffer overflow.
; vuln() writes 16 bytes into an 8-byte local buffer.
; The extra bytes overwrite the SAVED EBP and the RETURN ADDRESS.

main:
    push ebp
    mov ebp, esp
    call vuln
    mov eax, 0          ; never reached!
    leave
    ret

vuln:
    push ebp
    mov ebp, esp
    sub esp, 8              ; char buf[8]   at [ebp-8]
    lea edi, [ebp-8]        ; edi -> buf
    mov ecx, 16             ; copy 16 bytes (buffer is only 8!)
copy:
    mov byte [edi], 'A'     ; 0x41
    inc edi
    dec ecx
    jnz copy
    leave                   ; EBP <- 0x41414141  (corrupted)
    ret                     ; EIP <- 0x41414141  -> crash
`,
  },
  {
    name: '6. Buffer overflow (ret2win)',
    code: `; Overwrite the return address with the address of win()
; so that vuln() "returns" into a function nobody called.

main:
    push ebp
    mov ebp, esp
    call vuln
    mov eax, 0          ; never reached
    leave
    ret

vuln:
    push ebp
    mov ebp, esp
    sub esp, 8              ; char buf[8]
    lea edi, [ebp-8]
    mov ecx, 12             ; 8 bytes of buf + 4 bytes of saved EBP
pad:
    mov byte [edi], 'A'
    inc edi
    dec ecx
    jnz pad
    mov dword [edi], win    ; next 4 bytes = the return address!
    leave
    ret                     ; returns into win()

win:
    push ebp            ; prologue: save the caller's EBP
    mov ebp, esp        ;           EBP = base of this function's frame
    mov eax, 0x1337         ; you win!
    hlt
`,
  },
  {
    name: 'Empty (playground)',
    code: `; Write your own code here, or leave it empty and use the
; "Stack playground" panel to push / pop by hand.

main:
    push ebp            ; prologue: save the caller's EBP
    mov ebp, esp        ;           EBP = base of this function's frame
    nop                 ; your code here
    pop ebp
    ret
`,
  },
];
