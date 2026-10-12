#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
cache_dir="$package_dir/.cache/linux-runtime"
asset_dir="$package_dir/src/assets/linux"
mkdir -p "$cache_dir" "$asset_dir"

fetch_package() {
  local url="$1" digest="$2" name="$3"
  curl -fL --retry 2 "$url" -o "$cache_dir/$name.deb"
  printf '%s  %s\n' "$digest" "$cache_dir/$name.deb" | sha256sum -c -
  dpkg-deb --extract "$cache_dir/$name.deb" "$cache_dir/$name"
}
fetch_package 'https://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.43-2ubuntu2.4_amd64.deb' \
  a613b457f3ff9c84ebd28af8a05afdec22605ad9aed87c71e3a6ae5170aeb9ca libc6
fetch_package 'https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-16/libstdc++6_16-20260322-1ubuntu1_amd64.deb' \
  a32b9ad585e39bdc7bd15d1eae6293461e6d466859a1dd2f7862d1e40f89b9d8 libstdcpp
fetch_package 'https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-16/libgcc-s1_16-20260322-1ubuntu1_amd64.deb' \
  2fb4d81c14fdf34251639ae82f5181f9f98480ea16125d535571ac1be9db3065 libgcc

for name in ld-linux-x86-64.so.2 libc.so.6 libm.so.6; do
  cp -L "$cache_dir/libc6/usr/lib/x86_64-linux-gnu/$name" "$asset_dir/$name"
done
cp -L "$cache_dir/libstdcpp/usr/lib/x86_64-linux-gnu/libstdc++.so.6" "$asset_dir/libstdc++.so.6"
cp -L "$cache_dir/libgcc/usr/lib/x86_64-linux-gnu/libgcc_s.so.1" "$asset_dir/libgcc_s.so.1"

# The licence/copyright texts ship in git alongside the reproducible binaries.
# Their Ubuntu source package notices include the GCC Runtime Library Exception.
for name in LGPL-2.1.txt GPL-3.0.txt GCC-copyright.txt glibc-copyright.txt; do
  test -s "$asset_dir/$name"
done
python3 - "$asset_dir" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
names = ['ld-linux-x86-64.so.2', 'libc.so.6', 'libm.so.6', 'libstdc++.so.6', 'libgcc_s.so.1']
rows = []
for name in names:
    glibc = name in names[:3]
    rows.append({
        'soname': name,
        'path': '/lib64/' + name if name.startswith('ld-') else '/lib/x86_64-linux-gnu/' + name,
        'package': 'libc6' if glibc else 'libstdc++6' if name.startswith('libstd') else 'libgcc-s1',
        'sourcePackage': 'glibc' if glibc else 'gcc-16',
        'version': '2.43-2ubuntu2.4' if glibc else '16-20260322-1ubuntu1',
        'sha256': hashlib.sha256((root / name).read_bytes()).hexdigest(),
        'licence': 'LGPL-2.1-or-later' if glibc else 'GPL-3.0-with-GCC-exception'
    })
(root / 'manifest.json').write_text(json.dumps(rows, indent=4) + '\n')
(root / 'NOTICE.md').write_text('''# Linux runtime libraries

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
''')
PY
sha256sum "$asset_dir"/*.so*
