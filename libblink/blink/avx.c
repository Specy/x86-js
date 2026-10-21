#include <string.h>

#include "blink/endian.h"
#include "blink/machine.h"
#include "blink/modrm.h"
#include "blink/rde.h"
#include "blink/x86.h"

/*
 * AVX and AVX2.
 *
 * A VEX instruction is dispatched under its own opcode key: the legacy opcode
 * map (1, 2 or 3) with XED_VEX_MAP added, so 0f 58 as VEX is 0x558. GetVexOp()
 * is what GetOp() asks for those keys.
 *
 * Most VEX instructions are a legacy SSE instruction with a third source, and
 * their 256-bit form is the legacy instruction run twice, once per 128-bit
 * lane. OpVex() does that by calling the legacy handler itself:
 *
 *   vaddps ymm1, ymm2, ymm3/m256   ymm1 = ymm2 + ymm3/m256
 *   addps   xmm1, xmm2/m128        xmm1 = xmm1 + xmm2/m128
 *
 * It copies the first source into the destination, calls addps for the low
 * lanes, swaps the high lanes into the xmm file and calls it again with the
 * memory operand 16 bytes further on. Instructions that have no legacy
 * counterpart, or whose lanes are not independent, have handlers of their own.
 *
 * The upper halves live in m->ymmh. Legacy SSE leaves them alone, VEX.128
 * zeroes them, and VEX.256 writes them.
 */

// Properties of a VEX opcode, in addition to kVexOk.
#define kVexOk     0x8000
#define kVexV      0x0001  // vvvv is a source operand
#define kVexVs     0x0002  // vvvv is a source operand of the scalar forms
#define kVexVn     0x0004  // vvvv is a source operand of the packed forms
#define kVexL0     0x0008  // there is no 256-bit form
#define kVexLig    0x0010  // VEX.L is ignored
#define kVexNodest 0x0020  // the destination is not a vector register
#define kVexStore  0x0040  // the destination is the r/m operand
#define kVexAlign  0x0080  // an unprefixed or 66 memory operand is aligned
#define kVexCount  0x0100  // r/m is a 128-bit count shared by both lanes
#define kVexShimm  0x0200  // shift by immediate: r/m is the source, vvvv the dst
#define kVexMem    0x0400  // the r/m operand must be memory
#define kVexMemOsz 0x0800  // the r/m operand must be memory when prefixed 66
#define kVexRegOnly 0x1000  // the r/m operand must be a register

// The legacy handler for a VEX key.
#define Legacy(op) ((op) & ~(XED_VEX_MAP << 8))

#define kVex1 (XED_ILD_MAP1 | XED_VEX_MAP)
#define kVex2 (XED_ILD_MAP2 | XED_VEX_MAP)
#define kVex3 (XED_ILD_MAP3 | XED_VEX_MAP)

#define SIMPLE(x)  (kVexOk | (x))
#define ARITH      SIMPLE(kVexV)
#define UNARY      SIMPLE(0)
#define SCALAR     SIMPLE(kVexVs)
#define LOAD       SIMPLE(0)
#define STORE      SIMPLE(kVexStore)
#define SHIFT      SIMPLE(kVexV | kVexCount)

// The VEX opcodes that run a legacy handler, indexed by map - 1. The bits above
// the flags say which of the four prefixes (none, 66, F3, F2) the opcode takes.
#define PP(x) ((x) << 16)
#define kPpNone 1
#define kPp66   2
#define kPpF3   4
#define kPpF2   8
#define kPpAny  15

static const u32 kVexLegacy[3][256] = {
    {
        [0x10] = SIMPLE(kVexVs) | PP(kPpAny),
        [0x11] = SIMPLE(kVexVs | kVexStore) | PP(kPpAny),
        [0x12] = SIMPLE(kVexVn | kVexMemOsz) | PP(kPpAny),
        [0x13] = SIMPLE(kVexStore | kVexMem | kVexL0) | PP(kPpNone | kPp66),
        [0x14 ... 0x15] = ARITH | PP(kPpNone | kPp66),
        [0x16] = SIMPLE(kVexVn | kVexMemOsz) | PP(kPpNone | kPp66 | kPpF3),
        [0x17] = SIMPLE(kVexStore | kVexMem | kVexL0) | PP(kPpNone | kPp66),
        [0x28] = SIMPLE(kVexAlign) | PP(kPpNone | kPp66),
        [0x29] = SIMPLE(kVexStore | kVexAlign) | PP(kPpNone | kPp66),
        [0x2A] = SIMPLE(kVexV | kVexLig) | PP(kPpF3 | kPpF2),
        [0x2B] = SIMPLE(kVexStore | kVexAlign | kVexMem) | PP(kPpNone | kPp66),
        [0x2C ... 0x2D] = SIMPLE(kVexNodest | kVexLig) | PP(kPpF3 | kPpF2),
        [0x2E ... 0x2F] = SIMPLE(kVexNodest | kVexLig) | PP(kPpNone | kPp66),
        [0x51] = SCALAR | PP(kPpAny),
        [0x52 ... 0x53] = SCALAR | PP(kPpNone | kPpF3),
        [0x54 ... 0x57] = ARITH | PP(kPpNone | kPp66),
        [0x58 ... 0x59] = ARITH | PP(kPpAny),
        [0x5B] = UNARY | PP(kPpNone | kPp66 | kPpF3),
        [0x5C ... 0x5F] = ARITH | PP(kPpAny),
        [0x60 ... 0x6D] = ARITH | PP(kPp66),
        [0x6E] = SIMPLE(kVexL0) | PP(kPp66),
        [0x6F] = SIMPLE(kVexAlign) | PP(kPp66 | kPpF3),
        [0x70] = UNARY | PP(kPp66 | kPpF3 | kPpF2),
        [0x74 ... 0x76] = ARITH | PP(kPp66),
        [0x7C ... 0x7D] = ARITH | PP(kPp66 | kPpF2),
        [0x7F] = SIMPLE(kVexStore | kVexAlign) | PP(kPp66 | kPpF3),
        [0xC4] = SIMPLE(kVexV | kVexL0) | PP(kPp66),
        [0xC5] = SIMPLE(kVexNodest | kVexL0 | kVexRegOnly) | PP(kPp66),
        [0xC6] = ARITH | PP(kPpNone | kPp66),
        [0xD0] = ARITH | PP(kPp66 | kPpF2),
        [0xD1 ... 0xD3] = SHIFT | PP(kPp66),
        [0xD4 ... 0xD5] = ARITH | PP(kPp66),
        [0xD6] = SIMPLE(kVexStore | kVexL0) | PP(kPp66),
        [0xD8 ... 0xDF] = ARITH | PP(kPp66),
        [0xE0 ... 0xE5] = ARITH | PP(kPp66),
        [0xE7] = SIMPLE(kVexStore | kVexAlign | kVexMem) | PP(kPp66),
        [0xE8 ... 0xEF] = ARITH | PP(kPp66),
        [0xF0] = SIMPLE(kVexMem) | PP(kPpF2),
        [0xF1 ... 0xF3] = SHIFT | PP(kPp66),
        [0xF4 ... 0xF6] = ARITH | PP(kPp66),
        [0xF7] = SIMPLE(kVexNodest | kVexL0 | kVexRegOnly) | PP(kPp66),
        [0xF8 ... 0xFE] = ARITH | PP(kPp66),
    },
    {
        [0x00 ... 0x0B] = ARITH | PP(kPp66),
        [0x1C ... 0x1E] = UNARY | PP(kPp66),
        [0x2A] = SIMPLE(kVexAlign | kVexMem) | PP(kPp66),
        [0x40] = ARITH | PP(kPp66),
    },
    {
        [0x0F] = ARITH | PP(kPp66),
        [0x44] = SIMPLE(kVexV | kVexL0) | PP(kPp66),
    },
};

static u32 VexAttr(long op) {
  return kVexLegacy[(op >> 8) - kVex1][op & 255];
}

static void SwapLanes(struct Machine *m, int i) {
  u8 t[16];
  memcpy(t, m->xmm[i], 16);
  memcpy(m->xmm[i], m->ymmh[i], 16);
  memcpy(m->ymmh[i], t, 16);
}

static void SetRm(u64 *rde, int i) {
  *rde = (*rde & ~(u64)kRexbRmMask) | (u64)i << 7;
}

static void SetReg(u64 *rde, int i) {
  *rde = (*rde & ~(u64)kRexrRegMask) | (u64)i;
}

// Remembers a register so HaltMachine() can put it back if the instruction
// faults after it was changed.
static void KeepVex(struct Machine *m, int i) {
  int k;
  for (k = 0; k < m->vexundo.count; ++k) {
    if (m->vexundo.reg[k] == i) return;
  }
  k = m->vexundo.count++;
  m->vexundo.reg[k] = i;
  memcpy(m->vexundo.lo[k], m->xmm[i], 16);
  memcpy(m->vexundo.hi[k], m->ymmh[i], 16);
}

void UndoVex(struct Machine *m) {
  int k;
  for (k = 0; k < m->vexundo.count; ++k) {
    memcpy(m->xmm[m->vexundo.reg[k]], m->vexundo.lo[k], 16);
    memcpy(m->ymmh[m->vexundo.reg[k]], m->vexundo.hi[k], 16);
  }
  m->vexundo.active = false;
  m->vexundo.count = 0;
}

static void CheckAligned(P, int lanes) {
  i64 v;
  if (!IsModrmRegister(rde)) {
    v = ComputeAddress(A);
    if (v & (16 * lanes - 1)) ThrowSegmentationFault(m, v);
  }
}

// vshufpd takes two bits of its immediate for each lane
static bool IsShufpd(u64 rde) {
  return Mopcode(rde) == (kVex1 << 8 | 0xC6) && Osz(rde);
}

/*
 * Runs a legacy SSE handler as the VEX instruction `attr` describes.
 *
 * bind is the register the legacy handler reads and writes in place, and `other`
 * the one it only reads. When those are the same register the first source
 * cannot be copied over it, so the handler is pointed at a scratch register
 * holding the other operand's value instead. A shared shift count does the same
 * so that the second pass sees the count and not the second lane.
 */
static void OpVexAs(P, nexgen32e_f legacy, u32 attr) {
  u8 saved[16], count[16], value[16];
  u64 rde2;
  int k, h, lanes, d, v, r, y, bind, other, regs[4], nregs;
  bool regform, usev, store, nodest;
  lanes = Ymm(rde) && !(attr & kVexLig) ? 2 : 1;
  if (lanes == 2 && (attr & kVexL0)) OpUdImpl(m);
  if (lanes == 2 && (attr & kVexVn) && !Rep(rde)) OpUdImpl(m);
  if (!IsModrmRegister(rde) && (attr & kVexRegOnly)) OpUdImpl(m);
  if (IsModrmRegister(rde) && ((attr & kVexMem) || ((attr & kVexMemOsz) && Osz(rde)))) OpUdImpl(m);
  d = RexrReg(rde);
  v = Vreg(rde);
  r = RexbRm(rde);
  regform = IsModrmRegister(rde);
  store = attr & kVexStore;
  nodest = attr & kVexNodest;
  usev = (attr & kVexV) || ((attr & kVexVs) && Rep(rde)) ||
         ((attr & kVexVn) && !Rep(rde));
  if (!usev && v) OpUdImpl(m);
  if ((attr & kVexAlign) && !Rep(rde)) CheckAligned(A, lanes);
  // a 256-bit store must not write its first half and then fault on the second
  if (lanes == 2 && store && !regform) {
    ReserveAddress(m, ComputeAddress(A), 32, true);
    m->stashaddr = 0;
  }
  bind = nodest || (store && !regform) ? -1 : store ? r : d;
  other = store ? d : r;
  if (bind < 0) usev = false;
  y = -1;
  if (regform && ((usev && other == bind && v != bind) || (attr & kVexCount))) {
    y = 0;
    while (y == d || y == v || y == r) ++y;
  }
  nregs = 0;
  regs[nregs++] = d;
  if (usev && v != d) regs[nregs++] = v;
  if (regform && r != d && !(usev && r == v)) regs[nregs++] = r;
  if (y >= 0) regs[nregs++] = y;
  m->vexundo.count = 0;
  for (k = 0; k < nregs; ++k) KeepVex(m, regs[k]);
  m->vexundo.active = true;
  if (y >= 0) memcpy(count, m->xmm[other], 16);
  for (h = 0; h < lanes; ++h) {
    if (h) {
      for (k = 0; k < nregs; ++k) SwapLanes(m, regs[k]);
    }
    rde2 = rde;
    if (y >= 0) {
      memcpy(value, (attr & kVexCount) ? count : m->xmm[other], 16);
      memcpy(saved, m->xmm[y], 16);
      memcpy(m->xmm[y], value, 16);
      if (store) {
        SetReg(&rde2, y);
      } else {
        SetRm(&rde2, y);
      }
    }
    if (usev && v != bind) memcpy(m->xmm[bind], m->xmm[v], 16);
    legacy(m, rde2, disp + (h && !(attr & kVexCount) ? 16 : 0),
           h && IsShufpd(rde) ? uimm0 >> 2 : uimm0);
    if (m->stashaddr) CommitStash(m);
    if (y >= 0) memcpy(m->xmm[y], saved, 16);
    if (h) {
      for (k = 0; k < nregs; ++k) SwapLanes(m, regs[k]);
    }
  }
  m->vexundo.active = false;
  if (lanes == 1 && !nodest && (!store || regform)) {
    memset(m->ymmh[store ? r : d], 0, 16);
  }
}

static void CallLegacy(P, nexgen32e_f legacy, i64 offset) {
  legacy(m, rde, disp + offset, uimm0);
  if (m->stashaddr) CommitStash(m);
}

static void BeginVex(struct Machine *m, const int *regs, int n) {
  int k;
  m->vexundo.count = 0;
  for (k = 0; k < n; ++k) KeepVex(m, regs[k]);
  m->vexundo.active = true;
}

// vpsllw, vpsrad and the other shifts of a register by an immediate: the
// destination is vvvv and the source the r/m register.
static void OpVexShiftImm(P) {
  int h, regs[2], v, r;
  nexgen32e_f legacy;
  u64 rde2;
  if (!IsModrmRegister(rde)) OpUdImpl(m);
  legacy = GetOp(Legacy(Mopcode(rde)));
  v = Vreg(rde);
  r = RexbRm(rde);
  regs[0] = v;
  regs[1] = r;
  BeginVex(m, regs, v == r ? 1 : 2);
  for (h = 0; h < (Ymm(rde) ? 2 : 1); ++h) {
    if (h) {
      SwapLanes(m, v);
      if (r != v) SwapLanes(m, r);
    }
    if (v != r) memcpy(m->xmm[v], m->xmm[r], 16);
    rde2 = rde;
    SetRm(&rde2, v);
    legacy(m, rde2, disp, uimm0);
    if (h) {
      SwapLanes(m, v);
      if (r != v) SwapLanes(m, r);
    }
  }
  m->vexundo.active = false;
  if (!Ymm(rde)) memset(m->ymmh[v], 0, 16);
}

// vmovmskps, vmovmskpd and vpmovmskb: one bit mask per lane, joined.
static void OpVexMask(P) {
  int dest, bits;
  u64 lo;
  nexgen32e_f legacy;
  if (!IsModrmRegister(rde) || Vreg(rde) || Rep(rde)) OpUdImpl(m);
  if (Opcode(rde) == 0xD7 && !Osz(rde)) OpUdImpl(m);
  legacy = GetOp(Legacy(Mopcode(rde)));
  bits = Opcode(rde) == 0xD7 ? 16 : Osz(rde) ? 2 : 4;
  dest = RexrReg(rde);
  legacy(m, rde, disp, uimm0);
  if (Ymm(rde)) {
    lo = Read64(m->weg[dest]);
    SwapLanes(m, RexbRm(rde));
    legacy(m, rde, disp, uimm0);
    SwapLanes(m, RexbRm(rde));
    Write64(m->weg[dest], lo | Read64(m->weg[dest]) << bits);
  }
}

// vcvtps2pd and vcvtdq2pd read half a vector and write a whole one, so the
// second lane of a 256-bit form comes from the upper half of the source.
static void OpVexWiden(P) {
  u8 saved[16], source[16];
  nexgen32e_f legacy;
  u64 rde2;
  int d, r, y, regs[3], h;
  bool regform;
  legacy = GetOp(Legacy(Mopcode(rde)));
  d = RexrReg(rde);
  r = RexbRm(rde);
  regform = IsModrmRegister(rde);
  if (Vreg(rde)) OpUdImpl(m);
  if (!Ymm(rde)) {
    CallLegacy(A, legacy, 0);
    memset(m->ymmh[d], 0, 16);
    return;
  }
  y = 0;
  while (y == d || y == r) ++y;
  regs[0] = d;
  regs[1] = y;
  regs[2] = r;
  BeginVex(m, regs, regform ? 3 : 2);
  memcpy(source, m->xmm[r], 16);
  memcpy(saved, m->xmm[y], 16);
  for (h = 0; h < 2; ++h) {
    if (h) SwapLanes(m, d);
    rde2 = rde;
    if (regform) {
      memcpy(m->xmm[y], source + 8 * h, 8);
      memset(m->xmm[y] + 8, 0, 8);
      SetRm(&rde2, y);
    }
    legacy(m, rde2, disp + 8 * h, uimm0);
    if (m->stashaddr) CommitStash(m);
    if (h) SwapLanes(m, d);
  }
  memcpy(m->xmm[y], saved, 16);
  m->vexundo.active = false;
}

// vcvtpd2ps, vcvttpd2dq and vcvtpd2dq read a whole vector and write half of
// one: a 256-bit source fills both halves of the destination.
static void OpVexNarrow(P) {
  u8 saved[16];
  nexgen32e_f legacy;
  u64 rde2;
  int d, r, y, regs[3];
  legacy = GetOp(Legacy(Mopcode(rde)));
  d = RexrReg(rde);
  r = RexbRm(rde);
  if (Vreg(rde)) OpUdImpl(m);
  CallLegacy(A, legacy, 0);
  if (Ymm(rde)) {
    y = 0;
    while (y == d || y == r) ++y;
    regs[0] = d;
    regs[1] = y;
    regs[2] = r;
    BeginVex(m, regs, 3);
    memcpy(saved, m->xmm[y], 16);
    if (IsModrmRegister(rde)) SwapLanes(m, r);
    rde2 = rde;
    SetReg(&rde2, y);
    legacy(m, rde2, disp + 16, uimm0);
    if (m->stashaddr) CommitStash(m);
    if (IsModrmRegister(rde)) SwapLanes(m, r);
    memcpy(m->xmm[d] + 8, m->xmm[y], 8);
    memcpy(m->xmm[y], saved, 16);
    m->vexundo.active = false;
  }
  memset(m->ymmh[d], 0, 16);
}

// vcvtss2sd, vcvtsd2ss, vcvtps2pd and vcvtpd2ps
static void OpVex5a(P) {
  if (Rep(rde)) {
    OpVexAs(A, GetOp(Legacy(Mopcode(rde))), kVexV | kVexLig);
  } else if (Osz(rde)) {
    OpVexNarrow(A);
  } else {
    OpVexWiden(A);
  }
}

// vcvtdq2pd, vcvttpd2dq and vcvtpd2dq
static void OpVexE6(P) {
  if (Rep(rde) == 3) {
    OpVexWiden(A);
  } else {
    OpVexNarrow(A);
  }
}

// vldmxcsr and vstmxcsr
static void OpVexAe(P) {
  if (Ymm(rde) || Vreg(rde) || IsModrmRegister(rde) ||
      (ModrmReg(rde) != 2 && ModrmReg(rde) != 3)) {
    OpUdImpl(m);
  }
  GetOp(Legacy(Mopcode(rde)))(A);
}

static int VexPrefix(u64 rde) {
  return Osz(rde) ? 1 : Rep(rde) == 3 ? 2 : Rep(rde) == 2 ? 3 : 0;
}

// vzeroupper and vzeroall
static void OpVzero(P) {
  int i;
  if (Vreg(rde)) OpUdImpl(m);
  if (Ymm(rde)) memset(m->xmm, 0, sizeof(m->xmm));
  for (i = 0; i < 16; ++i) memset(m->ymmh[i], 0, 16);
}

// vmovd and vmovq between a vector register and the rest of the machine
static void OpVex7e(P) {
  OpVexAs(A, GetOp(Legacy(Mopcode(rde))),
          Rep(rde) ? kVexL0 : kVexL0 | kVexNodest);
}

// The handlers written here rather than borrowed whole from the legacy ones,
// and the prefixes each takes.
static nexgen32e_f VexCustom(long op, int *pp) {
  switch (op) {
    case kVex1 << 8 | 0x77:
      *pp = kPpNone;
      return OpVzero;
    case kVex1 << 8 | 0x7E:
      *pp = kPp66 | kPpF3;
      return OpVex7e;
    case kVex1 << 8 | 0x50:
      *pp = kPpNone | kPp66;
      return OpVexMask;
    case kVex1 << 8 | 0xD7:
      *pp = kPp66;
      return OpVexMask;
    case kVex1 << 8 | 0x71:
    case kVex1 << 8 | 0x72:
    case kVex1 << 8 | 0x73:
      *pp = kPp66;
      return OpVexShiftImm;
    case kVex1 << 8 | 0x5A:
      *pp = kPpAny;
      return OpVex5a;
    case kVex1 << 8 | 0xE6:
      *pp = kPp66 | kPpF3 | kPpF2;
      return OpVexE6;
    case kVex1 << 8 | 0xAE:
      *pp = kPpNone;
      return OpVexAe;
    default:
      return 0;
  }
}

// The instructions that are undefined with VEX.W set; the rest ignore it or
// take it as an operand size.
static bool VexW0(long op) {
  switch (op) {
    case kVex2 << 8 | 0x0C:
    case kVex2 << 8 | 0x0D:
    case kVex2 << 8 | 0x0E:
    case kVex2 << 8 | 0x0F:
    case kVex2 << 8 | 0x13:
    case kVex2 << 8 | 0x16:
    case kVex2 << 8 | 0x18:
    case kVex2 << 8 | 0x19:
    case kVex2 << 8 | 0x1A:
    case kVex2 << 8 | 0x2C:
    case kVex2 << 8 | 0x2D:
    case kVex2 << 8 | 0x2E:
    case kVex2 << 8 | 0x2F:
    case kVex2 << 8 | 0x36:
    case kVex2 << 8 | 0x46:
    case kVex2 << 8 | 0x58:
    case kVex2 << 8 | 0x59:
    case kVex2 << 8 | 0x5A:
    case kVex2 << 8 | 0x78:
    case kVex2 << 8 | 0x79:
    case kVex3 << 8 | 0x02:
    case kVex3 << 8 | 0x04:
    case kVex3 << 8 | 0x05:
    case kVex3 << 8 | 0x06:
    case kVex3 << 8 | 0x18:
    case kVex3 << 8 | 0x19:
    case kVex3 << 8 | 0x1D:
    case kVex3 << 8 | 0x38:
    case kVex3 << 8 | 0x39:
    case kVex3 << 8 | 0x46:
    case kVex3 << 8 | 0x4A:
    case kVex3 << 8 | 0x4B:
    case kVex3 << 8 | 0x4C:
      return true;
    default:
      return false;
  }
}

// Every VEX instruction goes through here so that the prefix is checked once.
static void OpVexTop(P) {
  long op = Mopcode(rde);
  int pp = VexPrefix(rde), allowed;
  u32 attr;
  nexgen32e_f handler;
  u8 mask;
  if (Rexw(rde) && VexW0(op)) OpUdImpl(m);
  if ((handler = GetVexNativeOp(op, &mask))) {
    if (!((mask >> pp) & 1)) OpUdImpl(m);
    handler(A);
  } else if ((handler = VexCustom(op, &allowed))) {
    if (!((allowed >> pp) & 1)) OpUdImpl(m);
    handler(A);
  } else {
    attr = VexAttr(op);
    if (!(((attr >> 16) >> pp) & 1)) OpUdImpl(m);
    OpVexAs(A, GetOp(Legacy(op)), attr);
  }
}

nexgen32e_f GetVexOp(long op) {
  int allowed;
  u8 mask;
  if (GetVexNativeOp(op, &mask) || VexCustom(op, &allowed) ||
      ((op >> 8) <= kVex3 && VexAttr(op))) {
    return OpVexTop;
  }
  return OpUd;
}
