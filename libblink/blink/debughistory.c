/* Debugger history stays in wasm. Slots retain their allocation when the ring
 * wraps, unless it is far larger than the new packet; JS only decodes the
 * compact packets that the History panel requests.
 * Packet v1: 88-byte LE header, changed GPR old/new pairs, optional two packed
 * FPU blocks, then 24-byte memory descriptors and their old/new byte images.
 * See native-history.ts for the matching reader.
 *
 * The ring holds up to `capacity` entries, and the packets of its newest at
 * most `budget` bytes between them: a step's packet carries up to 64 KiB of the
 * bytes it replaced and as many it left, so a loop of large string stores would
 * otherwise fill the wasm heap long before a 200,000-entry ring is full. Over
 * budget, the oldest entries are hollowed: cut down to their header and marked
 * irreversible, so undo stops at them as at any write it couldn't capture. They
 * stay in the ring, which drops the oldest only when full, so its depth still
 * grows by one entry a step until then. */
#include "blink/debughistory.h"
#include "blink/blinkenlib.h"
#include "blink/endian.h"
#include "blink/machine.h"
#include "blink/rde.h"
#include <stdlib.h>
#include <string.h>

extern struct Machine *m;

struct Frame {
  struct Frame *previous;
  u32 references, depth;
  u64 target, destination, sp;
};
struct Entry {
  u8 *bytes;
  u32 allocated;
  struct Frame *stack_before;
  bool exited;
  u64 instructions_before;
};
struct Snapshot {
  u64 registers[17], pc;
  u64 instructions;
  u32 flags, flow, size;
  u8 fpu[BLINKENLIB_FPU_STATE_SIZE];
};
struct PokeByte { u64 address; u32 sequence; u8 old; };
#define HISTORY_BUDGET (256u << 20)
static struct Entry *entries;
static u32 capacity, count, start;
static u32 hollow; /* the oldest `hollow` entries are hollow */
static u8 (*headers)[88]; /* their headers, by slot, once any is hollowed */
static u32 budget = HISTORY_BUDGET;
static u64 held; /* bytes allocated to the packets of the others */
static u64 serial;
static struct Snapshot before;
static bool pending, poke, pending_irreversible;
static struct Frame *stack;
static struct PokeByte *poke_bytes;
static u32 poke_count, poke_allocated;

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
static void Snapshot(struct Snapshot *out) {
  for (int i = 0; i < 17; ++i)
    out->registers[i] = blinkenlib_get_register_u64(i);
  out->pc = blinkenlib_get_pc();
  out->instructions = blinkenlib_instructions_executed();
  out->flags = blinkenlib_get_flags();
  blinkenlib_get_fpu_state(out->fpu);
}
void DebugHistoryCancel(void) {
  pending = poke = false;
  pending_irreversible = false;
  poke_count = 0;
}
/* B5 can replace this boundary with a journal for signal process state.
 * Until then the signal frame, mask and pending queue cannot be undone. */
void DebugHistoryMarkIrreversible(void) {
  if (pending) {
    pending_irreversible = true;
  } else if (count && capacity) {
    struct Entry *e = &entries[(start + count - 1) % capacity];
    if (e->bytes) Write32(e->bytes + 20, 0);
  }
}
/* The JavaScript filesystem backend completes a capability callback while the guest syscall is
 * still active. It marks the same packet as native descriptor and process-state effects do. */
EMSCRIPTEN_KEEPALIVE
void blinkenlib_history_mark_irreversible(void) {
  DebugHistoryMarkIrreversible();
}
bool DebugHistoryPending(void) { return pending; }
/* Leaves a slot as one no entry occupies: no packet, no frames. A hollow
 * entry's header belongs to `headers`, which it leaves alone (allocated 0). */
static void Empty(struct Entry *e) {
  Release(e->stack_before);
  e->stack_before = 0;
  if (e->allocated) free(e->bytes);
  e->bytes = 0;
  e->allocated = 0;
}
void DebugHistoryClear(void) {
  for (u32 i = 0; i < capacity; ++i) Empty(&entries[i]);
  free(headers);
  headers = 0;
  held = 0;
  hollow = 0;
  Release(stack);
  stack = 0;
  count = start = 0;
  DebugHistoryCancel();
}
EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_history_version(void) { return 1; }
EMSCRIPTEN_KEEPALIVE
void blinkenlib_history_capacity(u32 size) {
  DebugHistoryClear();
  free(entries);
  capacity = size;
  entries = size ? calloc(size, sizeof(*entries)) : 0;
  if (size && !entries) abort();
}
EMSCRIPTEN_KEEPALIVE
void blinkenlib_history_clear(void) { DebugHistoryClear(); }
/* For tests; @specy/x86 doesn't call it. Sets the budget the packets of the
 * entries that aren't hollow share, from the next entry on (0 leaves it as it
 * is), and returns the bytes they hold now. */
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
  return offset < count ? &entries[(start + count - 1 - offset) % capacity] : 0;
}
EMSCRIPTEN_KEEPALIVE
const u8 *blinkenlib_history_entry(u32 offset) {
  struct Entry *e = EntryAt(offset);
  return e ? e->bytes : 0;
}
void DebugHistoryBegin(u32 flow, u32 size) {
  if (!capacity || pending || poke || !m) return;
  Snapshot(&before);
  before.flow = flow;
  before.size = size;
  pending_irreversible = false;
  pending = true;
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
/* Gives an entry a buffer of a new size. Finish() writes the packet whole, so
 * nothing is copied, and the old buffer is freed whole rather than cut down by
 * realloc(): a large packet's small head left live in place would split its
 * memory, and the next large packet would grow the heap instead of reusing it. */
static void Reallocate(struct Entry *e, u32 allocated) {
  u8 *p = malloc(allocated);
  if (!p) abort();
  if (e->allocated) free(e->bytes);
  e->bytes = p;
  e->allocated = allocated;
}
/* Cuts the oldest entry that isn't hollow down to its 88-byte header, which
 * keeps its serial, addresses and flags but no longer offers it to undo. */
static void HollowOldest(void) {
  u32 slot = (start + hollow++) % capacity;
  struct Entry *e = &entries[slot];
  u8 *header;
  if (!headers && !(headers = calloc(capacity, sizeof(*headers)))) abort();
  header = headers[slot];
  memcpy(header, e->bytes, 88);
  Write32(header + 4, 88);
  Write32(header + 20, 0); /* irreversible */
  Write32(header + 56, 0); /* no registers */
  Write32(header + 60, 0); /* no memory writes */
  Write32(header + 64, 0); /* no FPU blocks */
  held -= e->allocated;
  free(e->bytes);
  e->bytes = header;
  e->allocated = 0;
  Release(e->stack_before); /* only an undo of this entry would need it */
  e->stack_before = 0;
}
static struct Entry *NewEntry(u32 bytes) {
  struct Entry *e;
  u32 room = bytes + bytes / 2, index;
  /* Every step comes through here, so the ring wraps without dividing. */
  if (count == capacity) {
    /* The ring is full: the oldest entry goes, and its slot takes the new one. */
    e = &entries[start];
    if (hollow) {
      --hollow;
      e->bytes = 0; /* its header stays in `headers` */
    } else {
      held -= e->allocated;
    }
    if (++start == capacity) start = 0;
    --count;
  } else {
    index = start + count;
    if (index >= capacity) index -= capacity;
    e = &entries[index]; /* empty */
  }
  Release(e->stack_before);
  e->stack_before = 0;
  /* Keep a buffer the packet fits, unless most of it would sit idle. */
  if (bytes <= e->allocated && e->allocated <= 4 * (u64)bytes + 4096)
    room = e->allocated;
  while (hollow < count && held + room > budget) HollowOldest();
  if (room != e->allocated) Reallocate(e, room);
  held += room;
  e->stack_before = Retain(stack);
  ++count;
  return e;
}
static void Finish(bool is_poke, struct MachineWriteRecord *writes, u32 write_count,
                   const u8 *old_bytes, bool truncated, bool exited) {
  struct Snapshot after;
  Snapshot(&after);
  u32 mask = 0, bytes = 88;
  for (int i = 0; i < 17; ++i) {
    if (before.registers[i] != after.registers[i]) {
      mask |= 1u << i;
      bytes += 16;
    }
  }
  bool fpu_changed = memcmp(before.fpu, after.fpu, sizeof(before.fpu)) != 0;
  if (fpu_changed) bytes += sizeof(before.fpu) * 2;
  bool reversible = !truncated && !pending_irreversible;
  for (u32 i = 0; i < write_count; ++i) {
    struct MachineWriteRecord *w = &writes[i];
    bytes += 24 + w->oldsize + (w->truncated ? 0 : w->size);
    if (w->truncated || w->oldsize != w->size) reversible = false;
  }
  if (!capacity) return;
  struct Entry *e = NewEntry(bytes);
  e->instructions_before = before.instructions;
  e->exited = exited;
  u8 *p = e->bytes;
  memset(p, 0, 88);
  Write32(p, 1);
  Write32(p + 4, bytes);
  ++serial;
  Write64(p + 8, is_poke ? blinkenlib_next_identity() : blinkenlib_active_instruction());
  Write32(p + 16, is_poke);
  Write32(p + 20, reversible);
  Write64(p + 24, before.pc);
  Write64(p + 32, after.pc);
  Write32(p + 40, before.flags);
  Write32(p + 44, after.flags);
  Write32(p + 48, before.flow);
  Write32(p + 52, before.size);
  Write32(p + 56, mask);
  Write32(p + 60, write_count);
  Write32(p + 64, fpu_changed);
  Write32(p + 68, stack ? stack->depth : 0);
  Write64(p + 72, after.registers[BLINKENLIB_REG_RSP]);
  Write64(p + 80, before.pc + before.size);
  p += 88;
  for (int i = 0; i < 17; ++i) if (mask & (1u << i)) {
    Write64(p, before.registers[i]);
    Write64(p + 8, after.registers[i]);
    p += 16;
  }
  if (fpu_changed) {
    memcpy(p, before.fpu, sizeof(before.fpu));
    memcpy(p + sizeof(before.fpu), after.fpu, sizeof(after.fpu));
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
      bytes -= newsize;
      newsize = 0;
      /* Undo writes back through the lookup that just failed, which refuses
       * blinkenlib's shadow range, where Blink's own mmap() puts pages. */
      reversible = false;
    }
    p += 24 + w->oldsize + newsize;
  }
  Write32(e->bytes + 4, bytes);
  Write32(e->bytes + 20, reversible);
  if (!is_poke && before.flow == BLINKENLIB_CONTROL_FLOW_CALL) {
    struct Frame *f = calloc(1, sizeof(*f));
    if (!f) abort();
    f->previous = stack; /* transfer current-stack ownership to the new frame */
    f->references = 1;
    f->depth = stack ? stack->depth + 1 : 1;
    f->target = after.pc;
    f->destination = before.pc + before.size;
    f->sp = after.registers[BLINKENLIB_REG_RSP];
    stack = f;
  } else if (!is_poke && before.flow == BLINKENLIB_CONTROL_FLOW_RETURN && stack) {
    struct Frame *previous = Retain(stack->previous);
    Release(stack);
    stack = previous;
  }
}
void DebugHistoryFinish(bool exited) {
  if (!pending || poke || !m) return;
  Finish(false, m->writeold, m->writeoldcount, m->writeoldbytes,
         m->writeoldtruncated, exited);
  pending = false;
  pending_irreversible = false;
}
EMSCRIPTEN_KEEPALIVE
bool blinkenlib_history_can_undo(void) {
  struct Entry *e = EntryAt(0);
  return e && Read32(e->bytes + 20);
}
EMSCRIPTEN_KEEPALIVE
int blinkenlib_history_undo(void) {
  struct Entry *e = EntryAt(0);
  if (!e) return 0;
  if (!Read32(e->bytes + 20)) return -1;
  u8 *p = e->bytes + 88, *fpu = 0;
  u32 mask = Read32(e->bytes + 56), n = Read32(e->bytes + 60);
  u64 values[17];
  for (int i = 0; i < 17; ++i) if (mask & (1u << i)) {
    values[i] = Read64(p);
    p += 16;
  }
  if (Read32(e->bytes + 64)) {
    fpu = p;
    p += BLINKENLIB_FPU_STATE_SIZE * 2;
  }
  u8 **writes = n ? malloc(n * sizeof(*writes)) : 0;
  if (n && !writes) abort();
  /* Check all mappings before changing anything. */
  for (u32 i = 0; i < n; ++i) {
    writes[i] = p;
    u64 address = Read64(p);
    u32 size = Read32(p + 12);
    for (u32 j = 0; j < size; ++j)
      if (!blinkenlib_spy_address(address + j)) { free(writes); return -1; }
    p += 24 + size + Read32(p + 16);
  }
  for (u32 i = n; i > 0; --i) {
    p = writes[i - 1];
    u64 address = Read64(p);
    for (u32 j = 0; j < Read32(p + 12); ++j)
      blinkenlib_write_memory_byte(address + j, p[24 + j]);
  }
  free(writes);
  for (int i = 0; i < 17; ++i)
    if (mask & (1u << i)) blinkenlib_set_register_u64(i, values[i]);
  if (fpu) blinkenlib_set_fpu_state(fpu);
  blinkenlib_set_flags(Read32(e->bytes + 40));
  /* Only undoing the trapped exit resumes the retained machine. A host Poke
   * made after termination must leave its exit state intact. */
  if (e->exited) {
    m->system->exited = false;
    m->system->exitcode = 0;
  }
  Release(stack);
  stack = Retain(e->stack_before);
  blinkenlib_restore_instruction_count(e->instructions_before);
  held -= e->allocated; /* the newest entry is never hollow: it was reversible */
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
  Snapshot(&before);
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
  struct Snapshot after;
  Snapshot(&after);
  bool changed = write_count || memcmp(before.registers, after.registers, sizeof(before.registers)) ||
                 memcmp(before.fpu, after.fpu, sizeof(before.fpu));
  if (changed) Finish(true, writes, write_count, old_bytes, false, false);
  free(writes);
  free(old_bytes);
  poke_count = 0;
  return changed;
}
