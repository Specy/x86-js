# Linux runtime libraries

These unmodified Ubuntu 26.04 runtime binaries are distributed separately from the
Core's own code. glibc (`ld-linux-x86-64.so.2`, `libc.so.6`, `libm.so.6`) is
2.43-2ubuntu2.4, LGPL-2.1-or-later. GCC (`libstdc++.so.6`, `libgcc_s.so.1`) is
16-20260322-1ubuntu1, GPL-3.0 with the GCC Runtime Library Exception.

See the accompanying licence and copyright files, including the exception in
GCC-copyright.txt. Corresponding source packages, including Ubuntu modifications:

- glibc 2.43-2ubuntu2.4: https://archive.ubuntu.com/ubuntu/pool/main/g/glibc/
- gcc-16 16-20260322-1ubuntu1: https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-16/

The reproducible fetch script and per-file manifest are added with the library
resolution API. These bytes are initially staged for the executable regression fixtures.
