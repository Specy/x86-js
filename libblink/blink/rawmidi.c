/* The raw MIDI port: snd-virmidi's card 1, device 0, at ALSA's
 * /dev/snd/midiC1D0 and, through OSS emulation, /dev/midi1, with FluidSynth
 * in the guest playing what leaves it (x86-devices.md, "The raw MIDI port").
 *
 * Bytes leave at MIDI's 31,250 baud on Program time, ten bits each, behind
 * rawmidi's buffer (a page, 4 KiB, until PARAMS changes it), a documented
 * model since the virtual card has no cable. They are parsed as the kernel's
 * sequencer encoder parses them (seq_midi_event.c), and each complete message
 * is handed to the host with the time its last byte leaves: running status
 * expanded, a SysEx F0 to F7 as one message. Real-time bytes (F8 to FF) and
 * the system common messages take their time on the port but are not handed
 * on, since FluidSynth ignores what the encoder makes of them.
 *
 * Every open shares the one output substream, its buffer and its parser.
 * Linux gives an ALSA open without O_APPEND the next of the device's sixteen
 * substreams instead, each with a buffer and running status of its own; OSS
 * opens and O_APPEND opens share, as here.
 *
 * What the synthesizer has been told is kept twice: as of every byte queued,
 * which the messages are handed on from, and as of the bytes that have left,
 * which a DROP or an Undo falls back to. Undo of a write takes back its
 * bytes that have not left and tells the host what puts back the channels'
 * programs, controllers, pitch bend and master volume, and stops the notes
 * the write started that already sound (x86-devices.md, "The MIDI port under
 * Undo"). */
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>

#include "blink/blinkenlib.h"
#include "blink/debughistory.h"
#include "blink/endian.h"
#include "blink/environment.h"
#include "blink/errno.h"
#include "blink/machine.h"
#include "blink/macros.h"
#include "blink/sound.h"
#include "blink/timespec.h"

#define SNDRV_RAWMIDI_IOCTL_PVERSION      0x80045700
#define SNDRV_RAWMIDI_IOCTL_INFO          0x810c5701
#define SNDRV_RAWMIDI_IOCTL_USER_PVERSION 0x40045702
#define SNDRV_RAWMIDI_IOCTL_PARAMS        0xc0305710
#define SNDRV_RAWMIDI_IOCTL_STATUS32      0xc0245720
#define SNDRV_RAWMIDI_IOCTL_STATUS64      0xc0385720
#define SNDRV_RAWMIDI_IOCTL_DROP          0x40045730
#define SNDRV_RAWMIDI_IOCTL_DRAIN         0x40045731
#define SNDRV_RAWMIDI_VERSION             0x00020004  // 2.0.4 in 6.12
#define SNDRV_PROTOCOL_2_0_2              0x00020002
#define SNDRV_RAWMIDI_STREAM_OUTPUT       0
#define SNDRV_RAWMIDI_STREAM_INPUT        1
#define SNDRV_RAWMIDI_INFO_FLAGS          7  // OUTPUT | INPUT | DUPLEX
#define SNDRV_RAWMIDI_MODE_FRAMING_TSTAMP 1

#define MIDI_BYTE_NS    320000  // ten bits at 31,250 baud
#define MIDI_BUFFER     4096    // a page
#define MIDI_EVENT_BUF  256     // the virmidi encoder's buffer
#define MIDI_SUBSTREAMS 16      // snd_virmidi_new()'s

// seq_midi_event.c's types: the channel messages by their status's high
// nibble, then an invalid one, then the system messages F0 to FF.
#define ST_INVALID 7
#define ST_SPECIAL 8
#define ST_SYSEX   ST_SPECIAL
static const i8 kQueueLength[16] = {2, 2, 2, 2, 1, 1, 2, -1,
                                    1, 1, 2, 1, -1, -1, 0, -1};

struct MidiParser {
  u8 type;
  i8 qlen;
  u16 read;
  u8 overflow;  // a SysEx longer than the encoder's buffer
  u8 buf[MIDI_EVENT_BUF];
};

// What the synthesizer keeps for a channel, as Undo puts it back.
struct MidiChannel {
  u8 program;
  u8 pressure;
  u8 nrpn;  // the parameter number selected last was an NRPN
  u8 cc[128];
  u8 held[16];
  u16 bend;
  u16 rpn[3];  // pitch bend sensitivity, fine and coarse tuning
};

struct MidiSynth {
  struct MidiChannel ch[16];
  u16 master;
};

struct MidiPort {
  int outputs;  // descriptions holding the output substream
  bool active_sensing;
  u32 capacity, avail_min;
  u8 *ring;
  u32 head, level;  // the bytes that have not left: ring[head..head+level)
  i64 start;        // when the first of them started leaving
  struct MidiParser sent_parser, look_parser;
};

static struct MidiPort port;
static struct MidiSynth sent, look;

// ------------------------------------------------------------ the parser

static void ResetParser(struct MidiParser *p) {
  memset(p, 0, sizeof(*p));
  p->type = ST_INVALID;
}

/* snd_midi_event_encode_byte(): the length of the message `c` completes in
 * p->buf, when it is one the synthesizer takes, else 0. */
static u32 ParseByte(struct MidiParser *p, u8 c) {
  u32 n;
  u8 type, overflow;
  if (c >= 0xf8) return 0;  // real-time: an event of its own, ignored
  if ((c & 0x80) && (c != 0xf7 || p->type != ST_SYSEX)) {
    p->buf[0] = c;
    p->type = (c & 0xf0) == 0xf0 ? (c & 0x0f) + ST_SPECIAL : (c >> 4) & 7;
    p->read = 1;
    p->qlen = kQueueLength[p->type];
    p->overflow = 0;
  } else if (p->qlen > 0) {
    p->buf[p->read++] = c;
    if (p->type != ST_SYSEX) p->qlen--;
  } else {
    // running status
    p->buf[1] = c;
    p->qlen = kQueueLength[p->type] - 1;
    p->read = 2;
  }
  if (!p->qlen) {
    type = p->type;
    if (p->type >= ST_SPECIAL) p->type = ST_INVALID;
    return type < ST_INVALID ? p->read : 0;
  }
  if (p->type == ST_SYSEX && (c == 0xf7 || p->read >= MIDI_EVENT_BUF)) {
    n = p->read;
    overflow = p->overflow;
    if (c != 0xf7) {
      // the encoder hands on what it has and goes on: FluidSynth takes each
      // part for a whole SysEx, so a longer one is not handed on at all
      p->read = 0;
      p->overflow = 1;
      return 0;
    }
    p->read = 0;
    p->qlen = 0;
    p->type = ST_INVALID;
    p->overflow = 0;
    return overflow ? 0 : n;
  }
  return 0;
}

// ------------------------------------------------------------ the synthesizer

/* Byte ranges of the synthesizer's state a write changed, with what they
 * held, for Undo to put back. */
struct MidiDiffs {
  u8 *bytes;
  u32 size, capacity;
};

static void Remember(struct MidiDiffs *d, const void *field, u32 size) {
  u32 want;
  u8 *grown;
  if (!d) return;
  if (d->size + 4 + size > d->capacity) {
    want = MAX(d->capacity * 2, d->size + 4 + size + 256);
    if (!(grown = (u8 *)realloc(d->bytes, want))) return;
    d->bytes = grown;
    d->capacity = want;
  }
  Write16(d->bytes + d->size, (const u8 *)field - (const u8 *)&look);
  Write16(d->bytes + d->size + 2, size);
  memcpy(d->bytes + d->size + 4, field, size);
  d->size += 4 + size;
}

static void SetByte(struct MidiDiffs *d, u8 *field, u8 value) {
  if (*field == value) return;
  Remember(d, field, 1);
  *field = value;
}

static void SetWord(struct MidiDiffs *d, u16 *field, u16 value) {
  if (*field == value) return;
  Remember(d, field, 2);
  *field = value;
}

static void DefaultChannel(struct MidiChannel *c) {
  memset(c, 0, sizeof(*c));
  c->cc[7] = 100;
  c->cc[10] = 64;
  c->cc[11] = 127;
  c->cc[98] = c->cc[99] = c->cc[100] = c->cc[101] = 127;
  c->bend = 8192;
  c->rpn[0] = 2 << 7;  // two semitones
  c->rpn[1] = 8192;
  c->rpn[2] = 64 << 7;
}

/* General MIDI's power-on state, which GM System On and the GS and XG resets
 * also give. */
static void DefaultSynth(struct MidiSynth *s) {
  int i;
  for (i = 0; i < 16; ++i) DefaultChannel(s->ch + i);
  s->master = 16383;
}

static void SetHeld(struct MidiDiffs *d, struct MidiChannel *c, u8 note,
                    bool held) {
  u8 bits = c->held[note >> 3];
  bits = held ? bits | 1 << (note & 7) : bits & ~(1 << (note & 7));
  SetByte(d, c->held + (note >> 3), bits);
}

static bool IsHeld(const struct MidiChannel *c, int note) {
  return c->held[note >> 3] >> (note & 7) & 1;
}

static bool SysexIs(const u8 *msg, u32 n, const u8 *pattern, u32 size,
                    int device_at) {
  u32 i;
  if (n != size) return false;
  for (i = 0; i < size; ++i) {
    if ((int)i == device_at) continue;
    if (msg[i] != pattern[i]) return false;
  }
  return true;
}

/* What a complete message changes in what the synthesizer keeps. `s` is
 * `look` when `d` records the changes. */
static void ApplyMessage(struct MidiSynth *s, const u8 *msg, u32 n,
                         struct MidiDiffs *d) {
  static const u8 kGmOn[] = {0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7};
  static const u8 kGm2On[] = {0xf0, 0x7e, 0x7f, 0x09, 0x03, 0xf7};
  static const u8 kGsReset[] = {0xf0, 0x41, 0x10, 0x42, 0x12, 0x40,
                                0x00, 0x7f, 0x00, 0x41, 0xf7};
  static const u8 kXgOn[] = {0xf0, 0x43, 0x10, 0x4c, 0x00,
                             0x00, 0x7e, 0x00, 0xf7};
  struct MidiChannel *c;
  struct MidiSynth reset;
  u8 cc, value;
  int i, index;
  if (msg[0] == 0xf0) {
    if (SysexIs(msg, n, kGmOn, sizeof(kGmOn), 2) ||
        SysexIs(msg, n, kGm2On, sizeof(kGm2On), 2) ||
        SysexIs(msg, n, kGsReset, sizeof(kGsReset), 2) ||
        (n == sizeof(kXgOn) && (msg[2] & 0xf0) == 0x10 &&
         SysexIs(msg, n, kXgOn, sizeof(kXgOn), 2))) {
      DefaultSynth(&reset);
      if (memcmp(&reset, s, sizeof(reset))) {
        Remember(d, s, sizeof(*s));
        *s = reset;
      }
    } else if (n == 8 && msg[1] == 0x7f && msg[3] == 0x04 && msg[4] == 0x01 &&
               msg[7] == 0xf7) {
      SetWord(d, &s->master, msg[6] << 7 | msg[5]);
    }
    return;
  }
  c = s->ch + (msg[0] & 15);
  switch (msg[0] & 0xf0) {
    case 0x80:
      SetHeld(d, c, msg[1], false);
      break;
    case 0x90:
      SetHeld(d, c, msg[1], msg[2] > 0);
      break;
    case 0xb0:
      cc = msg[1];
      value = msg[2];
      if (cc == 120 || cc >= 123) {
        // All Sound Off, All Notes Off and the mode messages end every note
        for (i = 0; i < 16; ++i) SetByte(d, c->held + i, 0);
      } else if (cc == 121) {
        // Reset All Controllers, as RP-015 says
        SetByte(d, c->cc + 1, 0);
        SetByte(d, c->cc + 11, 127);
        for (i = 64; i <= 67; ++i) SetByte(d, c->cc + i, 0);
        for (i = 98; i <= 101; ++i) SetByte(d, c->cc + i, 127);
        SetWord(d, &c->bend, 8192);
        SetByte(d, &c->pressure, 0);
      } else if (cc != 122) {
        SetByte(d, c->cc + cc, value);
        if (cc == 100 || cc == 101) SetByte(d, &c->nrpn, 0);
        if (cc == 98 || cc == 99) SetByte(d, &c->nrpn, 1);
        if ((cc == 6 || cc == 38) && !c->nrpn && !c->cc[101] &&
            c->cc[100] < 3) {
          index = c->cc[100];
          SetWord(d, c->rpn + index,
                  cc == 6 ? (value << 7 | (c->rpn[index] & 0x7f))
                          : ((c->rpn[index] & ~0x7f) | value));
        }
      }
      break;
    case 0xc0:
      SetByte(d, &c->program, msg[1]);
      break;
    case 0xd0:
      SetByte(d, &c->pressure, msg[1]);
      break;
    case 0xe0:
      SetWord(d, &c->bend, msg[2] << 7 | msg[1]);
      break;
    default:
      break;
  }
}

static void EmitMessage(i64 at, u8 a, u8 b, u8 c, u32 n) {
  u8 msg[3] = {a, b, c};
  SoundEmitMidi(at, msg, n);
}

static void EmitController(i64 at, int channel, u8 cc, u8 value) {
  EmitMessage(at, 0xb0 | channel, cc, value, 3);
}

/* The messages that take the synthesizer from `from` to `to`, at `at`: the
 * notes `to` does not hold are released, and every setting that differs is
 * sent again. Notes `to` holds that `from` does not are not started: Undo
 * never starts a note the program ended. */
static void EmitRestore(i64 at, const struct MidiSynth *from,
                        const struct MidiSynth *to) {
  int ch, i;
  bool bank, select;
  u8 sysex[8];
  const struct MidiChannel *f, *t;
  for (ch = 0; ch < 16; ++ch) {
    f = from->ch + ch;
    t = to->ch + ch;
    for (i = 0; i < 128; ++i) {
      if (IsHeld(f, i) && !IsHeld(t, i)) EmitMessage(at, 0x80 | ch, i, 0, 3);
    }
    bank = f->cc[0] != t->cc[0] || f->cc[32] != t->cc[32];
    if (bank) {
      EmitController(at, ch, 0, t->cc[0]);
      EmitController(at, ch, 32, t->cc[32]);
    }
    if (bank || f->program != t->program) {
      EmitMessage(at, 0xc0 | ch, t->program, 0, 2);
    }
    for (i = 0; i < 120; ++i) {
      if (i == 0 || i == 32 || i == 6 || i == 38 || (i >= 96 && i <= 101)) {
        continue;  // bank select, and data entry with what selects for it
      }
      if (f->cc[i] != t->cc[i]) EmitController(at, ch, i, t->cc[i]);
    }
    select = f->nrpn != t->nrpn;
    for (i = 98; i <= 101; ++i) select |= f->cc[i] != t->cc[i];
    for (i = 0; i < 3; ++i) {
      if (f->rpn[i] == t->rpn[i]) continue;
      EmitController(at, ch, 101, 0);
      EmitController(at, ch, 100, i);
      EmitController(at, ch, 6, t->rpn[i] >> 7);
      EmitController(at, ch, 38, t->rpn[i] & 0x7f);
      select = true;
    }
    if (select) {
      if (t->nrpn) {
        EmitController(at, ch, 101, t->cc[101]);
        EmitController(at, ch, 100, t->cc[100]);
        EmitController(at, ch, 99, t->cc[99]);
        EmitController(at, ch, 98, t->cc[98]);
      } else {
        EmitController(at, ch, 99, t->cc[99]);
        EmitController(at, ch, 98, t->cc[98]);
        EmitController(at, ch, 101, t->cc[101]);
        EmitController(at, ch, 100, t->cc[100]);
      }
    }
    if (f->bend != t->bend) {
      EmitMessage(at, 0xe0 | ch, t->bend & 0x7f, t->bend >> 7, 3);
    }
    if (f->pressure != t->pressure) {
      EmitMessage(at, 0xd0 | ch, t->pressure, 0, 2);
    }
  }
  if (from->master != to->master) {
    sysex[0] = 0xf0;
    sysex[1] = 0x7f;
    sysex[2] = 0x7f;
    sysex[3] = 0x04;
    sysex[4] = 0x01;
    sysex[5] = to->master & 0x7f;
    sysex[6] = to->master >> 7;
    sysex[7] = 0xf7;
    SoundEmitMidi(at, sysex, sizeof(sysex));
  }
}

// ------------------------------------------------------------ the port

static void Feed(struct MidiParser *p, struct MidiSynth *s, u8 byte,
                 struct MidiDiffs *d, i64 at, bool emit) {
  u32 n;
  if ((n = ParseByte(p, byte))) {
    ApplyMessage(s, p->buf, n, d);
    if (emit) SoundEmitMidi(at, p->buf, n);
  }
}

/* The bytes that have left by `now` reach what the synthesizer was sent. */
static void CatchUp(i64 now) {
  u64 n, i;
  if (!port.level || now <= port.start) return;
  n = (now - port.start) / MIDI_BYTE_NS;
  if (n > port.level) n = port.level;
  for (i = 0; i < n; ++i) {
    Feed(&port.sent_parser, &sent, port.ring[(port.head + i) % port.capacity],
         0, 0, false);
  }
  port.head = (port.head + n) % port.capacity;
  port.level -= n;
  port.start += n * MIDI_BYTE_NS;
}

/* When the last byte queued leaves. */
static i64 EndTime(i64 now) {
  return port.level ? port.start + (i64)port.level * MIDI_BYTE_NS : now;
}

/* When `room` bytes of the buffer are free. */
static i64 RoomTime(u32 room, i64 now) {
  if (room > port.capacity) room = port.capacity;
  if (port.capacity - port.level >= room) return now;
  return port.start +
         (i64)(port.level - (port.capacity - room)) * MIDI_BYTE_NS;
}

/* Queues `bytes`, which leave after what the buffer holds, and hands the
 * host each message they complete with the time its last byte leaves. */
static void Queue(const u8 *bytes, u32 size, i64 now, struct MidiDiffs *d) {
  u32 i;
  i64 at;
  if (!port.level) port.start = now;
  for (i = 0; i < size; ++i) {
    at = port.start + (i64)(port.level + 1) * MIDI_BYTE_NS;
    port.ring[(port.head + port.level) % port.capacity] = bytes[i];
    ++port.level;
    Feed(&port.look_parser, &look, bytes[i], d, at, true);
  }
}

/* Everything queued is dropped: snd_rawmidi_drop_output(). */
static void DropQueue(i64 now) {
  CatchUp(now);
  if (port.level) SoundEmitCut(now, SOUND_MIDI);
  port.head = port.level = 0;
  port.look_parser = port.sent_parser;
  look = sent;
}

static void FreePort(void) {
  free(port.ring);
  memset(&port, 0, sizeof(port));
  ResetParser(&port.sent_parser);
  ResetParser(&port.look_parser);
}

// ------------------------------------------------------------ writes

struct MidiPass {
  struct MidiParser parser;  // the queue's parser before the call
  i64 end_before;            // when what was queued before it leaves
  u32 queued;
  struct MidiDiffs diffs;
};

static void BeginPass(struct MidiPass *p, i64 now) {
  memset(p, 0, sizeof(*p));
  CatchUp(now);
  p->parser = port.look_parser;
  p->end_before = EndTime(now);
}

static void EndPass(struct MidiPass *p) {
  u8 *record;
  u32 size, at;
  if (p->queued) {
    size = 4 + 8 + 6 + p->parser.read + p->diffs.size;
    if ((record = (u8 *)malloc(size))) {
      Write32(record, p->queued);
      Write64(record + 4, p->end_before);
      record[12] = p->parser.type;
      record[13] = p->parser.qlen;
      Write16(record + 14, p->parser.read);
      Write16(record + 16, p->parser.overflow);
      at = 18;
      memcpy(record + at, p->parser.buf, p->parser.read);
      at += p->parser.read;
      memcpy(record + at, p->diffs.bytes, p->diffs.size);
      DebugHistoryJournal(JOURNAL_MIDI_WRITE, record, size);
      free(record);
    }
  }
  free(p->diffs.bytes);
  p->diffs.bytes = 0;
}

static int CopySegments(struct Machine *m, const struct GuestSegment *segments,
                        u32 count, u64 offset, u8 *out, u64 size) {
  u32 i;
  u64 n;
  for (i = 0; i < count && size; ++i) {
    if (offset >= segments[i].len) {
      offset -= segments[i].len;
      continue;
    }
    n = MIN(size, segments[i].len - offset);
    if (CopyFromUserRead(m, out, segments[i].addr + offset, n) == -1) {
      return efault();
    }
    out += n;
    size -= n;
    offset = 0;
  }
  return 0;
}

static i64 FinishWrite(struct DeviceFile *df, i64 rc) {
  df->progress = 0;
  df->progress_identity = 0;
  return rc;
}

/* snd_rawmidi_write(): what fits is queued; without O_NONBLOCK the write
 * waits for room until every byte is queued, keeping what it queued across
 * the times Blink starts it over. Through /dev/midi1 or with O_APPEND the
 * write is atomic: all of it fits at once or it waits, and one larger than
 * the buffer answers EIO. With O_DSYNC it waits until all of it has left. */
i64 MidiWrite(struct Machine *m, struct DeviceFile *df,
              const struct GuestSegment *segments, u32 count, int oflags) {
  u8 chunk[512];
  u32 i;
  i64 now, until = 0;
  u64 size, identity, rest, take, n, room, need;
  bool append = df->sound->append;
  struct MidiPass p;
  if (!df->sound->output) return ebadf();
  for (size = i = 0; i < count; ++i) size += segments[i].len;
  if (!size) return 0;
  if (append && size > port.capacity) {
    errno = EIO;
    return -1;
  }
  identity = blinkenlib_active_instruction();
  if (df->progress_identity != identity) {
    df->progress_identity = identity;
    df->progress = 0;
  }
  now = SoundNow();
  BeginPass(&p, now);
  for (;;) {
    now = SoundNow();
    CatchUp(now);
    room = port.capacity - port.level;
    rest = size - df->progress;
    if (rest) {
      if (room >= port.avail_min && (!append || room >= rest)) {
        take = MIN(room, rest);
        while (take) {
          n = MIN(take, sizeof(chunk));
          if (CopySegments(m, segments, count, df->progress, chunk, n) == -1) {
            EndPass(&p);
            return FinishWrite(df, df->progress ? (i64)df->progress : -1);
          }
          Queue(chunk, n, now, &p.diffs);
          p.queued += n;
          df->progress += n;
          take -= n;
        }
        if (df->progress < size && !(oflags & O_NONBLOCK)) continue;
        if (df->progress < size || !(oflags & O_DSYNC)) break;
        continue;
      }
      if (oflags & O_NONBLOCK) {
        EndPass(&p);
        if (df->progress) return FinishWrite(df, df->progress);
        FinishWrite(df, 0);
        return eagain();
      }
      need = append ? rest : MAX(port.avail_min, MIN(rest, port.capacity));
      until = RoomTime(need, now);
    } else {
      // O_DSYNC: until every byte has left
      if (!port.level) break;
      until = EndTime(now);
    }
    EndPass(&p);
    if (df->progress && (GuestWaitCancelled() || (m->signals & ~m->sigmask))) {
      return FinishWrite(df, df->progress);
    }
    if (!df->progress && GuestWaitInterruptedRestartable(m)) {
      return FinishWrite(df, eintr());
    }
    GuestWaitHaltWake(m, GetMaxTime(), 0, DeviceTimespec(until));
  }
  EndPass(&p);
  return FinishWrite(df, df->progress);
}

/* Halts the call until every queued byte has left, as
 * snd_rawmidi_drain_output() waits. Returns 0 once they have, or -1 with
 * EINTR when a signal ended the wait and `interruptible`. */
static int Drain(struct Machine *m, bool interruptible) {
  i64 now = SoundNow();
  CatchUp(now);
  if (!port.level) return 0;
  if (interruptible) {
    if (GuestWaitInterruptedRestartable(m)) return eintr();
  } else if (GuestWaitCancelled() || (m->signals & ~m->sigmask)) {
    return 0;
  }
  GuestWaitHaltWake(m, GetMaxTime(), 0, DeviceTimespec(EndTime(now)));
}

// ------------------------------------------------------------ open, release

/* snd_rawmidi_open(): O_APPEND needs O_NONBLOCK. The output substream's
 * buffer, parameters and parser are made by its first open. */
int MidiOpen(struct DeviceFile *df, int oflags) {
  int access = oflags & O_ACCMODE;
  if ((oflags & O_APPEND) && !(oflags & O_NONBLOCK)) return einval();
  if (access == O_WRONLY || access == O_RDWR) {
    if (!port.outputs) {
      FreePort();
      if (!(port.ring = (u8 *)malloc(MIDI_BUFFER))) return enomem();
      port.capacity = MIDI_BUFFER;
      port.avail_min = 1;
    }
    ++port.outputs;
    df->sound->output = true;
  }
  if (access == O_RDONLY || access == O_RDWR) df->sound->input = true;
  // OSS's opens are in append mode, as O_APPEND ones are (snd_rawmidi_open())
  df->sound->append = (oflags & O_APPEND) || df->node->major == 14;
  return 0;
}

/* close() of the last description holding the output: an active sensing
 * byte when PARAMS asked for one, then the buffer drains, a signal ending
 * the wait and dropping the rest. */
void MidiCloseWait(struct Machine *m, struct DeviceFile *df) {
  u8 sensing = 0xfe;
  i64 now;
  if (!df->sound->output || port.outputs != 1) return;
  now = SoundNow();
  CatchUp(now);
  if (port.active_sensing && port.level < port.capacity) {
    port.active_sensing = false;
    Queue(&sensing, 1, now, 0);
  }
  Drain(m, false);
}

void MidiRelease(struct DeviceFile *df, bool drop) {
  if (!df->sound->output) return;
  if (--port.outputs) return;
  if (port.level) DropQueue(SoundNow());
  look = sent;
  FreePort();
}

void ResetMidi(void) {
  FreePort();
  DefaultSynth(&sent);
  look = sent;
}

void MidiTearDown(void) {
  FreePort();
}

void MidiProgramKilled(void) {
  if (port.outputs && port.level) DropQueue(SoundNow());
}

// ------------------------------------------------------------ ioctls

static int PutWord(struct Machine *m, i64 addr, u32 value) {
  u8 word[4];
  Write32(word, value);
  return CopyToUserWrite(m, addr, word, 4) == -1 ? efault() : 0;
}

static int GetWord(struct Machine *m, i64 addr, i32 *value) {
  u8 word[4];
  if (CopyFromUserRead(m, word, addr, 4) == -1) return efault();
  *value = Read32(word);
  return 0;
}

/* snd_rawmidi_info(), for the virtual card's port. */
static int Info(struct Machine *m, struct DeviceFile *df, i64 addr) {
  u8 info[268];
  i32 stream;
  if (GetWord(m, addr + 8, &stream) == -1) return -1;
  if (stream != SNDRV_RAWMIDI_STREAM_OUTPUT &&
      stream != SNDRV_RAWMIDI_STREAM_INPUT) {
    return einval();
  }
  if (stream == SNDRV_RAWMIDI_STREAM_OUTPUT ? !df->sound->output
                                            : !df->sound->input) {
    return enodev();
  }
  memset(info, 0, sizeof(info));
  Write32(info + 0, 0);       // device
  Write32(info + 4, 0);       // subdevice
  Write32(info + 8, stream);
  Write32(info + 12, 1);      // card
  Write32(info + 16, SNDRV_RAWMIDI_INFO_FLAGS);
  strcpy((char *)info + 20, "VirMidi");
  strcpy((char *)info + 84, "Virtual Raw MIDI");
  Write32(info + 196, MIDI_SUBSTREAMS);  // subdevices_count
  Write32(info + 200, MIDI_SUBSTREAMS - 1);
  return CopyToUserWrite(m, addr, info, sizeof(info)) == -1 ? efault() : 0;
}

/* snd_rawmidi_output_params(): it drains first, then changes the buffer. */
static int Params(struct Machine *m, struct DeviceFile *df, i64 addr) {
  u8 params[48], record[9];
  i32 stream;
  u64 size, avail_min;
  u32 mode;
  u8 *ring;
  if (CopyFromUserRead(m, params, addr, sizeof(params)) == -1) return efault();
  stream = Read32(params);
  if (stream == SNDRV_RAWMIDI_STREAM_INPUT) {
    // the input's buffer changes nothing anyone can see, and errors there
    // are ignored, as snd_rawmidi_input_params() ignores them
    return df->sound->input ? 0 : einval();
  }
  if (stream != SNDRV_RAWMIDI_STREAM_OUTPUT || !df->sound->output) {
    return einval();
  }
  Drain(m, false);
  if (df->sound->append && port.outputs > 1) {
    errno = EBUSY;
    return -1;
  }
  size = Read64(params + 8);
  avail_min = Read64(params + 16);
  mode = df->sound->pversion < SNDRV_PROTOCOL_2_0_2 ? 0 : Read32(params + 28);
  if (size < 32 || size > 1024 * 1024) return einval();
  if ((mode & 7) == SNDRV_RAWMIDI_MODE_FRAMING_TSTAMP && (size & 0x1f)) {
    return einval();
  }
  if (avail_min < 1 || avail_min > size) return einval();
  record[0] = port.active_sensing;
  Write32(record + 1, port.capacity);
  Write32(record + 5, port.avail_min);
  if (size != port.capacity) {
    DropQueue(SoundNow());
    if (!(ring = (u8 *)malloc(size))) return enomem();
    free(port.ring);
    port.ring = ring;
    port.capacity = size;
    port.head = port.level = 0;
  }
  port.avail_min = avail_min;
  port.active_sensing = !(Read32(params + 24) & 1);
  if (record[0] != port.active_sensing ||
      Read32(record + 1) != port.capacity ||
      Read32(record + 5) != port.avail_min) {
    DebugHistoryJournal(JOURNAL_MIDI_PARAMS, record, sizeof(record));
  }
  return 0;
}

static int Status(struct Machine *m, struct DeviceFile *df, i64 addr,
                  bool wide) {
  u8 status[56];
  i32 stream;
  u32 avail;
  if (GetWord(m, addr, &stream) == -1) return -1;
  if (stream == SNDRV_RAWMIDI_STREAM_OUTPUT) {
    if (!df->sound->output) return einval();
    CatchUp(SoundNow());
    avail = port.capacity - port.level;
  } else if (stream == SNDRV_RAWMIDI_STREAM_INPUT) {
    if (!df->sound->input) return einval();
    avail = 0;
  } else {
    return einval();
  }
  memset(status, 0, sizeof(status));
  Write32(status, stream);
  if (wide) {
    Write64(status + 24, avail);
  } else {
    Write32(status + 12, avail);
  }
  return CopyToUserWrite(m, addr, status, wide ? 56 : 36) == -1 ? efault() : 0;
}

/* snd_rawmidi_ioctl(): ENOTTY for anything not of type 'W'. */
int MidiIoctl(struct Machine *m, int fildes, u64 request, i64 addr) {
  u8 record[12];
  i32 value;
  u32 cmd = request;
  struct DeviceFile *df;
  if (!(df = SoundDeviceFile(fildes)) || !df->sound) return ebadf();
  if (((cmd >> 8) & 0xff) != 'W') return enotty();
  switch (cmd) {
    case SNDRV_RAWMIDI_IOCTL_PVERSION:
      return PutWord(m, addr, SNDRV_RAWMIDI_VERSION);
    case SNDRV_RAWMIDI_IOCTL_INFO:
      return Info(m, df, addr);
    case SNDRV_RAWMIDI_IOCTL_USER_PVERSION:
      if (GetWord(m, addr, &value) == -1) return -1;
      if ((u32)value != df->sound->pversion) {
        memcpy(record, &df, sizeof(df));
        Write32(record + 8, df->sound->pversion);
        DebugHistoryJournal(JOURNAL_MIDI_PVERSION, record, sizeof(record));
        df->sound->pversion = value;
      }
      return 0;
    case SNDRV_RAWMIDI_IOCTL_PARAMS:
      return Params(m, df, addr);
    case SNDRV_RAWMIDI_IOCTL_STATUS64:
      return Status(m, df, addr, true);
    case SNDRV_RAWMIDI_IOCTL_STATUS32:
      return Status(m, df, addr, false);
    case SNDRV_RAWMIDI_IOCTL_DROP:
      if (GetWord(m, addr, &value) == -1) return -1;
      if (value != SNDRV_RAWMIDI_STREAM_OUTPUT || !df->sound->output) {
        return einval();
      }
      // a stop: Undo does not bring back what it dropped
      DropQueue(SoundNow());
      return 0;
    case SNDRV_RAWMIDI_IOCTL_DRAIN:
      if (GetWord(m, addr, &value) == -1) return -1;
      if (value == SNDRV_RAWMIDI_STREAM_OUTPUT && df->sound->output) {
        return Drain(m, true);
      }
      if (value == SNDRV_RAWMIDI_STREAM_INPUT && df->sound->input) return 0;
      return einval();
    default:
      return enotty();
  }
}

// ------------------------------------------------------------ poll, waits

/* snd_rawmidi_poll(): writable while avail_min bytes are free; nothing ever
 * arrives to read. */
int MidiPoll(struct pollfd *fds, nfds_t nfds, int timeout) {
  nfds_t i;
  int ready;
  struct DeviceFile *df;
  for (ready = i = 0; i < nfds; ++i) {
    fds[i].revents = 0;
    if ((df = SoundDeviceFile(fds[i].fd)) && df->sound && df->sound->output) {
      CatchUp(SoundNow());
      if (port.capacity - port.level >= port.avail_min) {
        fds[i].revents = fds[i].events & POLLOUT;
      }
    }
    if (fds[i].revents) ++ready;
  }
  return ready;
}

i64 MidiReadyDeadline(struct DeviceFile *df, int events) {
  i64 now;
  if (!(events & POLLOUT) || !df->sound->output) return -1;
  now = SoundNow();
  CatchUp(now);
  return RoomTime(port.avail_min, now);
}

// ------------------------------------------------------------ undo

void UndoMidiJournal(u32 kind, const u8 *data, u32 size) {
  u32 queued, unsent, read, at, offset, length;
  i64 now, cut;
  struct DeviceFile *df;
  struct MidiSynth heard;
  const u8 **diffs;
  u32 count, i;
  switch (kind) {
    case JOURNAL_MIDI_PVERSION:
      memcpy(&df, data, sizeof(df));
      df->sound->pversion = Read32(data + 8);
      break;
    case JOURNAL_MIDI_PARAMS:
      if (Read32(data + 1) != port.capacity && port.ring) {
        u8 *ring = (u8 *)malloc(Read32(data + 1));
        if (ring) {
          DropQueue(SoundNow());
          free(port.ring);
          port.ring = ring;
          port.capacity = Read32(data + 1);
          port.head = port.level = 0;
        }
      }
      port.active_sensing = data[0];
      port.avail_min = Read32(data + 5);
      break;
    case JOURNAL_MIDI_WRITE:
      queued = Read32(data);
      now = SoundNow();
      CatchUp(now);
      // the write's bytes that have not left are taken back
      unsent = MIN(queued, port.level);
      port.level -= unsent;
      cut = MAX(now, (i64)Read64(data + 4));
      SoundEmitCut(cut, SOUND_MIDI);
      // what the queue's messages told the synthesizer goes back
      read = Read16(data + 14);
      at = 18 + read;
      for (count = 0, offset = at; offset < size; ++count) {
        offset += 4 + Read16(data + offset + 2);
      }
      if ((diffs = (const u8 **)malloc(MAX(count, 1) * sizeof(*diffs)))) {
        for (i = 0, offset = at; i < count; ++i) {
          diffs[i] = data + offset;
          offset += 4 + Read16(data + offset + 2);
        }
        for (i = count; i > 0; --i) {
          length = Read16(diffs[i - 1] + 2);
          memcpy((u8 *)&look + Read16(diffs[i - 1]), diffs[i - 1] + 4, length);
        }
        free(diffs);
      }
      port.look_parser.type = data[12];
      port.look_parser.qlen = (i8)data[13];
      port.look_parser.read = read;
      port.look_parser.overflow = Read16(data + 16);
      memcpy(port.look_parser.buf, data + 18, read);
      if (unsent < queued) {
        // some of it reached the synthesizer: everything before it did too,
        // and what it set is set back from what was heard
        heard = sent;
        sent = look;
        port.sent_parser = port.look_parser;
        EmitRestore(cut, &heard, &look);
      }
      break;
    default:
      break;
  }
}
