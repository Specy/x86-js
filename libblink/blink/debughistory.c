/* Debugger history stays in wasm. An entry keeps the registers its step left
 * as they are, one block copied whole, and what else the step changed (FPU
 * blocks, memory images, journal) in the order its packet lists it. The
 * packet itself is built only when JavaScript asks for one, with the changed
 * registers found then: comparing and writing them on every step took most of
 * the time a recorded step took. Slots retain their allocation when the ring
 * wraps, unless it is far larger than the new entry needs.
 * Packet v3: 96-byte LE header, changed GPR old/new pairs, optional two packed
 * FPU blocks, 24-byte memory descriptors and their old/new byte images, then
 * the journal: records of what the instruction did outside the CPU and memory
 * that Undo takes back, each a kind, a size and that many bytes (see
 * debughistory.h for the kinds). See native-history.ts for the matching
 * reader.
 *
 * An instruction keeps at most 64 KiB of the bytes it replaced in the
 * machine's own journal. A rep string instruction that would write more stops
 * between iterations when that journal is full (see string.c), and its parts
 * are gathered here, so that the instruction is still one entry, one row and
 * one instruction in the count, and Undo restores every part.
 *
 * The ring holds up to `capacity` entries, and the packets of its newest at
 * most `budget` bytes between them: a step's packet carries the bytes it
 * replaced and as many it left, so a loop of large string stores would
 * otherwise fill the wasm heap long before a 200,000-entry ring is full. Over
 * budget, the oldest entries are hollowed: cut down to their header and marked
 * irreversible, so undo stops at them as at any write it couldn't capture. They
 * stay in the ring, which drops the oldest only when full, so its depth still
 * grows by one entry a step until then. An entry's registers count against
 * the budget too until it is hollowed, and stay with it after, as where the
 * next entry starts from. */
#include "blink/debughistory.h"
#include "blink/blinkenlib.h"
#include "blink/endian.h"
#include "blink/machine.h"
#include "blink/devices.h"
#include "blink/evdev.h"
#include "blink/fbdev.h"
#include "blink/rde.h"
#include "blink/sound.h"
#include "blink/terminal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern struct Machine *m;
extern u64 memory_stack_top;

struct Frame {
  struct Frame *previous;
  u32 references, depth;
  u64 target, destination, sp;
};
/* The CPU state a step changes, as Blink keeps it: the register file in
 * encoding order, RIP, the program counter and Blink's flags word with its
 * lazy parity byte, which blinkenlib_architectural_flags() turns into the
 * architectural word when a packet is built. */
struct Registers {
  u8 weg[16][8];
  u64 ip, pc;
  u32 flags, zero; /* `zero` fills what would be padding */
};
_Static_assert(sizeof(struct Registers) == 152, "struct Registers has no padding");
/* A step's entry. The registers it started from are the previous entry's
 * `after`, or `base` for the oldest, unless something changed them between
 * the two steps (a signal handler entered, the host set one outside a Poke):
 * then the entry keeps its own `before`. */
struct Entry {
  struct Registers after;
  struct Registers *before;
  u8 *tail; /* the packet after its registers */
  u32 tail_bytes, allocated;
  struct Frame *stack_before;
  u64 identity, instructions_before, stack_top_before;
  u32 flow, size, depth, write_count, journal_count, journal_bytes;
  bool poke, reversible, fpu_changed, exited, hollow;
};
/* What a step or Poke starts from, beside the registers, which it takes
 * only when they aren't where the newest entry left them (`moved`), or for
 * a Poke, always. */
struct Snapshot {
  struct Registers registers;
  bool moved;
  u64 pc;
  u64 instructions;
  u64 stack_top;
  u32 flow, size;
  bool has_fpu; /* whether `fpu` was taken */
  u8 fpu[BLINKENLIB_FPU_STATE_SIZE];
};
struct PokeByte { u64 address; u32 sequence; u8 old; };
#define HISTORY_BUDGET (256u << 20)
#define HEADER 96
/* The most of the bytes it replaced one instruction keeps, its parts
 * together: a write beyond it is counted and makes the step irreversible. */
#define SPLIT_BUDGET (16u << 20)
static struct Entry *entries;
static u32 capacity, slots, count, start;
static u32 hollow; /* the oldest `hollow` entries are hollow */
static u32 budget = HISTORY_BUDGET;
static u64 held; /* bytes the others keep: their registers and tails */
/* The registers the oldest entry started from, unless it keeps its own. */
static struct Registers base;
/* What blinkenlib_history_entry() and blinkenlib_history_header() hand out,
 * each until its next call. */
static u8 *packet;
static u32 packet_allocated;
static u8 header[HEADER];
static u64 serial;
static struct Snapshot before;
/* The FPU state a step that took it before left. */
static u8 after_fpu[BLINKENLIB_FPU_STATE_SIZE];
static bool pending, poke, pending_irreversible;
static struct Frame *stack;
static struct PokeByte *poke_bytes;
static u32 poke_count, poke_allocated;
/* The journal of the step being recorded, its records one after another. */
static u8 *journal;
static u32 journal_used, journal_allocated, journal_count;
/* The writes of the parts a rep string instruction already finished. */
static struct MachineWriteRecord *split_writes;
static u32 split_count, split_allocated;
static u8 *split_bytes;
static u32 split_used, split_bytes_allocated;
static bool split_truncated;

static struct Frame *Retain(struct Frame *f) {
  if (f) ++f->references;
  return f;
}
static void Release(struct Frame *f) {
  while (f && !--f->references) {
    struct Frame *previous = f->previous;
    free(f);
    f = previous;
  }
}
/* Where Blink's register file, in encoding order, keeps each register by its
 * blinkenlib id, RAX to R15. */
static const u8 kRegisterFile[16] = {0, 3, 1, 2, 4, 5, 6, 7,
                                     8, 9, 10, 11, 12, 13, 14, 15};
_Static_assert(offsetof(struct Machine, bx) == offsetof(struct Machine, weg[3]),
               "kRegisterFile follows the register file");
_Static_assert(offsetof(struct Machine, cx) == offsetof(struct Machine, weg[1]),
               "kRegisterFile follows the register file");
_Static_assert(offsetof(struct Machine, dx) == offsetof(struct Machine, weg[2]),
               "kRegisterFile follows the register file");
_Static_assert(offsetof(struct Machine, r15) == offsetof(struct Machine, weg[15]),
               "kRegisterFile follows the register file");
/* Whether an instruction can change the x87, SSE or AVX state. Copying and
 * comparing that state's 612 bytes before and after every instruction took
 * most of the time a recorded step took, so a step leaves it out for the
 * instructions that cannot. Those are every one-byte opcode but the x87
 * escapes, FWAIT, the VEX and EVEX prefixes and the interrupts, and the
 * integer opcodes of the two-byte map listed here. Everything in the 0F38 and
 * 0F3A maps and everything VEX-encoded (dispatched under maps of its own)
 * can. So can SYSCALL, whose rt_sigreturn restores the state from the signal
 * frame. Build with -DDEBUGHISTORY_CHECK_FPU to take the state on every
 * step anyway and abort on an instruction this calls wrong. */
static bool MayChangeFpuState(u64 rde) {
  u32 opcode = Mopcode(rde);
  if (opcode < 0x100) {
    return (opcode >= 0xD8 && opcode <= 0xDF) || opcode == 0x9B ||
           opcode == 0xC4 || opcode == 0xC5 || opcode == 0x62 ||
           (opcode >= 0xCC && opcode <= 0xCF);
  }
  if (opcode >= 0x200) return true;
  if ((opcode >= 0x140 && opcode <= 0x14F) ||  // CMOVcc
      (opcode >= 0x180 && opcode <= 0x19F) ||  // Jcc, SETcc
      (opcode >= 0x1C8 && opcode <= 0x1CF))    // BSWAP
    return false;
  switch (opcode) {
    case 0x118: case 0x119: case 0x11A: case 0x11B:  // hint NOPs, prefetches
    case 0x11C: case 0x11D: case 0x11E: case 0x11F:  // ENDBR64, NOP
    case 0x131:  // RDTSC
    case 0x1A2:  // CPUID
    case 0x1A3: case 0x1AB: case 0x1B3: case 0x1BA: case 0x1BB:  // BT*
    case 0x1A4: case 0x1A5: case 0x1AC: case 0x1AD:  // SHLD, SHRD
    case 0x1AF:  // IMUL
    case 0x1B0: case 0x1B1:  // CMPXCHG
    case 0x1B6: case 0x1B7: case 0x1BE: case 0x1BF:  // MOVZX, MOVSX
    case 0x1B8:  // POPCNT
    case 0x1BC: case 0x1BD:  // BSF, BSR, TZCNT, LZCNT
    case 0x1C0: case 0x1C1:  // XADD
    case 0x1C3:  // MOVNTI
      return false;
    default:
      return true;
  }
}
/* The copies and comparisons a step makes are written out a word at a time:
 * a memcpy() of a block this small costs a call to V8's bulk memory
 * operation, and a memcmp() a call to the C library's loop, each more than
 * the words themselves. no_builtin keeps the compiler from making them calls
 * again. */
#define WORDWISE __attribute__((no_builtin("memcpy", "memcmp", "bcmp")))
WORDWISE static void TakeRegisters(struct Registers *to) {
  for (int i = 0; i < 16; ++i) Write64(to->weg[i], Read64(m->weg[i]));
  to->ip = m->ip;
  to->pc = GetPc(m);
  to->flags = m->flags;
  to->zero = 0;
}
/* Whether the machine's registers are those. */
WORDWISE static bool HasRegisters(const struct Registers *r) {
  for (int i = 0; i < 16; ++i)
    if (Read64(m->weg[i]) != Read64(r->weg[i])) return false;
  return m->ip == r->ip && m->flags == r->flags && GetPc(m) == r->pc;
}
WORDWISE static void CopyRegisters(struct Registers *to, const struct Registers *from) {
  for (int i = 0; i < 16; ++i) Write64(to->weg[i], Read64(from->weg[i]));
  to->ip = from->ip;
  to->pc = from->pc;
  to->flags = from->flags;
  to->zero = 0;
}
WORDWISE static bool SameFpu(const u8 *a, const u8 *b) {
  u32 i;
  for (i = 0; i + 8 <= BLINKENLIB_FPU_STATE_SIZE; i += 8)
    if (Read64(a + i) != Read64(b + i)) return false;
  for (; i < BLINKENLIB_FPU_STATE_SIZE; ++i)
    if (a[i] != b[i]) return false;
  return true;
}
static struct Entry *EntryAt(u32 offset);
/* Takes what a step or Poke starts from into `before`. */
static void TakeBefore(bool fpu) {
  before.moved = !HasRegisters(count ? &EntryAt(0)->after : &base);
  if (before.moved) TakeRegisters(&before.registers);
  before.pc = GetPc(m);
  before.instructions = blinkenlib_instructions_executed();
  before.has_fpu = fpu;
#ifdef DEBUGHISTORY_CHECK_FPU
  fpu = true;
#endif
  if (fpu) blinkenlib_get_fpu_state(before.fpu);
}
/* A register by its blinkenlib id: RAX to R15, then RIP. */
static u64 RegisterValue(const struct Registers *r, int id) {
  return id < 16 ? Read64(r->weg[kRegisterFile[id]]) : r->ip;
}
/* Which registers, by blinkenlib id, differ between two states. */
static u32 ChangedRegisters(const struct Registers *a, const struct Registers *b) {
  u32 mask = 0;
  for (int i = 0; i < 17; ++i)
    if (RegisterValue(a, i) != RegisterValue(b, i)) mask |= 1u << i;
  return mask;
}
static void ForgetStep(void) {
  journal_used = journal_count = 0;
  split_count = split_used = 0;
  split_truncated = false;
}
void DebugHistoryCancel(void) {
  pending = poke = false;
  pending_irreversible = false;
  poke_count = 0;
  ForgetStep();
}
/* B5 can replace this boundary with a journal for signal process state.
 * Until then the signal frame, mask and pending queue cannot be undone. */
void DebugHistoryMarkIrreversible(void) {
  if (pending) {
    pending_irreversible = true;
  } else if (count && capacity) {
    entries[(start + count - 1) % slots].reversible = false;
  }
}
/* The JavaScript filesystem backend completes a capability callback while the guest syscall is
 * still active. It marks the same packet as native descriptor and process-state effects do. */
EMSCRIPTEN_KEEPALIVE
void blinkenlib_history_mark_irreversible(void) {
  DebugHistoryMarkIrreversible();
}
bool DebugHistoryPending(void) { return pending; }
/* Records what the instruction being recorded did beyond the CPU and memory,
 * for Undo to take back. With no instruction recording (a Poke opened over a
 * read that waited, say), the effect cannot be journaled, and the newest
 * entry becomes a barrier instead. */
void DebugHistoryJournal(u32 kind, const void *data, u32 size) {
  u32 want;
  u8 *grown;
  if (!pending || poke) {
    DebugHistoryMarkIrreversible();
    return;
  }
  if (8 + size > journal_allocated - journal_used) {
    want = journal_used + 8 + size;
    want = want > journal_allocated * 2 ? want : journal_allocated * 2;
    if (!(grown = realloc(journal, want))) abort();
    journal = grown;
    journal_allocated = want;
  }
  Write32(journal + journal_used, kind);
  Write32(journal + journal_used + 4, size);
  memcpy(journal + journal_used + 8, data, size);
  journal_used += 8 + size;
  ++journal_count;
}
/* Each owner's kinds stay in its range (debughistory.h), so UndoJournal()
 * hands every record to the file that wrote it. */
#define JOURNAL_KIND_IN(kind, first, last) \
  _Static_assert((kind) >= (first) && (kind) <= (last), #kind " out of range")
JOURNAL_KIND_IN(JOURNAL_TERMINAL_READ, 1, 15);
JOURNAL_KIND_IN(JOURNAL_TERMINAL_FLUSH, 1, 15);
JOURNAL_KIND_IN(JOURNAL_TERMINAL_MODE, 1, 15);
JOURNAL_KIND_IN(JOURNAL_EVDEV_READ, 16, 31);
JOURNAL_KIND_IN(JOURNAL_EVDEV_FLUSH, 16, 31);
JOURNAL_KIND_IN(JOURNAL_EVDEV_CLOCK, 16, 31);
JOURNAL_KIND_IN(JOURNAL_EVDEV_INJECT, 16, 31);
JOURNAL_KIND_IN(JOURNAL_EVDEV_GRAB, 16, 31);
JOURNAL_KIND_IN(JOURNAL_EVDEV_MASK, 16, 31);
JOURNAL_KIND_IN(JOURNAL_EVDEV_ABS, 16, 31);
JOURNAL_KIND_IN(JOURNAL_FRAMEBUFFER_STATE, 32, 35);
JOURNAL_KIND_IN(JOURNAL_FRAMEBUFFER_POSITION, 32, 35);
JOURNAL_KIND_IN(JOURNAL_FRAMEBUFFER_BYTES, 32, 35);
JOURNAL_KIND_IN(JOURNAL_DSP_PASS, 36, 47);
JOURNAL_KIND_IN(JOURNAL_DSP_STATUS, 36, 47);
JOURNAL_KIND_IN(JOURNAL_MIXER_LEVELS, 36, 47);
JOURNAL_KIND_IN(JOURNAL_MIDI_WRITE, 48, 55);
JOURNAL_KIND_IN(JOURNAL_MIDI_PARAMS, 48, 55);
JOURNAL_KIND_IN(JOURNAL_MIDI_PVERSION, 48, 55);
JOURNAL_KIND_IN(JOURNAL_TONE, 56, 59);
JOURNAL_KIND_IN(JOURNAL_CONSOLE_TERMIOS, 56, 59);
JOURNAL_KIND_IN(JOURNAL_CONSOLE_MODES, 56, 59);

/* Takes back what a journal record says, by its kind, by the file that owns
 * the kind. */
static void UndoJournal(u32 kind, const u8 *data, u32 size) {
  if (kind < 16) UndoTerminalJournal(kind, data, size);
  else if (kind < 32) UndoEvdevJournal(kind, data, size);
  else if (kind < 36) UndoFramebufferJournal(kind, data, size);
  else if (kind < 64) UndoSoundJournal(kind, data, size);
}
static void AppendSplitWrite(const struct MachineWriteRecord *w, const u8 *old) {
  void *grown;
  struct MachineWriteRecord *last;
  u32 oldsize;
  bool truncated;
  /* Past the budget the step cannot be undone, so nothing it kept is any use:
   * every record is only counted from then on, as a truncated one is. */
  if (!split_truncated && split_used + w->oldsize > SPLIT_BUDGET) {
    for (u32 i = 0; i < split_count; ++i) {
      split_writes[i].oldsize = 0;
      split_writes[i].truncated = true;
    }
    split_used = 0;
    split_truncated = true;
  }
  last = split_count ? &split_writes[split_count - 1] : 0;
  oldsize = w->truncated || split_truncated ? 0 : w->oldsize;
  truncated = oldsize < w->size;
  /* A part that goes on where the last ended extends it, its old bytes
   * following the last's, as ExtendWriteRecord() extends a record. */
  if (last && last->addr + last->size == w->addr && last->truncated == truncated &&
      w->size <= 0xffffffffu - last->size &&
      (truncated || last->oldoffset + last->oldsize == split_used)) {
    last->size += w->size;
    if (!truncated) {
      memcpy(split_bytes + split_used, old, oldsize);
      last->oldsize += oldsize;
      split_used += oldsize;
    }
    return;
  }
  if (split_count == split_allocated) {
    split_allocated = split_allocated ? split_allocated * 2 : 16;
    if (!(grown = realloc(split_writes, split_allocated * sizeof(*split_writes)))) abort();
    split_writes = grown;
  }
  split_writes[split_count++] = (struct MachineWriteRecord){
      .addr = w->addr, .size = w->size, .oldoffset = split_used,
      .oldsize = oldsize, .truncated = truncated};
  if (oldsize) {
    memcpy(split_bytes + split_used, old, oldsize);
    split_used += oldsize;
  }
}
/* Moves the writes the machine journaled for one part of a rep string
 * instruction into the step, which goes on recording the next part. */
static void GatherWrites(void) {
  u8 *grown;
  u32 i, want;
  u64 bytes = 0;
  for (i = 0; i < m->writeoldcount; ++i) bytes += m->writeold[i].oldsize;
  if (bytes > split_bytes_allocated - split_used) {
    want = split_used + bytes;
    want = want > split_bytes_allocated * 2 ? want : split_bytes_allocated * 2;
    if (!(grown = realloc(split_bytes, want))) abort();
    split_bytes = grown;
    split_bytes_allocated = want;
  }
  for (i = 0; i < m->writeoldcount; ++i)
    AppendSplitWrite(&m->writeold[i], m->writeoldbytes + m->writeold[i].oldoffset);
  split_truncated |= m->writeoldtruncated;
}
void DebugHistorySplit(void) {
  if (pending && !poke && m) GatherWrites();
}
/* Leaves a slot as one no entry occupies: no tail, no frames. */
static void Empty(struct Entry *e) {
  Release(e->stack_before);
  e->stack_before = 0;
  free(e->tail);
  e->tail = 0;
  e->allocated = 0;
  free(e->before);
  e->before = 0;
}
void DebugHistoryClear(void) {
  for (u32 i = 0; i < slots; ++i) Empty(&entries[i]);
  free(journal);
  journal = 0;
  journal_allocated = 0;
  free(split_writes);
  split_writes = 0;
  split_allocated = 0;
  free(split_bytes);
  split_bytes = 0;
  split_bytes_allocated = 0;
  free(entries);
  entries = 0;
  slots = 0;
  free(packet);
  packet = 0;
  packet_allocated = 0;
  held = 0;
  hollow = 0;
  Release(stack);
  stack = 0;
  count = start = 0;
  DebugHistoryCancel();
}
EMSCRIPTEN_KEEPALIVE
// 2: the FPU blocks grew from 356 to 612 bytes with the ymm upper halves
// 3: a 96-byte header and the journal after the memory images
u32 blinkenlib_history_version(void) { return 3; }
EMSCRIPTEN_KEEPALIVE
void blinkenlib_history_capacity(u32 size) {
  DebugHistoryClear();
  capacity = size;
}
EMSCRIPTEN_KEEPALIVE
void blinkenlib_history_clear(void) { DebugHistoryClear(); }
/* For tests; @specy/x86 doesn't call it. Sets the budget the entries that
 * aren't hollow share, their registers and the rest of their packets (see
 * `held`), from the next entry on (0 leaves it as it is), and returns the bytes
 * they hold now. */
EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_history_budget(u32 bytes) {
  if (bytes) budget = bytes;
  return held;
}
EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_history_count(void) { return count; }
/* How many entries the history has recorded since the module loaded: one per
 * instruction and one per Poke that changed something, including those since
 * undone, hollowed or pushed out of a full ring. Nothing is recorded while the
 * capacity is 0, so it doesn't move then. Instruction identity is separate. */
EMSCRIPTEN_KEEPALIVE
u64 blinkenlib_history_recorded(void) { return serial; }
static struct Entry *EntryAt(u32 offset) {
  return offset < count ? &entries[(start + count - 1 - offset) % slots] : 0;
}
/* The registers the entry `offset` back from the newest started from. */
static const struct Registers *Before(u32 offset) {
  struct Entry *e = EntryAt(offset);
  if (e->before) return e->before;
  return offset + 1 < count ? &EntryAt(offset + 1)->after : &base;
}
/* What a hollow entry's packet leaves out: it lists no change. */
static u32 PacketMask(u32 offset) {
  struct Entry *e = EntryAt(offset);
  return e->hollow ? 0 : ChangedRegisters(Before(offset), &e->after);
}
static u32 PacketBytes(struct Entry *e, u32 mask) {
  return HEADER + 16 * __builtin_popcount(mask) + (e->hollow ? 0 : e->tail_bytes);
}
static void WriteHeader(u8 *p, u32 offset, u32 mask) {
  struct Entry *e = EntryAt(offset);
  const struct Registers *b = Before(offset);
  memset(p, 0, HEADER);
  Write32(p, blinkenlib_history_version());
  Write32(p + 4, PacketBytes(e, mask));
  Write64(p + 8, e->identity);
  Write32(p + 16, e->poke);
  Write32(p + 20, e->reversible && !e->hollow);
  Write64(p + 24, b->pc);
  Write64(p + 32, e->after.pc);
  Write32(p + 40, blinkenlib_architectural_flags(b->flags));
  Write32(p + 44, blinkenlib_architectural_flags(e->after.flags));
  Write32(p + 48, e->flow);
  Write32(p + 52, e->size);
  Write32(p + 56, mask);
  Write32(p + 68, e->depth);
  Write64(p + 72, RegisterValue(&e->after, BLINKENLIB_REG_RSP));
  Write64(p + 80, b->pc + e->size);
  if (e->hollow) return;
  Write32(p + 60, e->write_count);
  Write32(p + 64, e->fpu_changed);
  Write32(p + 88, e->journal_count);
  Write32(p + 92, e->journal_bytes);
}
/* The packet of the entry `offset` back from the newest, built in a buffer
 * that the next call reuses. */
EMSCRIPTEN_KEEPALIVE
const u8 *blinkenlib_history_entry(u32 offset) {
  struct Entry *e = EntryAt(offset);
  u32 mask, bytes;
  u8 *p;
  if (!e) return 0;
  mask = PacketMask(offset);
  bytes = PacketBytes(e, mask);
  /* The buffer grows by doubling, and gives a large one back once the
   * packets asked for are much smaller again: a rep string instruction's can
   * be megabytes long. */
  if (bytes > packet_allocated ||
      (packet_allocated > (1u << 20) && bytes <= packet_allocated / 4)) {
    free(packet);
    packet_allocated = bytes <= packet_allocated ? bytes
                       : bytes > 2 * packet_allocated ? bytes
                                                      : 2 * packet_allocated;
    if (!(packet = malloc(packet_allocated))) abort();
  }
  WriteHeader(packet, offset, mask);
  p = packet + HEADER;
  for (int i = 0; i < 17; ++i) if (mask & (1u << i)) {
    Write64(p, RegisterValue(Before(offset), i));
    Write64(p + 8, RegisterValue(&e->after, i));
    p += 16;
  }
  if (!e->hollow) memcpy(p, e->tail, e->tail_bytes);
  return packet;
}
/* Only the header of that packet, which is all that most questions about an
 * entry need, without copying its memory images: a rep string instruction's
 * can be megabytes long. Its buffer is not blinkenlib_history_entry()'s. */
EMSCRIPTEN_KEEPALIVE
const u8 *blinkenlib_history_header(u32 offset) {
  if (offset >= count) return 0;
  WriteHeader(header, offset, PacketMask(offset));
  return header;
}
void DebugHistoryBegin(u32 flow, u32 size) {
  if (!capacity || pending || poke || !m) return;
  TakeBefore(MayChangeFpuState(m->xedd->op.rde));
  before.stack_top = memory_stack_top;
  before.flow = flow;
  before.size = size;
  pending_irreversible = false;
  pending = true;
  ForgetStep();
}
/* Read a guest range page by page, avoiding a page-table walk per byte. */
static bool CopyGuest(u8 *out, u64 address, u32 size) {
  while (size) {
    u32 n = 4096 - (address & 4095);
    if (n > size) n = size;
    u8 *p = blinkenlib_spy_address(address);
    if (!p) return false;
    memcpy(out, p, n);
    out += n;
    address += n;
    size -= n;
  }
  return true;
}
/* What an entry that isn't hollow counts against the budget beside its tail:
 * its registers. */
#define REGISTERS_CHARGE sizeof(struct Registers)
/* Gives an entry a tail buffer of a new size, none for 0. Finish() writes the
 * tail whole, so nothing is copied, and the old buffer is freed whole rather
 * than cut down by realloc(): a large tail's small head left live in place
 * would split its memory, and the next large tail would grow the heap instead
 * of reusing it. */
static void Reallocate(struct Entry *e, u32 allocated) {
  u8 *p = 0;
  if (allocated && !(p = malloc(allocated))) abort();
  free(e->tail);
  e->tail = p;
  e->allocated = allocated;
}
/* Cuts the oldest entry that isn't hollow down to what its header says,
 * which keeps its serial, addresses and flags but no longer offers it to
 * undo. Its registers stay, as where the next entry starts from. */
static void HollowOldest(void) {
  struct Entry *e = &entries[(start + hollow++) % slots];
  held -= REGISTERS_CHARGE + e->allocated;
  Reallocate(e, 0);
  e->hollow = true;
  e->reversible = false;
  Release(e->stack_before); /* only an undo of this entry would need it */
  e->stack_before = 0;
}
/* The configured capacity is a limit, not an allocation. Grow only when all
 * allocated slots are occupied, moving entries into oldest-first order. */
static void Grow(void) {
  u32 size = slots ? (slots > capacity / 2 ? capacity : slots * 2)
                   : (capacity < 64 ? capacity : 64);
  struct Entry *grown = calloc(size, sizeof(*grown));
  if (!grown) abort();
  for (u32 i = 0; i < count; ++i) grown[i] = entries[(start + i) % slots];
  free(entries);
  entries = grown;
  slots = size;
  start = 0;
}
static struct Entry *NewEntry(u32 tail_bytes) {
  struct Entry *e;
  u32 room = tail_bytes + tail_bytes / 2, index;
  if (count == slots && slots < capacity) Grow();
  /* Every step comes through here, so the ring wraps without dividing. */
  if (count == capacity) {
    /* The ring is full: the oldest entry goes, and its slot takes the new
     * one. The next oldest, unless it keeps its own, started from the
     * registers it left. */
    e = &entries[start];
    CopyRegisters(&base, &e->after);
    if (hollow) {
      --hollow;
    } else {
      held -= REGISTERS_CHARGE + e->allocated;
    }
    if (++start == slots) start = 0;
    --count;
  } else {
    index = start + count;
    if (index >= slots) index -= slots;
    e = &entries[index]; /* empty */
  }
  Release(e->stack_before);
  e->stack_before = 0;
  if (e->before) {
    free(e->before);
    e->before = 0;
  }
  /* Keep a buffer the tail fits, unless most of it would sit idle. */
  if (tail_bytes <= e->allocated && e->allocated <= 4 * (u64)tail_bytes + 4096)
    room = e->allocated;
  while (hollow < count && held + REGISTERS_CHARGE + room > budget) HollowOldest();
  if (room != e->allocated) Reallocate(e, room);
  held += REGISTERS_CHARGE + room;
  e->stack_before = Retain(stack);
  e->stack_top_before = before.stack_top;
  ++count;
  return e;
}
static void Finish(bool is_poke, struct MachineWriteRecord *writes, u32 write_count,
                   const u8 *old_bytes, bool truncated, bool exited) {
#ifdef DEBUGHISTORY_CHECK_FPU
  blinkenlib_get_fpu_state(after_fpu);
  if (!before.has_fpu && !SameFpu(before.fpu, after_fpu)) {
    fprintf(stderr, "opcode %#x changed the FPU state at %#llx\n",
            (unsigned)Mopcode(m->xedd->op.rde), (unsigned long long)before.pc);
    abort();
  }
#endif
  if (before.has_fpu) blinkenlib_get_fpu_state(after_fpu);
  u32 tail_bytes = 0;
  u32 journal_bytes = is_poke ? 0 : journal_used;
  bool fpu_changed = before.has_fpu && !SameFpu(before.fpu, after_fpu);
  if (fpu_changed) tail_bytes += sizeof(before.fpu) * 2;
  bool reversible = !truncated && !pending_irreversible;
  for (u32 i = 0; i < write_count; ++i) {
    struct MachineWriteRecord *w = &writes[i];
    tail_bytes += 24 + w->oldsize + (w->truncated ? 0 : w->size);
    if (w->truncated || w->oldsize != w->size) reversible = false;
  }
  tail_bytes += journal_bytes;
  if (!capacity) return;
  struct Entry *e = NewEntry(tail_bytes);
  ++serial;
  TakeRegisters(&e->after);
  /* Where the step started from is where the one before it ended, unless
   * something between the two moved the registers. */
  if (before.moved) {
    if (count > 1) {
      if (!(e->before = malloc(sizeof(*e->before)))) abort();
      CopyRegisters(e->before, &before.registers);
    } else {
      CopyRegisters(&base, &before.registers);
    }
  }
  e->identity = is_poke ? blinkenlib_next_identity() : blinkenlib_active_instruction();
  e->instructions_before = before.instructions;
  e->exited = exited;
  e->poke = is_poke;
  e->hollow = false;
  e->flow = before.flow;
  e->size = before.size;
  e->depth = stack ? stack->depth : 0;
  e->write_count = write_count;
  e->fpu_changed = fpu_changed;
  e->journal_count = is_poke ? 0 : journal_count;
  e->journal_bytes = journal_bytes;
  u8 *p = e->tail;
  if (fpu_changed) {
    memcpy(p, before.fpu, sizeof(before.fpu));
    memcpy(p + sizeof(before.fpu), after_fpu, sizeof(after_fpu));
    p += sizeof(before.fpu) * 2;
  }
  for (u32 i = 0; i < write_count; ++i) {
    struct MachineWriteRecord *w = &writes[i];
    u32 newsize = w->truncated ? 0 : w->size;
    Write64(p, w->addr);
    Write32(p + 8, w->size);
    Write32(p + 12, w->oldsize);
    Write32(p + 16, newsize);
    Write32(p + 20, w->truncated);
    memcpy(p + 24, old_bytes + w->oldoffset, w->oldsize);
    if (newsize && !CopyGuest(p + 24 + w->oldsize, w->addr, newsize)) {
      Write32(p + 16, 0);
      /* Keep the packet layout valid even when the postimage is unreadable. */
      tail_bytes -= newsize;
      newsize = 0;
      /* Undo cannot write back through a guest lookup that failed. */
      reversible = false;
    }
    p += 24 + w->oldsize + newsize;
  }
  if (journal_bytes) memcpy(p, journal, journal_bytes);
  e->tail_bytes = tail_bytes;
  e->reversible = reversible;
  u64 sp = RegisterValue(&e->after, BLINKENLIB_REG_RSP);
  if (!is_poke && before.flow == BLINKENLIB_CONTROL_FLOW_CALL) {
    struct Frame *f = calloc(1, sizeof(*f));
    if (!f) abort();
    f->previous = stack; /* transfer current-stack ownership to the new frame */
    f->references = 1;
    f->depth = stack ? stack->depth + 1 : 1;
    f->target = e->after.pc;
    f->destination = before.pc + before.size;
    f->sp = sp;
    stack = f;
  } else if (!is_poke) {
    /* A frame lasts while its return address is on the stack. A `ret` takes
     * it off, and so does anything else that moves rsp above it, such as C++
     * exception unwinding or longjmp landing in an outer function, which
     * leave many frames at once without a `ret` each. A `ret` that returns
     * through an address no `call` pushed leaves the frames it is below. */
    while (stack && stack->sp < sp) {
      struct Frame *previous = Retain(stack->previous);
      Release(stack);
      stack = previous;
    }
  }
}
void DebugHistoryFinish(bool exited) {
  if (!pending || poke || !m) return;
  if (split_count || split_truncated) {
    /* the last part's writes join the parts before it */
    GatherWrites();
    Finish(false, split_writes, split_count, split_bytes, split_truncated, exited);
  } else {
    Finish(false, m->writeold, m->writeoldcount, m->writeoldbytes,
           m->writeoldtruncated, exited);
  }
  pending = false;
  pending_irreversible = false;
  ForgetStep();
}
EMSCRIPTEN_KEEPALIVE
bool blinkenlib_history_can_undo(void) {
  struct Entry *e = EntryAt(0);
  return e && e->reversible && !e->hollow;
}
EMSCRIPTEN_KEEPALIVE
int blinkenlib_history_undo(void) {
  struct Entry *e = EntryAt(0);
  if (!e) return 0;
  if (!e->reversible || e->hollow) return -1;
  const struct Registers *b = Before(0);
  u8 *p = e->tail, *fpu = 0;
  u32 n = e->write_count;
  if (e->fpu_changed) {
    fpu = p;
    p += BLINKENLIB_FPU_STATE_SIZE * 2;
  }
  u8 **writes = n ? malloc(n * sizeof(*writes)) : 0;
  if (n && !writes) abort();
  /* Check all mappings before changing anything, a page at a time: a rep
   * string instruction's record can be megabytes long. */
  for (u32 i = 0; i < n; ++i) {
    writes[i] = p;
    u64 address = Read64(p);
    u32 size = Read32(p + 12);
    for (u32 j = 0; j < size; j += 4096 - ((address + j) & 4095))
      if (!blinkenlib_spy_address(address + j)) { free(writes); return -1; }
    p += 24 + size + Read32(p + 16);
  }
  u8 *journal_records = p;
  u32 journal_records_count = e->journal_count;
  for (u32 i = n; i > 0; --i) {
    p = writes[i - 1];
    u64 address = Read64(p);
    u32 size = Read32(p + 12);
    for (u32 j = 0, chunk; j < size; j += chunk) {
      chunk = 4096 - ((address + j) & 4095);
      if (chunk > size - j) chunk = size - j;
      memcpy(blinkenlib_spy_address(address + j), p + 24 + j, chunk);
    }
  }
  free(writes);
  /* The journal's records are taken back newest first. */
  if (journal_records_count) {
    u8 **records = malloc(journal_records_count * sizeof(*records));
    if (!records) abort();
    for (u32 i = 0; i < journal_records_count; ++i) {
      records[i] = journal_records;
      journal_records += 8 + Read32(journal_records + 4);
    }
    for (u32 i = journal_records_count; i > 0; --i)
      UndoJournal(Read32(records[i - 1]), records[i - 1] + 8, Read32(records[i - 1] + 4));
    free(records);
  }
  /* a blocking write that instruction left unfinished starts afresh */
  DeviceForgetProgress(e->identity);
  u32 mask = ChangedRegisters(b, &e->after);
  for (int i = 0; i < 17; ++i)
    if (mask & (1u << i)) blinkenlib_set_register_u64(i, RegisterValue(b, i));
  if (fpu) blinkenlib_set_fpu_state(fpu);
  blinkenlib_set_flags(blinkenlib_architectural_flags(b->flags));
  /* Only undoing the trapped exit resumes the retained machine. A host Poke
   * made after termination must leave its exit state intact. */
  if (e->exited) {
    m->system->exited = false;
    m->system->exitcode = 0;
  }
  memory_stack_top = e->stack_top_before;
  Release(stack);
  stack = Retain(e->stack_before);
  blinkenlib_restore_instruction_count(e->instructions_before);
  held -= REGISTERS_CHARGE + e->allocated; /* not hollow: it was reversible */
  Empty(e);
  --count;
  DebugHistoryCancel();
  return 1;
}
EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_history_stack_depth(void) { return stack ? stack->depth : 0; }
EMSCRIPTEN_KEEPALIVE
const u64 *blinkenlib_history_frame(u32 index) {
  static u64 values[3];
  struct Frame *f = stack;
  if (!f || index >= f->depth) return 0;
  while (f->depth - 1 > index) f = f->previous;
  values[0] = f->target;
  values[1] = f->destination;
  values[2] = f->sp;
  return values;
}
EMSCRIPTEN_KEEPALIVE
bool blinkenlib_history_begin_poke(void) {
  if (!m || poke) return false;
  /* A host edit while waiting for input precedes the eventual read. */
  pending = false;
  TakeBefore(true);
  if (!before.moved) TakeRegisters(&before.registers);
  before.stack_top = memory_stack_top;
  before.flow = before.size = 0;
  poke = true;
  poke_count = 0;
  return true;
}
void DebugHistoryPokeByte(u64 address, u8 old) {
  if (!poke) return;
  if (poke_count == poke_allocated) {
    poke_allocated = poke_allocated ? poke_allocated * 2 : 64;
    void *p = realloc(poke_bytes, poke_allocated * sizeof(*poke_bytes));
    if (!p) abort();
    poke_bytes = p;
  }
  poke_bytes[poke_count] = (struct PokeByte){address, poke_count, old};
  ++poke_count;
}
static int ComparePoke(const void *a, const void *b) {
  const struct PokeByte *x = a, *y = b;
  if (x->address != y->address) return x->address < y->address ? -1 : 1;
  return x->sequence < y->sequence ? -1 : x->sequence > y->sequence;
}
EMSCRIPTEN_KEEPALIVE
int blinkenlib_history_end_poke(void) {
  if (!poke || !m) return -1;
  poke = false;
  /* Host transactions are rare and may exceed the instruction journal's
   * limits. Coalesce their dynamic journal without discarding old bytes. */
  qsort(poke_bytes, poke_count, sizeof(*poke_bytes), ComparePoke);
  struct MachineWriteRecord *writes = poke_count ? calloc(poke_count, sizeof(*writes)) : 0;
  u8 *old_bytes = poke_count ? malloc(poke_count) : 0;
  if (poke_count && (!writes || !old_bytes)) abort();
  u32 write_count = 0, used = 0;
  struct MachineWriteRecord current = {0};
  bool range_changed = false;
  for (u32 i = 0; i < poke_count;) {
    u64 address = poke_bytes[i].address;
    u8 old = poke_bytes[i].old, value;
    do { ++i; } while (i < poke_count && poke_bytes[i].address == address);
    if (current.size && current.addr + current.size != address) {
      if (range_changed) writes[write_count++] = current;
      current.size = current.oldsize = 0;
      range_changed = false;
    }
    if (!current.size) {
      current.addr = address;
      current.oldoffset = used;
    }
    old_bytes[used++] = old;
    ++current.size;
    ++current.oldsize;
    if (blinkenlib_read_memory_byte(address, &value) && old != value) range_changed = true;
  }
  if (range_changed) writes[write_count++] = current;
  struct Registers now;
  TakeRegisters(&now);
  blinkenlib_get_fpu_state(after_fpu);
  bool changed = write_count || ChangedRegisters(&before.registers, &now) ||
                 !SameFpu(before.fpu, after_fpu);
  if (changed) Finish(true, writes, write_count, old_bytes, false, false);
  free(writes);
  free(old_bytes);
  poke_count = 0;
  return changed;
}
