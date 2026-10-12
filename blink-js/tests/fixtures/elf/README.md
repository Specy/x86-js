# Executable fixtures

Rebuild deliberately with `bash build.sh`; CI runs the committed binaries, never the host compiler.
Built on Ubuntu with GCC/G++ 15.2.0 and glibc 2.43-2ubuntu2.4. Dynamic C++ uses
libstdc++6 and libgcc-s1 16-20260322-1ubuntu1. The flags are recorded in build.sh.
A Go toolchain was unavailable; hello.go is supplied but no Go executable is committed.

The static binaries contain LGPL-2.1-or-later glibc object code. Corresponding source:
https://archive.ubuntu.com/ubuntu/pool/main/g/glibc/ (glibc 2.43-2ubuntu2.4).
Fixture sources are supplied here to allow rebuilding and relinking against modified glibc.

The overflow fixture uses an unterminated buffer ending at a guard page instead of an
uncontrolled stack overflow: this reliably faults inside strlen on every run.

## SHA256

```
7f77fd2c5eff322b728f0ba60d1ef3fcb6bfe5335a4a4b32ad46aebfad276ad9  crackme
5f6b640abab92e6b012c32b49226a78d18700353e8effd79339d77ac10f7edb3  crackme-stripped
89acd32b85731567d0c970a61035fd8b351a0b7fe3098ddabf69011cc9c7b6b3  crackme-static-pie
00f5e9fd9ba44a10a8629c06301e5fca9933bc3bc6deb3583001082c51f2fb59  crackme-static
4468115bd060a4a6035d6549f9cfdd571983d7a68dc4fa647f0bf1a7265cb839  hello-atexit
a8953e761224411644494e8545d1bdb50a2287c0417bd06551b5f88147f74968  hello-atexit-static-pie
d263d8683f3f6d0b6844a49529211b1a873acffd5bf001504abc2148219123ce  hello-atexit-static
4ba3159e5c6e1c9c3cd173bccd053c6cb329f0efe395cb85edd4e7e886572b65  math
4c59f184381cef86ee8972c0cb90778be8f741092e838ae6aaf9e53f58fd45e1  cpp
68c62769de2dea36035ad41bf9a285d1b440ff0962049b6ed893dbf69c043135  argv-env
a1147f18b7d5cc115cef0297aaace7e2cd3f916e2b961f4f7994706b35480983  ptrace
20bc26a3780e74f86f8ae749cdc0adaf2d70f213e8512467193786ac434db619  self-write
48174079d956ab147e6dfff552daafaadfbb62ad64f77d9872fbbfc50df7777e  crackme-argv
5960ae3d0cec151f5f9486071900bd3a76e811c07ec490dbd0d26c76ef3002ca  overflow
584dcd7342453d6120c4ee83e298e50bd4f8b8076c9e61887c169624405da8c8  timedwait
c8a654f76b11aa377dec3346d4fd465b8ca0d746565e9a4369f9703ebf9c95cb  avx
```
