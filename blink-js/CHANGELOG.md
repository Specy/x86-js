# Changelog

## 7.0.0

The Linux memory layout changes for every program: PIEs start at
0x555555554000, mappings allocate downwards below 0x7ffff7fff000, the
stack is below 0x7ffffffff000, and the heap starts after the main executable.
Debugger reads and Undo work throughout the guest address space.

- Run static and dynamic glibc programs, fixing the Linux entry rdx and
  copying private file mappings into ordinary pages to avoid browser mmap
  aborts and excessive heap growth.
- Load ELF programs with loadExecutable, resolving the five bundled Ubuntu
  libraries on demand: ld-linux, libc, libm, libstdc++ and libgcc_s.
- Pass lossless UTF-8 Arguments and the fixed Linux environment.
- Protect a mounted running Executable from writes/truncation with ETXTBSY
  and from unlink/rename with EBUSY.
- Support set_robust_list, get_robust_list, rseq, ptrace TRACEME and the
  existing futex wait/wake handler; correct LZCNT and TZCNT.
- Add @specy/x86/disassembler with independent ELF analysis and Zydis 4.1.1
  batch decoding. Instruction queries use its NASM-flavoured Intel text,
  including CET and vector extensions Blink cannot execute.
- Add address Breakpoints, getLoadedObjects, getLoadedObjectBytes and the
  unimplementedSyscall event, retaining each call's ENOSYS result.
- Add assembleInstruction for temporary instruction patches through Pokes.

This version was prepared locally for binary-import implementation. It has
not been tagged, pushed or published.
