/*-*- mode:c;indent-tabs-mode:nil;c-basic-offset:2;tab-width:8;coding:utf-8 -*-│
│ vi: set et ft=c ts=2 sts=2 sw=2 fenc=utf-8                               :vi │
╞══════════════════════════════════════════════════════════════════════════════╡
│ Copyright 2022 Justine Alexandra Roberts Tunney                              │
│                                                                              │
│ Permission to use, copy, modify, and/or distribute this software for         │
│ any purpose with or without fee is hereby granted, provided that the         │
│ above copyright notice and this permission notice appear in all copies.      │
│                                                                              │
│ THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL                │
│ WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED                │
│ WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE             │
│ AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL         │
│ DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR        │
│ PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER               │
│ TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR             │
│ PERFORMANCE OF THIS SOFTWARE.                                                │
╚─────────────────────────────────────────────────────────────────────────────*/
#include "blink/flags.h"

#include "blink/builtin.h"
#include "blink/debug.h"
#include "blink/log.h"
#include "blink/machine.h"
#include "blink/rde.h"
#include "blink/stats.h"
#include "blink/x86.h"

bool GetParity(u8 b) {
  b ^= b >> 4;
  b ^= b >> 2;
  b ^= b >> 1;
  return ~b & 1;
}

// copies the flags in mask from flags into the machine, leaving the others
void ImportFlagsMasked(struct Machine *m, u64 flags, u64 mask) {
  m->flags = (flags & mask) | (m->flags & ~mask);
  m->flags = SetFlag(m->flags, FLAGS_RF, false);
  // PF lives in the lazy parity byte; bit 2 is only up to date if imported
  if (mask & PF) {
    m->flags = SetLazyParityByte(m->flags, !((m->flags >> FLAGS_PF) & 1));
  }
}

void ImportFlags(struct Machine *m, u64 flags) {
  u64 mask = 0;
  mask |= 1 << FLAGS_CF;
  mask |= 1 << FLAGS_PF;
  mask |= 1 << FLAGS_AF;
  mask |= 1 << FLAGS_ZF;
  mask |= 1 << FLAGS_SF;
  mask |= 1 << FLAGS_TF;
  mask |= 1 << FLAGS_IF;
  mask |= 1 << FLAGS_DF;
  mask |= 1 << FLAGS_OF;
  mask |= 1 << FLAGS_NT;
  mask |= 1 << FLAGS_AC;
  mask |= 1 << FLAGS_ID;
  ImportFlagsMasked(m, flags, mask);
}

// Returns the architectural flags word, including RF when an exception saves
// it. PUSHF masks RF/VM from its image separately; LAHF takes only its low byte.
u64 ExportFlags(struct Machine *m, u64 flags) {
  bool pf;
  pf = GetLazyParityBool(flags);
  // bits 3, 5, 15 and 22+ read as zero, bit 1 as one; the lazy parity byte
  // in 24..31 is blink's own, and PF is computed from it
  flags &= 0x3fffff & ~(u64)(1 << FLAGS_F1 | 1 << FLAGS_KF | 1 << FLAGS_F0 |
                             1 << FLAGS_PF);
  flags |= 1 << FLAGS_VF | (u64)pf << FLAGS_PF;
  if (!m->metal) {
    // a linux program runs at an i/o privilege level of zero, so it can
    // neither see an i/o privilege nor clear the interrupt flag
    flags &= ~(u64)(3 << FLAGS_IOPL);
    flags |= 1 << FLAGS_IF;
  } else {
    flags = SetFlag(flags, FLAGS_IOPL, 3);
  }
  return flags;
}
