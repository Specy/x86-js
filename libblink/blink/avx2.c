#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "blink/bus.h"
#include "blink/endian.h"
#include "blink/flags.h"
#include "blink/fpu.h"
#include "blink/machine.h"
#include "blink/modrm.h"
#include "blink/rde.h"
#include "blink/x86.h"

/*
 * VEX instructions that have no legacy SSE handler to borrow: the AVX and AVX2
 * additions, and the SSE4 instructions that Blink does not run without VEX.
 *
 * Every handler reads all of its operands into local buffers before it writes
 * anything, so an instruction that faults on a memory operand has changed
 * nothing. A vector is a buffer of one or two 128-bit lanes; lane 1 is the
 * upper half kept in m->ymmh.
 */

#define kVex1 (XED_ILD_MAP1 | XED_VEX_MAP)
#define kVex2 (XED_ILD_MAP2 | XED_VEX_MAP)
#define kVex3 (XED_ILD_MAP3 | XED_VEX_MAP)

#define kUseV 1  // vvvv is a source operand
#define kOnly128 2  // there is no 256-bit form
#define kOnly256 4  // there is no 128-bit form
#define kLig 8  // VEX.L is ignored

typedef void VexLane(u8 out[16], const u8 a[16], const u8 b[16], u64 imm,
                     int lane);

static u8 *VexReg(struct Machine *m, int i, int lane) {
  return lane ? m->ymmh[i] : m->xmm[i];
}

static void LoadVec(struct Machine *m, int i, u8 *buf, int lanes) {
  int lane;
  for (lane = 0; lane < lanes; ++lane) {
    memcpy(buf + 16 * lane, VexReg(m, i, lane), 16);
  }
}

static void StoreVec(struct Machine *m, int i, const u8 *buf, int lanes) {
  memcpy(m->xmm[i], buf, 16);
  if (lanes == 2) {
    memcpy(m->ymmh[i], buf + 16, 16);
  } else {
    memset(m->ymmh[i], 0, 16);
  }
}

// Reads `n` bytes of the r/m operand for each lane. Bytes past n are zero.
static void LoadRm(P, u8 *buf, int lanes, size_t n) {
  int lane;
  memset(buf, 0, 16 * lanes);
  for (lane = 0; lane < lanes; ++lane) {
    if (IsModrmRegister(rde)) {
      memcpy(buf + 16 * lane, VexReg(m, RexbRm(rde), lane), n);
    } else {
      memcpy(buf + 16 * lane,
             ReserveAddress(m, ComputeAddress(m, rde, disp + 16 * lane, uimm0),
                            n, false),
             n);
      if (m->stashaddr) CommitStash(m);
    }
  }
}

static void StoreRm(P, const u8 *buf, size_t n) {
  if (IsModrmRegister(rde)) {
    memcpy(m->xmm[RexbRm(rde)], buf, n);
  } else {
    memcpy(ReserveAddress(m, ComputeAddress(A), n, true), buf, n);
    if (m->stashaddr) CommitStash(m);
  }
}

static int Lanes(P, int flags) {
  int lanes = Ymm(rde) && !(flags & kLig) ? 2 : 1;
  if (lanes == 2 && (flags & kOnly128)) OpUdImpl(m);
  if (lanes == 1 && (flags & kOnly256) && !(flags & kLig)) OpUdImpl(m);
  if (!(flags & kUseV) && Vreg(rde)) OpUdImpl(m);
  return lanes;
}

// vop dst, [src1,] src2/mem[, imm]: the result starts as src1, or zero, and
// the lane function overwrites what the instruction defines.
static void OpLanes(P, VexLane *fn, int flags, size_t n) {
  u8 a[32], b[32], out[32];
  int lanes, lane;
  lanes = Lanes(A, flags);
  memset(a, 0, 32);
  if (flags & kUseV) LoadVec(m, Vreg(rde), a, lanes);
  LoadRm(A, b, lanes, n);
  memcpy(out, a, 32);
  for (lane = 0; lane < lanes; ++lane) {
    fn(out + 16 * lane, a + 16 * lane, b + 16 * lane, uimm0, lane);
  }
  StoreVec(m, RexrReg(rde), out, lanes);
}

#define LANE(name) \
  static void name(u8 out[16], const u8 a[16], const u8 b[16], u64 imm, int lane)
#define UNUSED (void)out, (void)a, (void)b, (void)imm, (void)lane

static float F32(const u8 *p) {
  union {
    u32 i;
    float f;
  } u;
  u.i = Read32(p);
  return u.f;
}

static void PutF32(u8 *p, float f) {
  union {
    u32 i;
    float f;
  } u;
  u.f = f;
  Write32(p, u.i);
}

static double F64(const u8 *p) {
  union {
    u64 i;
    double f;
  } u;
  u.i = Read64(p);
  return u.f;
}

static void PutF64(u8 *p, double f) {
  union {
    u64 i;
    double f;
  } u;
  u.f = f;
  Write64(p, u.i);
}

////////////////////////////////////////////////////////////////////////////////
// integer arithmetic from SSE4

#define MINMAX(name, T, bytes, cmp)                                         \
  LANE(name) {                                                              \
    int i;                                                                  \
    UNUSED;                                                                 \
    for (i = 0; i < 16; i += bytes) {                                       \
      T x, y;                                                               \
      memcpy(&x, a + i, bytes);                                             \
      memcpy(&y, b + i, bytes);                                             \
      x = (x cmp y) ? x : y;                                                \
      memcpy(out + i, &x, bytes);                                           \
    }                                                                       \
  }
MINMAX(Pminsb, i8, 1, <)
MINMAX(Pminsd, i32, 4, <)
MINMAX(Pminuw, u16, 2, <)
MINMAX(Pminud, u32, 4, <)
MINMAX(Pmaxsb, i8, 1, >)
MINMAX(Pmaxsd, i32, 4, >)
MINMAX(Pmaxuw, u16, 2, >)
MINMAX(Pmaxud, u32, 4, >)

LANE(Pmuldq) {
  int i;
  UNUSED;
  for (i = 0; i < 2; ++i) {
    Write64(out + i * 8, (u64)((i64)(i32)Read32(a + i * 8) *
                               (i64)(i32)Read32(b + i * 8)));
  }
}

LANE(Pcmpeqq) {
  int i;
  UNUSED;
  for (i = 0; i < 2; ++i) {
    Write64(out + i * 8, Read64(a + i * 8) == Read64(b + i * 8) ? -1 : 0);
  }
}

LANE(Pcmpgtq) {
  int i;
  UNUSED;
  for (i = 0; i < 2; ++i) {
    Write64(out + i * 8,
            (i64)Read64(a + i * 8) > (i64)Read64(b + i * 8) ? -1 : 0);
  }
}

static u16 SaturateU16(i32 x) {
  return x < 0 ? 0 : x > 65535 ? 65535 : x;
}

LANE(Packusdw) {
  int i;
  UNUSED;
  for (i = 0; i < 4; ++i) {
    Write16(out + i * 2, SaturateU16((i32)Read32(a + i * 4)));
    Write16(out + 8 + i * 2, SaturateU16((i32)Read32(b + i * 4)));
  }
}

LANE(Mpsadbw) {
  int i, j, x, y, sum;
  u8 t[16];
  UNUSED;
  x = ((imm >> (3 * lane + 2)) & 1) * 4;
  y = ((imm >> (3 * lane)) & 3) * 4;
  for (j = 0; j < 8; ++j) {
    sum = 0;
    for (i = 0; i < 4; ++i) {
      sum += abs((int)a[x + j + i] - (int)b[y + i]);
    }
    Write16(t + j * 2, sum);
  }
  memcpy(out, t, 16);
}

LANE(Phminposuw) {
  int i, best = 0;
  UNUSED;
  for (i = 1; i < 8; ++i) {
    if (Read16(b + i * 2) < Read16(b + best * 2)) best = i;
  }
  memset(out, 0, 16);
  Write16(out, Read16(b + best * 2));
  Write16(out + 2, best);
}

// vpsllvd, vpsrlvd, vpsravd, vpsllvq and vpsrlvq
static u64 ShiftVariable(int op, int bits, u64 x, u64 count) {
  if (count >= (u64)bits) {
    if (op == 2) return (bits == 32 ? (i64)(i32)x : (i64)x) < 0 ? -1 : 0;
    return 0;
  }
  switch (op) {
    case 0:
      return x << count;
    case 1:
      return x >> count;
    default:
      return bits == 32 ? (u32)((i32)x >> count) : (u64)((i64)x >> count);
  }
}

static void OpShiftVariable(P) {
  u8 a[32], b[32], out[32];
  int lanes, i, op, bits;
  lanes = Lanes(A, kUseV);
  op = Opcode(rde) == 0x47 ? 0 : Opcode(rde) == 0x45 ? 1 : 2;
  bits = Rexw(rde) ? 64 : 32;
  LoadVec(m, Vreg(rde), a, lanes);
  LoadRm(A, b, lanes, 16);
  for (i = 0; i < 16 * lanes; i += bits / 8) {
    if (bits == 32) {
      Write32(out + i, ShiftVariable(op, 32, Read32(a + i), Read32(b + i)));
    } else {
      Write64(out + i, ShiftVariable(op, 64, Read64(a + i), Read64(b + i)));
    }
  }
  StoreVec(m, RexrReg(rde), out, lanes);
}

////////////////////////////////////////////////////////////////////////////////
// floating point

static double RoundBy(struct Machine *m, double x, unsigned mode) {
  if (mode & 4) mode = (m->mxcsr & kMxcsrRc) >> 13;
  switch (mode & 3) {
    case 0:
      return rint(x);
    case 1:
      return floor(x);
    case 2:
      return ceil(x);
    default:
      return trunc(x);
  }
}

static float QuietF32(float x) {
  u32 bits;
  memcpy(&bits, &x, 4);
  if ((bits & 0x7fffffff) > 0x7f800000) bits |= 0x00400000;
  memcpy(&x, &bits, 4);
  return x;
}

static double QuietF64(double x) {
  u64 bits;
  memcpy(&bits, &x, 8);
  if ((bits & 0x7fffffffffffffff) > 0x7ff0000000000000) {
    bits |= 0x0008000000000000;
  }
  memcpy(&x, &bits, 8);
  return x;
}

static void OpRound(P) {
  u8 a[32], b[32], out[32];
  int lanes, i;
  bool scalar, dbl;
  dbl = Opcode(rde) & 1;
  scalar = Opcode(rde) >= 0x0A;
  lanes = Lanes(A, scalar ? kUseV | kLig : 0);
  memset(a, 0, 32);
  if (scalar) LoadVec(m, Vreg(rde), a, lanes);
  LoadRm(A, b, lanes, scalar ? (dbl ? 8 : 4) : 16);
  memcpy(out, a, 32);
  for (i = 0; i < (scalar ? 1 : 4 * lanes / (dbl ? 2 : 1)); ++i) {
    if (dbl) {
      PutF64(out + i * 8, QuietF64(RoundBy(m, F64(b + i * 8), uimm0)));
    } else {
      PutF32(out + i * 4,
             QuietF32((float)RoundBy(m, F32(b + i * 4), uimm0)));
    }
  }
  StoreVec(m, RexrReg(rde), out, lanes);
}

// The sixteen distinct comparisons of vcmpps and its relatives. The upper
// sixteen differ only in whether a quiet NaN signals.
static bool Compare(unsigned predicate, bool lt, bool eq, bool gt, bool un) {
  switch (predicate & 15) {
    case 0:
      return eq;
    case 1:
      return lt;
    case 2:
      return lt || eq;
    case 3:
      return un;
    case 4:
      return !eq;
    case 5:
      return !lt;
    case 6:
      return !(lt || eq);
    case 7:
      return !un;
    case 8:
      return eq || un;
    case 9:
      return lt || un;
    case 10:
      return !gt;
    case 11:
      return false;
    case 12:
      return !eq && !un;
    case 13:
      return gt || eq;
    case 14:
      return gt;
    default:
      return true;
  }
}

static void OpCmp(P) {
  u8 a[32], b[32], out[32];
  int lanes, i, n;
  bool scalar, dbl;
  scalar = Rep(rde) != 0;
  dbl = scalar ? Rep(rde) == 2 : Osz(rde);
  lanes = Lanes(A, kUseV | (scalar ? kLig : 0));
  LoadVec(m, Vreg(rde), a, lanes);
  LoadRm(A, b, lanes, scalar ? (dbl ? 8 : 4) : 16);
  memcpy(out, a, 32);
  n = scalar ? 1 : (lanes * 16) / (dbl ? 8 : 4);
  for (i = 0; i < n; ++i) {
    bool lt, eq, gt, un, r;
    if (dbl) {
      double x = F64(a + i * 8), y = F64(b + i * 8);
      un = isnan(x) || isnan(y);
      lt = x < y;
      eq = x == y;
      gt = x > y;
      r = Compare(uimm0, lt, eq, gt, un);
      Write64(out + i * 8, r ? -1 : 0);
    } else {
      float x = F32(a + i * 4), y = F32(b + i * 4);
      un = isnan(x) || isnan(y);
      lt = x < y;
      eq = x == y;
      gt = x > y;
      r = Compare(uimm0, lt, eq, gt, un);
      Write32(out + i * 4, r ? -1 : 0);
    }
  }
  StoreVec(m, RexrReg(rde), out, lanes);
}

LANE(Dpps) {
  float p[4], sum;
  int i;
  UNUSED;
  for (i = 0; i < 4; ++i) {
    p[i] = (imm >> (4 + i)) & 1 ? F32(a + i * 4) * F32(b + i * 4) : 0;
  }
  sum = (p[0] + p[1]) + (p[2] + p[3]);
  for (i = 0; i < 4; ++i) PutF32(out + i * 4, (imm >> i) & 1 ? sum : 0);
}

LANE(Dppd) {
  double p[2], sum;
  int i;
  UNUSED;
  for (i = 0; i < 2; ++i) {
    p[i] = (imm >> (4 + i)) & 1 ? F64(a + i * 8) * F64(b + i * 8) : 0;
  }
  sum = p[0] + p[1];
  for (i = 0; i < 2; ++i) PutF64(out + i * 8, (imm >> i) & 1 ? sum : 0);
}

LANE(Permilps) {
  int i;
  u8 t[16];
  UNUSED;
  for (i = 0; i < 4; ++i) {
    memcpy(t + i * 4, a + (Read32(b + i * 4) & 3) * 4, 4);
  }
  memcpy(out, t, 16);
}

LANE(Permilpd) {
  int i;
  u8 t[16];
  UNUSED;
  for (i = 0; i < 2; ++i) {
    memcpy(t + i * 8, a + ((Read64(b + i * 8) >> 1) & 1) * 8, 8);
  }
  memcpy(out, t, 16);
}

// vpermilps and vpermilpd with an immediate: the source is r/m, not vvvv
LANE(PermilpsImm) {
  int i;
  u8 t[16];
  UNUSED;
  for (i = 0; i < 4; ++i) memcpy(t + i * 4, b + ((imm >> (2 * i)) & 3) * 4, 4);
  memcpy(out, t, 16);
}

LANE(PermilpdImm) {
  int i;
  u8 t[16];
  UNUSED;
  for (i = 0; i < 2; ++i) {
    memcpy(t + i * 8, b + ((imm >> (2 * lane + i)) & 1) * 8, 8);
  }
  memcpy(out, t, 16);
}

LANE(Blendps) {
  int i;
  UNUSED;
  for (i = 0; i < 4; ++i) {
    if ((imm >> (4 * lane + i)) & 1) memcpy(out + i * 4, b + i * 4, 4);
  }
}

LANE(Blendpd) {
  int i;
  UNUSED;
  for (i = 0; i < 2; ++i) {
    if ((imm >> (2 * lane + i)) & 1) memcpy(out + i * 8, b + i * 8, 8);
  }
}

LANE(Pblendw) {
  int i;
  UNUSED;
  for (i = 0; i < 8; ++i) {
    if ((imm >> i) & 1) memcpy(out + i * 2, b + i * 2, 2);
  }
}

// the blend selects by the sign of each element of the register imm8[7:4]
static void OpBlendv(P) {
  u8 a[32], b[32], mask[32], out[32];
  int lanes, i, size;
  lanes = Lanes(A, kUseV);
  size = Opcode(rde) == 0x4C ? 1 : Opcode(rde) == 0x4A ? 4 : 8;
  LoadVec(m, Vreg(rde), a, lanes);
  LoadRm(A, b, lanes, 16);
  LoadVec(m, (uimm0 >> 4) & 15, mask, lanes);
  for (i = 0; i < 16 * lanes; i += size) {
    memcpy(out + i, (mask[i + size - 1] & 0x80) ? b + i : a + i, size);
  }
  StoreVec(m, RexrReg(rde), out, lanes);
}

// vpblendd: one bit of the immediate for each doubleword of the whole vector
static void OpPblendd(P) {
  u8 a[32], b[32], out[32];
  int lanes, i;
  lanes = Lanes(A, kUseV);
  LoadVec(m, Vreg(rde), a, lanes);
  LoadRm(A, b, lanes, 16);
  for (i = 0; i < 4 * lanes; ++i) {
    memcpy(out + i * 4, ((uimm0 >> i) & 1) ? b + i * 4 : a + i * 4, 4);
  }
  StoreVec(m, RexrReg(rde), out, lanes);
}

////////////////////////////////////////////////////////////////////////////////
// half precision

static float HalfToFloat(u16 h) {
  u32 sign = (u32)(h & 0x8000) << 16, exp = (h >> 10) & 31, man = h & 1023, bits;
  if (exp == 31) {
    bits = sign | 0x7f800000 | (man << 13) | (man ? 0x00400000 : 0);
  } else if (exp) {
    bits = sign | (exp + 112) << 23 | man << 13;
  } else if (man) {
    exp = 113;
    while (!(man & 1024)) {
      man <<= 1;
      --exp;
    }
    bits = sign | exp << 23 | (man & 1023) << 13;
  } else {
    bits = sign;
  }
  union {
    u32 i;
    float f;
  } u;
  u.i = bits;
  return u.f;
}

static u16 FloatToHalf(float x, unsigned mode) {
  union {
    u32 i;
    float f;
  } u;
  u64 sig, rem, half;
  u32 f, sign, exp, man;
  int e, shift;
  u32 q, h;
  u.f = x;
  f = u.i;
  sign = (f >> 16) & 0x8000;
  exp = (f >> 23) & 255;
  man = f & 0x7fffff;
  if (exp == 255) {
    return man ? sign | 0x7e00 | (man >> 13) : sign | 0x7c00;
  }
  if (!exp && !man) return sign;
  sig = exp ? man | 0x800000 : man;
  e = (exp ? (int)exp : 1) - 127;
  shift = e >= -14 ? 13 : 13 + (-14 - e);
  if (shift > 40) shift = 40;
  q = sig >> shift;
  rem = sig & (((u64)1 << shift) - 1);
  half = (u64)1 << (shift - 1);
  if (rem) {
    switch (mode & 3) {
      case 0:
        if (rem > half || (rem == half && (q & 1))) ++q;
        break;
      case 1:
        if (sign) ++q;
        break;
      case 2:
        if (!sign) ++q;
        break;
      default:
        break;
    }
  }
  h = e >= -14 ? ((u32)(e + 14) << 10) + q : q;
  if (h >= 0x7c00) {
    if ((mode & 3) == 3 || ((mode & 3) == 1 && !sign) ||
        ((mode & 3) == 2 && sign)) {
      if (e >= 16 || h > 0x7c00) return sign | 0x7bff;
    }
    return sign | 0x7c00;
  }
  return sign | h;
}

static void OpCvtph2ps(P) {
  u8 b[32], out[32];
  int lanes, i;
  lanes = Lanes(A, 0);
  LoadRm(A, b, 1, 8 * lanes);
  for (i = 0; i < 4 * lanes; ++i) PutF32(out + i * 4, HalfToFloat(Read16(b + i * 2)));
  StoreVec(m, RexrReg(rde), out, lanes);
}

static void OpCvtps2ph(P) {
  u8 src[32], out[16];
  int lanes, i;
  unsigned mode;
  lanes = Lanes(A, 0);
  LoadVec(m, RexrReg(rde), src, lanes);
  mode = uimm0 & 4 ? (m->mxcsr & kMxcsrRc) >> 13 : uimm0 & 3;
  memset(out, 0, 16);
  for (i = 0; i < 4 * lanes; ++i) Write16(out + i * 2, FloatToHalf(F32(src + i * 4), mode));
  if (IsModrmRegister(rde)) {
    memcpy(m->xmm[RexbRm(rde)], out, 16);
    memset(m->ymmh[RexbRm(rde)], 0, 16);
  } else {
    StoreRm(A, out, 8 * lanes);
  }
}

////////////////////////////////////////////////////////////////////////////////
// widening moves, broadcasts, and moving whole lanes

// vpmovsx* and vpmovzx*: half, quarter or an eighth of a vector, extended
static void OpPmovx(P) {
  u8 b[32], out[32];
  int lanes, i, ssize, dsize, count;
  bool sign;
  static const u8 kSource[6] = {1, 1, 1, 2, 2, 4};
  static const u8 kDest[6] = {2, 4, 8, 4, 8, 8};
  sign = Opcode(rde) < 0x30;
  i = (Opcode(rde) & 15) - 0;
  if (i > 5) OpUdImpl(m);
  ssize = kSource[i];
  dsize = kDest[i];
  lanes = Lanes(A, 0);
  count = 16 * lanes / dsize;
  LoadRm(A, b, 1, count * ssize);
  for (i = 0; i < count; ++i) {
    u64 x = ssize == 1 ? b[i] : ssize == 2 ? Read16(b + i * 2) : Read32(b + i * 4);
    if (sign) {
      x = ssize == 1 ? (u64)(i64)(i8)x : ssize == 2 ? (u64)(i64)(i16)x : (u64)(i64)(i32)x;
    }
    if (dsize == 2) Write16(out + i * 2, x);
    else if (dsize == 4) Write32(out + i * 4, x);
    else Write64(out + i * 8, x);
  }
  StoreVec(m, RexrReg(rde), out, lanes);
}

// vbroadcastss, vbroadcastsd, vbroadcastf128, vpbroadcast[bwdq] and vbroadcasti128
static void OpBroadcast(P) {
  u8 b[16], out[32];
  int lanes, i, size;
  lanes = Lanes(A, 0);
  switch (Mopcode(rde) & 255) {
    case 0x18:
    case 0x58:
      size = 4;
      break;
    case 0x19:
    case 0x59:
      size = 8;
      if (lanes == 1 && Opcode(rde) == 0x19) OpUdImpl(m);
      break;
    case 0x78:
      size = 1;
      break;
    case 0x79:
      size = 2;
      break;
    default:  // 0x1a and 0x5a: a whole lane, from memory
      if (lanes == 1 || IsModrmRegister(rde)) OpUdImpl(m);
      size = 16;
      break;
  }
  LoadRm(A, b, 1, size);
  for (i = 0; i < 16 * lanes; i += size) memcpy(out + i, b, size);
  StoreVec(m, RexrReg(rde), out, lanes);
}

// vinsertf128 and vinserti128
static void OpInsert128(P) {
  u8 a[32], b[32], out[32];
  int lanes;
  lanes = Lanes(A, kUseV | kOnly256);
  LoadVec(m, Vreg(rde), a, lanes);
  LoadRm(A, b, 1, 16);
  memcpy(out, a, 32);
  memcpy(out + 16 * (uimm0 & 1), b, 16);
  StoreVec(m, RexrReg(rde), out, 2);
}

// vextractf128 and vextracti128
static void OpExtract128(P) {
  u8 src[32];
  int lanes;
  lanes = Lanes(A, kOnly256);
  LoadVec(m, RexrReg(rde), src, lanes);
  if (IsModrmRegister(rde)) {
    memcpy(m->xmm[RexbRm(rde)], src + 16 * (uimm0 & 1), 16);
    memset(m->ymmh[RexbRm(rde)], 0, 16);
  } else {
    StoreRm(A, src + 16 * (uimm0 & 1), 16);
  }
}

// vperm2f128 and vperm2i128
static void OpPerm2x128(P) {
  u8 a[32], b[32], out[32];
  int lanes, lane;
  lanes = Lanes(A, kUseV | kOnly256);
  LoadVec(m, Vreg(rde), a, lanes);
  LoadRm(A, b, 2, 16);
  for (lane = 0; lane < 2; ++lane) {
    unsigned sel = (uimm0 >> (4 * lane)) & 15;
    if (sel & 8) {
      memset(out + 16 * lane, 0, 16);
    } else {
      memcpy(out + 16 * lane, ((sel & 2) ? b : a) + 16 * (sel & 1), 16);
    }
  }
  StoreVec(m, RexrReg(rde), out, 2);
}

// vpermq and vpermpd with an immediate
static void OpPermq(P) {
  u8 b[32], out[32];
  int i, lanes;
  lanes = Lanes(A, kOnly256);
  if (!Rexw(rde)) OpUdImpl(m);
  LoadRm(A, b, lanes, 16);
  for (i = 0; i < 4; ++i) memcpy(out + i * 8, b + ((uimm0 >> (2 * i)) & 3) * 8, 8);
  StoreVec(m, RexrReg(rde), out, 2);
}

// vpermd and vpermps: indices in vvvv, data in r/m
static void OpPermd(P) {
  u8 idx[32], b[32], out[32];
  int i, lanes;
  lanes = Lanes(A, kUseV | kOnly256);
  LoadVec(m, Vreg(rde), idx, lanes);
  LoadRm(A, b, 2, 16);
  for (i = 0; i < 8; ++i) memcpy(out + i * 4, b + (Read32(idx + i * 4) & 7) * 4, 4);
  StoreVec(m, RexrReg(rde), out, 2);
}

////////////////////////////////////////////////////////////////////////////////
// element moves between vectors and the rest of the machine

static u64 GprOrMemory(P, size_t n) {
  u8 buf[8];
  if (IsModrmRegister(rde)) return Read64(m->weg[RexbRm(rde)]) & (n == 8 ? -1ull : ((1ull << (8 * n)) - 1));
  memcpy(buf, ReserveAddress(m, ComputeAddress(A), n, false), n);
  if (m->stashaddr) CommitStash(m);
  return n == 1 ? buf[0] : n == 2 ? Read16(buf) : n == 4 ? Read32(buf) : Read64(buf);
}

// vpinsrb, vpinsrd and vpinsrq
static void OpPinsr(P) {
  u8 out[16];
  size_t n;
  u64 x;
  int i;
  if (Ymm(rde)) OpUdImpl(m);
  n = Opcode(rde) == 0x20 ? 1 : Rexw(rde) ? 8 : 4;
  x = GprOrMemory(A, n);
  memcpy(out, m->xmm[Vreg(rde)], 16);
  i = uimm0 & (16 / n - 1);
  if (n == 1) out[i] = x;
  else if (n == 4) Write32(out + i * 4, x);
  else Write64(out + i * 8, x);
  StoreVec(m, RexrReg(rde), out, 1);
}

// vpextrb, vpextrw, vpextrd, vpextrq and vextractps
static void OpPextr(P) {
  u8 buf[8];
  u8 *src = m->xmm[RexrReg(rde)];
  size_t n;
  u64 x;
  int i;
  if (Ymm(rde) || Vreg(rde)) OpUdImpl(m);
  switch (Opcode(rde)) {
    case 0x14:
      n = 1;
      x = src[uimm0 & 15];
      break;
    case 0x15:
      n = 2;
      x = Read16(src + (uimm0 & 7) * 2);
      break;
    case 0x16:
      n = Rexw(rde) ? 8 : 4;
      x = n == 8 ? Read64(src + (uimm0 & 1) * 8) : Read32(src + (uimm0 & 3) * 4);
      break;
    default:
      n = 4;
      x = Read32(src + (uimm0 & 3) * 4);
      break;
  }
  if (IsModrmRegister(rde)) {
    Write64(m->weg[RexbRm(rde)], x);
  } else {
    for (i = 0; i < 8; ++i) buf[i] = x >> (8 * i);
    StoreRm(A, buf, n);
  }
}

static void OpInsertps(P) {
  u8 out[16], b[16];
  int count_s, count_d, i;
  if (Ymm(rde)) OpUdImpl(m);
  memcpy(out, m->xmm[Vreg(rde)], 16);
  if (IsModrmRegister(rde)) {
    memcpy(b, m->xmm[RexbRm(rde)], 16);
    count_s = (uimm0 >> 6) & 3;
  } else {
    LoadRm(A, b, 1, 4);
    count_s = 0;
  }
  count_d = (uimm0 >> 4) & 3;
  memcpy(out + count_d * 4, b + count_s * 4, 4);
  for (i = 0; i < 4; ++i) {
    if ((uimm0 >> i) & 1) memset(out + i * 4, 0, 4);
  }
  StoreVec(m, RexrReg(rde), out, 1);
}

////////////////////////////////////////////////////////////////////////////////
// tests and masked moves

static void SetTestFlags(struct Machine *m, bool zf, bool cf) {
  m->flags = SetFlag(m->flags, FLAGS_ZF, zf);
  m->flags = SetFlag(m->flags, FLAGS_CF, cf);
  m->flags = SetFlag(m->flags, FLAGS_PF, false);
  m->flags = SetFlag(m->flags, FLAGS_SF, false);
  m->flags = SetFlag(m->flags, FLAGS_OF, false);
  m->flags = SetFlag(m->flags, FLAGS_AF, false);
}

// vptest, vtestps and vtestpd
static void OpPtest(P) {
  u8 a[32], b[32];
  int lanes, i, bits;
  bool zf = true, cf = true;
  lanes = Lanes(A, 0);
  LoadVec(m, RexrReg(rde), a, lanes);
  LoadRm(A, b, lanes, 16);
  bits = Opcode(rde) == 0x17 ? 0 : Opcode(rde) == 0x0E ? 32 : 64;
  if (!bits) {
    for (i = 0; i < 16 * lanes; ++i) {
      if (a[i] & b[i]) zf = false;
      if (~a[i] & b[i]) cf = false;
    }
  } else {
    for (i = 0; i < 16 * lanes; i += bits / 8) {
      if ((a[i + bits / 8 - 1] & b[i + bits / 8 - 1]) & 0x80) zf = false;
      if ((~a[i + bits / 8 - 1] & b[i + bits / 8 - 1]) & 0x80) cf = false;
    }
  }
  SetTestFlags(m, zf, cf);
}

// vmaskmovps, vmaskmovpd, vpmaskmovd and vpmaskmovq. Only the elements the
// mask selects touch memory.
static void OpMaskmov(P) {
  u8 mask[32], vec[32], out[32];
  int lanes, i, size;
  bool store;
  u8 *p;
  lanes = Lanes(A, kUseV);
  if (IsModrmRegister(rde)) OpUdImpl(m);
  switch (Opcode(rde)) {
    case 0x2C:
    case 0x2E:
      size = 4;
      break;
    case 0x2D:
    case 0x2F:
      size = 8;
      break;
    default:
      size = Rexw(rde) ? 8 : 4;
      break;
  }
  store = Opcode(rde) == 0x2E || Opcode(rde) == 0x2F || Opcode(rde) == 0x8E;
  LoadVec(m, Vreg(rde), mask, lanes);
  memset(out, 0, 32);
  if (store) {
    LoadVec(m, RexrReg(rde), vec, lanes);
    // nothing is stored unless every selected element can be
    for (i = 0; i < 16 * lanes; i += size) {
      if (mask[i + size - 1] & 0x80) {
        ReserveAddress(m, ComputeAddress(m, rde, disp + i, uimm0), size, true);
        m->stashaddr = 0;
      }
    }
    for (i = 0; i < 16 * lanes; i += size) {
      if (mask[i + size - 1] & 0x80) {
        p = ReserveAddress(m, ComputeAddress(m, rde, disp + i, uimm0), size,
                           true);
        memcpy(p, vec + i, size);
        if (m->stashaddr) CommitStash(m);
      }
    }
  } else {
    for (i = 0; i < 16 * lanes; i += size) {
      if (mask[i + size - 1] & 0x80) {
        p = ReserveAddress(m, ComputeAddress(m, rde, disp + i, uimm0), size,
                           false);
        memcpy(out + i, p, size);
        if (m->stashaddr) CommitStash(m);
      }
    }
    StoreVec(m, RexrReg(rde), out, lanes);
  }
}

////////////////////////////////////////////////////////////////////////////////
// AES

static u8 kSbox[256], kInvSbox[256];
static bool g_aes_ready;

static u8 GfMul(u8 a, u8 b) {
  u8 r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = (a << 1) ^ ((a & 0x80) ? 0x1b : 0);
    b >>= 1;
  }
  return r;
}

// The S-box is the multiplicative inverse in GF(2^8), then an affine map.
static void InitAes(void) {
  int i, j;
  u8 inv, x, y;
  if (g_aes_ready) return;
  for (i = 0; i < 256; ++i) {
    inv = 0;
    if (i) {
      for (j = 1; j < 256; ++j) {
        if (GfMul(i, j) == 1) {
          inv = j;
          break;
        }
      }
    }
    x = inv;
    y = x ^ (x << 1 | x >> 7) ^ (x << 2 | x >> 6) ^ (x << 3 | x >> 5) ^
        (x << 4 | x >> 4) ^ 0x63;
    kSbox[i] = y;
    kInvSbox[y] = i;
  }
  g_aes_ready = true;
}

static void MixColumns(u8 out[16], const u8 in[16], bool inverse) {
  int c;
  for (c = 0; c < 4; ++c) {
    const u8 *col = in + 4 * c;
    if (inverse) {
      out[4 * c + 0] = GfMul(col[0], 14) ^ GfMul(col[1], 11) ^ GfMul(col[2], 13) ^ GfMul(col[3], 9);
      out[4 * c + 1] = GfMul(col[0], 9) ^ GfMul(col[1], 14) ^ GfMul(col[2], 11) ^ GfMul(col[3], 13);
      out[4 * c + 2] = GfMul(col[0], 13) ^ GfMul(col[1], 9) ^ GfMul(col[2], 14) ^ GfMul(col[3], 11);
      out[4 * c + 3] = GfMul(col[0], 11) ^ GfMul(col[1], 13) ^ GfMul(col[2], 9) ^ GfMul(col[3], 14);
    } else {
      out[4 * c + 0] = GfMul(col[0], 2) ^ GfMul(col[1], 3) ^ col[2] ^ col[3];
      out[4 * c + 1] = col[0] ^ GfMul(col[1], 2) ^ GfMul(col[2], 3) ^ col[3];
      out[4 * c + 2] = col[0] ^ col[1] ^ GfMul(col[2], 2) ^ GfMul(col[3], 3);
      out[4 * c + 3] = GfMul(col[0], 3) ^ col[1] ^ col[2] ^ GfMul(col[3], 2);
    }
  }
}

static void AesRound(u8 out[16], const u8 in[16], const u8 key[16], bool inverse,
                     bool last) {
  u8 t[16], u[16];
  int c, r, i;
  InitAes();
  for (c = 0; c < 4; ++c) {
    for (r = 0; r < 4; ++r) {
      if (inverse) {
        t[4 * ((c + r) & 3) + r] = kInvSbox[in[4 * c + r]];
      } else {
        t[4 * c + r] = kSbox[in[4 * ((c + r) & 3) + r]];
      }
    }
  }
  if (last) {
    memcpy(u, t, 16);
  } else {
    MixColumns(u, t, inverse);
  }
  for (i = 0; i < 16; ++i) out[i] = u[i] ^ key[i];
}

LANE(Aesenc) {
  UNUSED;
  AesRound(out, a, b, false, false);
}

LANE(Aesenclast) {
  UNUSED;
  AesRound(out, a, b, false, true);
}

LANE(Aesdec) {
  UNUSED;
  AesRound(out, a, b, true, false);
}

LANE(Aesdeclast) {
  UNUSED;
  AesRound(out, a, b, true, true);
}

LANE(Aesimc) {
  UNUSED;
  MixColumns(out, b, true);
}

LANE(Aeskeygenassist) {
  u8 x1[4], x3[4];
  int i;
  UNUSED;
  InitAes();
  for (i = 0; i < 4; ++i) {
    x1[i] = kSbox[b[4 + i]];
    x3[i] = kSbox[b[12 + i]];
  }
  memcpy(out, x1, 4);
  out[4] = x1[1] ^ (u8)imm;
  out[5] = x1[2];
  out[6] = x1[3];
  out[7] = x1[0];
  memcpy(out + 8, x3, 4);
  out[12] = x3[1] ^ (u8)imm;
  out[13] = x3[2];
  out[14] = x3[3];
  out[15] = x3[0];
}

////////////////////////////////////////////////////////////////////////////////
// string compares

static int StringElement(const u8 *p, int i, bool word, bool sign) {
  if (word) return sign ? (int)(i16)Read16(p + 2 * i) : (int)Read16(p + 2 * i);
  return sign ? (int)(i8)p[i] : (int)p[i];
}

// the implicit length of a string ends at its first zero element
static int ImplicitLength(const u8 *p, int n, bool word) {
  int i;
  for (i = 0; i < n; ++i) {
    if (!StringElement(p, i, word, false)) break;
  }
  return i;
}

static int ExplicitLength(i64 x, int n) {
  if (x < 0) x = -(x == INT64_MIN ? INT64_MAX : x);
  return x > n ? n : x;
}

// vpcmpestrm, vpcmpestri, vpcmpistrm and vpcmpistri
static void OpStringCompare(P) {
  u8 a[16], b[16], mask[16];
  int n, la, lb, i, j, k, aggregation, polarity, index;
  bool word, sign, invalid_a, invalid_b, bits[16][16], res1[16], res2[16];
  bool explicit_length = Opcode(rde) < 0x62;
  bool want_mask = !(Opcode(rde) & 1);
  u32 imm = uimm0, all, result = 0;
  if (Ymm(rde) || Vreg(rde)) OpUdImpl(m);
  word = imm & 1;
  sign = imm & 2;
  aggregation = (imm >> 2) & 3;
  polarity = (imm >> 4) & 3;
  n = word ? 8 : 16;
  LoadVec(m, RexrReg(rde), a, 1);
  LoadRm(A, b, 1, 16);
  if (explicit_length) {
    la = ExplicitLength(Rexw(rde) ? (i64)Read64(m->ax) : (i32)Read32(m->ax), n);
    lb = ExplicitLength(Rexw(rde) ? (i64)Read64(m->dx) : (i32)Read32(m->dx), n);
  } else {
    la = ImplicitLength(a, n, word);
    lb = ImplicitLength(b, n, word);
  }
  for (j = 0; j < n; ++j) {
    for (i = 0; i < n; ++i) {
      int x = StringElement(b, j, word, sign), y = StringElement(a, i, word, sign);
      invalid_a = i >= la;
      invalid_b = j >= lb;
      if (invalid_a && invalid_b) {
        bits[j][i] = aggregation >= 2;
      } else if (invalid_a) {
        bits[j][i] = aggregation == 3;
      } else if (invalid_b) {
        bits[j][i] = false;
      } else if (aggregation == 1) {
        bits[j][i] = (i & 1) ? x <= y : x >= y;
      } else {
        bits[j][i] = x == y;
      }
    }
  }
  for (j = 0; j < n; ++j) {
    res1[j] = aggregation == 3;
    switch (aggregation) {
      case 0:
        for (i = 0; i < n; ++i) res1[j] |= bits[j][i];
        break;
      case 1:
        for (i = 0; i < n; i += 2) res1[j] |= bits[j][i] && bits[j][i + 1];
        break;
      case 2:
        res1[j] = bits[j][j];
        break;
      default:
        for (k = 0; k < n - j; ++k) res1[j] &= bits[j + k][k];
        break;
    }
  }
  for (j = 0; j < n; ++j) {
    switch (polarity) {
      case 1:
        res2[j] = !res1[j];
        break;
      case 3:
        res2[j] = j < lb ? !res1[j] : res1[j];
        break;
      default:
        res2[j] = res1[j];
        break;
    }
    result |= (u32)res2[j] << j;
  }
  all = (1u << n) - 1;
  if (want_mask) {
    memset(mask, 0, 16);
    if (imm & 0x40) {
      for (j = 0; j < n; ++j) {
        if (word) Write16(mask + 2 * j, res2[j] ? 0xffff : 0);
        else mask[j] = res2[j] ? 0xff : 0;
      }
    } else {
      Write16(mask, result);
    }
    memcpy(m->xmm[0], mask, 16);
    memset(m->ymmh[0], 0, 16);
  } else {
    if (!result) {
      index = n;
    } else if (imm & 0x40) {
      for (index = n - 1; !((result >> index) & 1); --index) {
      }
    } else {
      for (index = 0; !((result >> index) & 1); ++index) {
      }
    }
    Put64(m->cx, (u32)index);
  }
  (void)all;
  m->flags = SetFlag(m->flags, FLAGS_CF, result != 0);
  m->flags = SetFlag(m->flags, FLAGS_ZF, lb < n);
  m->flags = SetFlag(m->flags, FLAGS_SF, la < n);
  m->flags = SetFlag(m->flags, FLAGS_OF, result & 1);
  m->flags = SetFlag(m->flags, FLAGS_AF, false);
  m->flags = SetFlag(m->flags, FLAGS_PF, false);
}

////////////////////////////////////////////////////////////////////////////////
// fused multiply-add

// vfmadd, vfmsub, vfnmadd, vfnmsub, vfmaddsub and vfmsubadd, in the 132, 213
// and 231 orders. The low nibble of the opcode picks the operation and the high
// nibble the order, after the operands are named dst, src2 (vvvv) and src3.
static void OpFma(P) {
  u8 dst[32], src2[32], src3[32], out[32];
  int lanes, i, n, order, kind, size;
  bool scalar, dbl;
  kind = Opcode(rde) & 15;
  order = (Opcode(rde) >> 4) - 9;
  scalar = kind >= 8 && (kind & 1);
  dbl = Rexw(rde);
  size = dbl ? 8 : 4;
  lanes = Lanes(A, kUseV | (scalar ? kLig : 0));
  LoadVec(m, RexrReg(rde), dst, lanes);
  LoadVec(m, Vreg(rde), src2, lanes);
  LoadRm(A, src3, lanes, scalar ? size : 16);
  memcpy(out, dst, 32);
  n = scalar ? 1 : 16 * lanes / size;
  for (i = 0; i < n; ++i) {
    double x, y, z, a, b, c, r;
    float xf, yf, zf, af, bf, cf, rf;
    bool negate_product, negate_addend;
    switch (kind) {
      case 6:  // vfmaddsub: subtract in the even elements
        negate_product = false;
        negate_addend = !(i & 1);
        break;
      case 7:  // vfmsubadd: add in the even elements
        negate_product = false;
        negate_addend = i & 1;
        break;
      case 8:
      case 9:
        negate_product = negate_addend = false;
        break;
      case 10:
      case 11:
        negate_product = false;
        negate_addend = true;
        break;
      case 12:
      case 13:
        negate_product = true;
        negate_addend = false;
        break;
      default:
        negate_product = negate_addend = true;
        break;
    }
    if (dbl) {
      x = F64(dst + i * 8);
      y = F64(src2 + i * 8);
      z = F64(src3 + i * 8);
      a = order == 0 ? x : y;
      b = order == 0 ? z : order == 1 ? x : z;
      c = order == 0 ? y : order == 1 ? z : x;
      if (isnan(a) || isnan(b) || isnan(c)) {
        PutF64(out + i * 8, QuietF64(isnan(a) ? a : isnan(b) ? b : c));
        continue;
      }
      r = fma(negate_product ? -a : a, b, negate_addend ? -c : c);
      if (isnan(r)) Write64(out + i * 8, 0xfff8000000000000);
      else PutF64(out + i * 8, r);
    } else {
      xf = F32(dst + i * 4);
      yf = F32(src2 + i * 4);
      zf = F32(src3 + i * 4);
      af = order == 0 ? xf : yf;
      bf = order == 0 ? zf : order == 1 ? xf : zf;
      cf = order == 0 ? yf : order == 1 ? zf : xf;
      if (isnan(af) || isnan(bf) || isnan(cf)) {
        PutF32(out + i * 4, QuietF32(isnan(af) ? af : isnan(bf) ? bf : cf));
        continue;
      }
      rf = fmaf(negate_product ? -af : af, bf, negate_addend ? -cf : cf);
      if (isnan(rf)) Write32(out + i * 4, 0xffc00000);
      else PutF32(out + i * 4, rf);
    }
  }
  StoreVec(m, RexrReg(rde), out, lanes);
}

////////////////////////////////////////////////////////////////////////////////
// gathers

// vpgatherdd and its relatives. The index is a vector register in the SIB
// byte, so the address is worked out here from the base alone.
static void OpGather(P) {
  u8 idx[32];
  u8 *dst, *mask, *p;
  int lanes, i, ne, esize, isize, d, k, x, ilanes, total, scale;
  i64 base, index;
  u64 base_rde;
  if (IsModrmRegister(rde) || ModrmRm(rde) != 4) OpUdImpl(m);
  lanes = Lanes(A, kUseV);
  esize = Rexw(rde) ? 8 : 4;
  isize = (Opcode(rde) & 1) ? 8 : 4;
  d = RexrReg(rde);
  k = Vreg(rde);
  x = Rexx(rde) << 3 | SibIndex(rde);
  if (d == k || d == x || k == x) OpUdImpl(m);
  ne = 16 * lanes / (esize > isize ? esize : isize);
  ilanes = ne * isize > 16 ? 2 : 1;
  total = ne * esize;
  scale = 1 << SibScale(rde);
  base_rde = (rde & ~(u64)(0x7ull << 35 | 1ull << 17)) | 4ull << 35;
  base = ComputeAddress(m, base_rde, disp, uimm0);
  LoadVec(m, x, idx, ilanes);
  for (i = 0; i < ne; ++i) {
    dst = VexReg(m, d, i * esize / 16) + (i * esize) % 16;
    mask = VexReg(m, k, i * esize / 16) + (i * esize) % 16;
    if (!(mask[esize - 1] & 0x80)) {
      memset(mask, 0, esize);
      continue;
    }
    index = isize == 8 ? (i64)Read64(idx + i * 8) : (i64)(i32)Read32(idx + i * 4);
    p = ReserveAddress(m, base + index * scale, esize, false);
    memcpy(dst, p, esize);
    if (m->stashaddr) CommitStash(m);
    memset(mask, 0, esize);
  }
  for (i = total; i < 32; ++i) {
    VexReg(m, d, i / 16)[i % 16] = 0;
    VexReg(m, k, i / 16)[i % 16] = 0;
  }
}

////////////////////////////////////////////////////////////////////////////////
// BMI1 and BMI2

static void BmiFlags(struct Machine *m, bool zf, bool sf, bool cf) {
  m->flags = SetFlag(m->flags, FLAGS_ZF, zf);
  m->flags = SetFlag(m->flags, FLAGS_SF, sf);
  m->flags = SetFlag(m->flags, FLAGS_CF, cf);
  m->flags = SetFlag(m->flags, FLAGS_OF, false);
}

static u64 BmiSource(P) {
  return Rexw(rde) ? (u64)Load64(GetModrmRegisterWordPointerRead8(A))
                   : (u64)Load32(GetModrmRegisterWordPointerRead4(A));
}

static void BmiResult(P, int reg, u64 x) {
  Put64(m->weg[reg], Rexw(rde) ? x : (u32)x);
}

static bool BmiSign(P, u64 x) {
  return Rexw(rde) ? (i64)x < 0 : (i32)x < 0;
}

// andn
static void OpAndn(P) {
  u64 x;
  if (Ymm(rde) || Rep(rde) || Osz(rde)) OpUdImpl(m);
  x = ~(Rexw(rde) ? Read64(m->weg[Vreg(rde)]) : Read32(m->weg[Vreg(rde)])) &
      BmiSource(A);
  if (!Rexw(rde)) x = (u32)x;
  BmiResult(A, RexrReg(rde), x);
  BmiFlags(m, !x, BmiSign(A, x), false);
}

// blsr, blsmsk and blsi: vvvv is the destination
static void OpBls(P) {
  u64 x, r;
  bool cf;
  if (Ymm(rde) || Rep(rde) || Osz(rde)) OpUdImpl(m);
  x = BmiSource(A);
  switch (ModrmReg(rde)) {
    case 1:
      r = x & (x - 1);
      cf = !x;
      break;
    case 2:
      r = x ^ (x - 1);
      cf = !x;
      break;
    case 3:
      r = x & -x;
      cf = x != 0;
      break;
    default:
      OpUdImpl(m);
      return;
  }
  if (!Rexw(rde)) r = (u32)r;
  BmiResult(A, Vreg(rde), r);
  BmiFlags(m, !r, BmiSign(A, r), cf);
}

static u64 Pdep(u64 x, u64 mask) {
  u64 r, b;
  for (r = 0, b = 1; mask; mask >>= 1, b <<= 1) {
    if (mask & 1) {
      if (x & 1) r |= b;
      x >>= 1;
    }
  }
  return r;
}

static u64 Pext(u64 x, u64 mask) {
  u64 r, b;
  for (r = 0, b = 1; mask; mask >>= 1, x >>= 1) {
    if (mask & 1) {
      if (x & 1) r |= b;
      b <<= 1;
    }
  }
  return r;
}

// bzhi, pdep and pext
static void OpBmi5(P) {
  u64 x, r;
  int n, bits;
  if (Ymm(rde)) OpUdImpl(m);
  bits = Rexw(rde) ? 64 : 32;
  x = BmiSource(A);
  if (Rep(rde) == 2 || Rep(rde) == 3) {
    u64 v = Rexw(rde) ? Read64(m->weg[Vreg(rde)]) : Read32(m->weg[Vreg(rde)]);
    r = Rep(rde) == 2 ? Pdep(v, x) : Pext(v, x);
    BmiResult(A, RexrReg(rde), r);
  } else if (!Osz(rde)) {
    n = m->weg[Vreg(rde)][0];
    r = x;
    if (n < bits) r &= ((u64)1 << n) - 1;
    if (!Rexw(rde)) r = (u32)r;
    BmiResult(A, RexrReg(rde), r);
    BmiFlags(m, !r, BmiSign(A, r), n >= bits);
  } else {
    OpUdImpl(m);
  }
}

// mulx: the high half goes to the register, the low half to vvvv
static void OpMulx(P) {
  u64 x, y, hi, lo;
  if (Ymm(rde) || Rep(rde) != 2) OpUdImpl(m);
  x = BmiSource(A);
  if (Rexw(rde)) {
    y = Read64(m->dx);
    lo = x * y;
    hi = (u64)(((__uint128_t)x * y) >> 64);
  } else {
    y = Read32(m->dx);
    lo = (u32)(x * y);
    hi = (x * y) >> 32;
  }
  BmiResult(A, Vreg(rde), lo);
  BmiResult(A, RexrReg(rde), hi);
}

// bextr, shlx, shrx and sarx
static void OpBmi7(P) {
  u64 x, r;
  int n, bits, start, len;
  if (Ymm(rde)) OpUdImpl(m);
  bits = Rexw(rde) ? 64 : 32;
  x = BmiSource(A);
  n = m->weg[Vreg(rde)][0];
  if (Rep(rde) == 0 && !Osz(rde)) {
    start = n;
    len = m->weg[Vreg(rde)][1];
    r = start >= bits ? 0 : x >> start;
    if (len < bits) r &= ((u64)1 << len) - 1;
    if (!Rexw(rde)) r = (u32)r;
    BmiResult(A, RexrReg(rde), r);
    m->flags = SetFlag(m->flags, FLAGS_ZF, !r);
    m->flags = SetFlag(m->flags, FLAGS_CF, false);
    m->flags = SetFlag(m->flags, FLAGS_OF, false);
    return;
  }
  n &= bits - 1;
  if (Osz(rde)) {
    r = x << n;
  } else if (Rep(rde) == 2) {
    r = x >> n;
  } else {
    r = Rexw(rde) ? (u64)((i64)x >> n) : (u64)(u32)((i32)x >> n);
  }
  BmiResult(A, RexrReg(rde), r);
}

// rorx
static void OpVexRorx(P) {
  u64 x;
  int n;
  if (Ymm(rde) || Vreg(rde) || Rep(rde) != 2) OpUdImpl(m);
  x = BmiSource(A);
  if (Rexw(rde)) {
    n = uimm0 & 63;
    if (n) x = x >> n | x << (64 - n);
  } else {
    n = uimm0 & 31;
    if (n) x = (u32)(x >> n | x << (32 - n));
  }
  BmiResult(A, RexrReg(rde), x);
}

////////////////////////////////////////////////////////////////////////////////

#define OP(name, fn, flags, n) \
  static void name(P) { OpLanes(A, fn, flags, n); }
OP(OpPminsb, Pminsb, kUseV, 16)
OP(OpPminsd, Pminsd, kUseV, 16)
OP(OpPminuw, Pminuw, kUseV, 16)
OP(OpPminud, Pminud, kUseV, 16)
OP(OpPmaxsb, Pmaxsb, kUseV, 16)
OP(OpPmaxsd, Pmaxsd, kUseV, 16)
OP(OpPmaxuw, Pmaxuw, kUseV, 16)
OP(OpPmaxud, Pmaxud, kUseV, 16)
OP(OpPmuldq, Pmuldq, kUseV, 16)
OP(OpPcmpeqq, Pcmpeqq, kUseV, 16)
OP(OpPcmpgtq, Pcmpgtq, kUseV, 16)
OP(OpPackusdw, Packusdw, kUseV, 16)
OP(OpMpsadbw, Mpsadbw, kUseV, 16)
OP(OpAesenc, Aesenc, kUseV | kOnly128, 16)
OP(OpAesenclast, Aesenclast, kUseV | kOnly128, 16)
OP(OpAesdec, Aesdec, kUseV | kOnly128, 16)
OP(OpAesdeclast, Aesdeclast, kUseV | kOnly128, 16)
OP(OpAesimc, Aesimc, kOnly128, 16)
OP(OpAeskeygenassist, Aeskeygenassist, kOnly128, 16)
OP(OpPhminposuw, Phminposuw, kOnly128, 16)
OP(OpDpps, Dpps, kUseV, 16)
OP(OpDppd, Dppd, kUseV | kOnly128, 16)
OP(OpPermilps, Permilps, kUseV, 16)
OP(OpPermilpd, Permilpd, kUseV, 16)
OP(OpPermilpsImm, PermilpsImm, 0, 16)
OP(OpPermilpdImm, PermilpdImm, 0, 16)
OP(OpBlendps, Blendps, kUseV, 16)
OP(OpBlendpd, Blendpd, kUseV, 16)
OP(OpPblendw, Pblendw, kUseV, 16)

static nexgen32e_f NativeOp(long op) {
  if ((op >> 8) == kVex2) {
    int low = op & 15, high = (op >> 4) & 15;
    if ((high == 9 || high == 10 || high == 11) && low >= 6) return OpFma;
  }
  switch (op) {
    case kVex1 << 8 | 0xC2:
      return OpCmp;
    case kVex2 << 8 | 0x0C:
      return OpPermilps;
    case kVex2 << 8 | 0x0D:
      return OpPermilpd;
    case kVex2 << 8 | 0x0E:
    case kVex2 << 8 | 0x0F:
    case kVex2 << 8 | 0x17:
      return OpPtest;
    case kVex2 << 8 | 0x13:
      return OpCvtph2ps;
    case kVex2 << 8 | 0x16:
      return OpPermd;
    case kVex2 << 8 | 0x36:
      return OpPermd;
    case kVex2 << 8 | 0x18:
    case kVex2 << 8 | 0x19:
    case kVex2 << 8 | 0x1A:
    case kVex2 << 8 | 0x58:
    case kVex2 << 8 | 0x59:
    case kVex2 << 8 | 0x5A:
    case kVex2 << 8 | 0x78:
    case kVex2 << 8 | 0x79:
      return OpBroadcast;
    case kVex2 << 8 | 0x20:
    case kVex2 << 8 | 0x21:
    case kVex2 << 8 | 0x22:
    case kVex2 << 8 | 0x23:
    case kVex2 << 8 | 0x24:
    case kVex2 << 8 | 0x25:
    case kVex2 << 8 | 0x30:
    case kVex2 << 8 | 0x31:
    case kVex2 << 8 | 0x32:
    case kVex2 << 8 | 0x33:
    case kVex2 << 8 | 0x34:
    case kVex2 << 8 | 0x35:
      return OpPmovx;
    case kVex2 << 8 | 0x28:
      return OpPmuldq;
    case kVex2 << 8 | 0x29:
      return OpPcmpeqq;
    case kVex2 << 8 | 0x2B:
      return OpPackusdw;
    case kVex2 << 8 | 0x2C:
    case kVex2 << 8 | 0x2D:
    case kVex2 << 8 | 0x2E:
    case kVex2 << 8 | 0x2F:
    case kVex2 << 8 | 0x8C:
    case kVex2 << 8 | 0x8E:
      return OpMaskmov;
    case kVex2 << 8 | 0x37:
      return OpPcmpgtq;
    case kVex2 << 8 | 0x38:
      return OpPminsb;
    case kVex2 << 8 | 0x39:
      return OpPminsd;
    case kVex2 << 8 | 0x3A:
      return OpPminuw;
    case kVex2 << 8 | 0x3B:
      return OpPminud;
    case kVex2 << 8 | 0x3C:
      return OpPmaxsb;
    case kVex2 << 8 | 0x3D:
      return OpPmaxsd;
    case kVex2 << 8 | 0x3E:
      return OpPmaxuw;
    case kVex2 << 8 | 0x3F:
      return OpPmaxud;
    case kVex2 << 8 | 0x41:
      return OpPhminposuw;
    case kVex2 << 8 | 0xDB:
      return OpAesimc;
    case kVex2 << 8 | 0xDC:
      return OpAesenc;
    case kVex2 << 8 | 0xDD:
      return OpAesenclast;
    case kVex2 << 8 | 0xDE:
      return OpAesdec;
    case kVex2 << 8 | 0xDF:
      return OpAesdeclast;
    case kVex3 << 8 | 0xDF:
      return OpAeskeygenassist;
    case kVex2 << 8 | 0x45:
    case kVex2 << 8 | 0x46:
    case kVex2 << 8 | 0x47:
      return OpShiftVariable;
    case kVex2 << 8 | 0x90:
    case kVex2 << 8 | 0x91:
    case kVex2 << 8 | 0x92:
    case kVex2 << 8 | 0x93:
      return OpGather;
    case kVex2 << 8 | 0xF2:
      return OpAndn;
    case kVex2 << 8 | 0xF3:
      return OpBls;
    case kVex2 << 8 | 0xF5:
      return OpBmi5;
    case kVex2 << 8 | 0xF6:
      return OpMulx;
    case kVex2 << 8 | 0xF7:
      return OpBmi7;
    case kVex3 << 8 | 0xF0:
      return OpVexRorx;
    case kVex3 << 8 | 0x00:
    case kVex3 << 8 | 0x01:
      return OpPermq;
    case kVex3 << 8 | 0x02:
      return OpPblendd;
    case kVex3 << 8 | 0x04:
      return OpPermilpsImm;
    case kVex3 << 8 | 0x05:
      return OpPermilpdImm;
    case kVex3 << 8 | 0x06:
    case kVex3 << 8 | 0x46:
      return OpPerm2x128;
    case kVex3 << 8 | 0x08:
    case kVex3 << 8 | 0x09:
    case kVex3 << 8 | 0x0A:
    case kVex3 << 8 | 0x0B:
      return OpRound;
    case kVex3 << 8 | 0x0C:
      return OpBlendps;
    case kVex3 << 8 | 0x0D:
      return OpBlendpd;
    case kVex3 << 8 | 0x0E:
      return OpPblendw;
    case kVex3 << 8 | 0x14:
    case kVex3 << 8 | 0x15:
    case kVex3 << 8 | 0x16:
    case kVex3 << 8 | 0x17:
      return OpPextr;
    case kVex3 << 8 | 0x18:
    case kVex3 << 8 | 0x38:
      return OpInsert128;
    case kVex3 << 8 | 0x19:
    case kVex3 << 8 | 0x39:
      return OpExtract128;
    case kVex3 << 8 | 0x1D:
      return OpCvtps2ph;
    case kVex3 << 8 | 0x20:
    case kVex3 << 8 | 0x22:
      return OpPinsr;
    case kVex3 << 8 | 0x21:
      return OpInsertps;
    case kVex3 << 8 | 0x60:
    case kVex3 << 8 | 0x61:
    case kVex3 << 8 | 0x62:
    case kVex3 << 8 | 0x63:
      return OpStringCompare;
    case kVex3 << 8 | 0x40:
      return OpDpps;
    case kVex3 << 8 | 0x41:
      return OpDppd;
    case kVex3 << 8 | 0x42:
      return OpMpsadbw;
    case kVex3 << 8 | 0x4A:
    case kVex3 << 8 | 0x4B:
    case kVex3 << 8 | 0x4C:
      return OpBlendv;
    default:
      return 0;
  }
}

// The prefixes a native instruction takes: 66 unless it is one of these.
nexgen32e_f GetVexNativeOp(long op, u8 *pp) {
  nexgen32e_f handler = NativeOp(op);
  *pp = 2;
  switch (op) {
    case kVex1 << 8 | 0xC2:
      *pp = 15;
      break;
    case kVex2 << 8 | 0xF2:
    case kVex2 << 8 | 0xF3:
      *pp = 1;
      break;
    case kVex2 << 8 | 0xF5:
      *pp = 1 | 4 | 8;
      break;
    case kVex2 << 8 | 0xF6:
    case kVex3 << 8 | 0xF0:
      *pp = 8;
      break;
    case kVex2 << 8 | 0xF7:
      *pp = 15;
      break;
    default:
      break;
  }
  return handler;
}
