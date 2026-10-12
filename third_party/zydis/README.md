# Zydis 4.1.1

Amalgamated with Zydis's assets/amalgamate.py from tag v4.1.1
(a2278f1d254e492f6a6b39f6cb5d1f5d515659dc), with Zycore at
0b2432ced0884fd152b471d97ecf0258ff4d859f (v1.5.2).
Both MIT licences are included. The amalgamation contains Zycore too.

To regenerate, clone https://github.com/zyantific/zydis at v4.1.1 without
recursive submodules, fetch https://github.com/zyantific/zycore-c at the commit
above into dependencies/zycore, and run python3 assets/amalgamate.py.
Copy amalgamated-dist/Zydis.{c,h} here. compile_zydis.sh builds these committed
sources without requiring CMake or network access.
