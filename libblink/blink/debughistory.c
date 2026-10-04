/* Debugger history stays in wasm. Slots retain their allocation when the ring
 * wraps; JS only decodes the compact packets that the History panel requests.
 * Packet v1: 88-byte LE header, changed GPR old/new pairs, optional two packed
 * FPU blocks, then 24-byte memory descriptors and their old/new byte images.
 * See native-history.ts for the matching reader. */
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
};
struct Snapshot {
  u64 registers[17], pc;
  u32 flags, flow, size;
  u8 fpu[BLINKENLIB_FPU_STATE_SIZE];
};
struct PokeByte { u64 address; u32 sequence; u8 old; };
static struct Entry *entries;
static u32 capacity, count, start;
static u64 serial;
static struct Snapshot before;
static bool pending, poke;
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
  out->flags = blinkenlib_get_flags();
  blinkenlib_get_fpu_state(out->fpu);
}
void DebugHistoryCancel(void) {
  pending = poke = false;
  poke_count = 0;
}
bool DebugHistoryPending(void) { return pending; }
void DebugHistoryClear(void) {
  for (u32 i = 0; i < capacity; ++i) {
    Release(entries[i].stack_before);
    entries[i].stack_before = 0;
  }
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
  for (u32 i = 0; i < capacity; ++i) free(entries[i].bytes);
  free(entries);
  capacity = size;
  entries = size ? calloc(size, sizeof(*entries)) : 0;
  if (size && !entries) abort();
}
EMSCRIPTEN_KEEPALIVE
void blinkenlib_history_clear(void) { DebugHistoryClear(); }
EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_history_count(void) { return count; }
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
static struct Entry *NewEntry(u32 bytes) {
  u32 index;
  if (count == capacity) {
    index = start;
    start = (start + 1) % capacity;
  } else {
    index = (start + count++) % capacity;
  }
  struct Entry *e = &entries[index];
  Release(e->stack_before);
  e->stack_before = Retain(stack);
  if (e->allocated < bytes) {
    u32 allocated = bytes + bytes / 2;
    void *p = realloc(e->bytes, allocated);
    if (!p) abort();
    e->bytes = p;
    e->allocated = allocated;
  }
  return e;
}
static void Finish(bool is_poke, struct MachineWriteRecord *writes, u32 write_count,
                   const u8 *old_bytes, bool truncated) {
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
  bool reversible = !truncated;
  for (u32 i = 0; i < write_count; ++i) {
    struct MachineWriteRecord *w = &writes[i];
    bytes += 24 + w->oldsize + (w->truncated ? 0 : w->size);
    if (w->truncated || w->oldsize != w->size) reversible = false;
  }
  if (!capacity) return;
  struct Entry *e = NewEntry(bytes);
  u8 *p = e->bytes;
  memset(p, 0, 88);
  Write32(p, 1);
  Write32(p + 4, bytes);
  Write64(p + 8, ++serial);
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
    }
    p += 24 + w->oldsize + newsize;
  }
  Write32(e->bytes + 4, bytes);
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
void DebugHistoryFinish(void) {
  if (!pending || poke || !m) return;
  Finish(false, m->writeold, m->writeoldcount, m->writeoldbytes, m->writeoldtruncated);
  pending = false;
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
  Release(stack);
  stack = Retain(e->stack_before);
  Release(e->stack_before);
  e->stack_before = 0;
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
  if (changed) Finish(true, writes, write_count, old_bytes, false);
  free(writes);
  free(old_bytes);
  poke_count = 0;
  return changed;
}
