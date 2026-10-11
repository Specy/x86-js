# Linux runtime libraries

Unmodified Ubuntu 26.04 binaries, separate from the Core's own code:

- glibc 2.43-2ubuntu2.4: ld-linux-x86-64.so.2, libc.so.6 and libm.so.6 (LGPL-2.1-or-later).
- gcc-16 16-20260322-1ubuntu1: libstdc++.so.6 and libgcc_s.so.1 (GPL-3.0 with the GCC Runtime Library Exception).

See LGPL-2.1.txt, GPL-3.0.txt and the complete Ubuntu copyright notices;
GCC-copyright.txt includes the Runtime Library Exception.
The corresponding source packages, including Ubuntu modifications, are available at:

- https://archive.ubuntu.com/ubuntu/pool/main/g/glibc/ (glibc 2.43-2ubuntu2.4)
- https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-16/ (gcc-16 16-20260322-1ubuntu1)

Run scripts/fetch-linux-runtime.sh to fetch the SHA256-pinned binary packages,
extract the five libraries and regenerate manifest.json. Assets are copied into dist;
consumers fetch only the libraries needed by their program.
