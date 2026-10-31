/* /dev/dsp and /dev/mixer: OSS sampled sound and the OSS mixer, as Linux
 * 7.2's snd-pcm-oss and snd-mixer-oss emulate them on the guest's HDA card,
 * QEMU's hda-duplex codec behind its ICH6 controller (intel-hda), card 0
 * (x86-devices.md, "What /dev/dsp accepts", "/dev/dsp's buffer and pacing";
 * docs/research/x86-reference-guest.md). FluidSynth plays on a USB card of
 * its own, so /dev/dsp is the program's.
 *
 * The card plays 16-bit stereo at 16 to 96 kHz only, so snd-pcm-oss converts
 * what the program writes through a chain of plugins: format, channels and,
 * when the card lacks the program's rate, a rate converter. The fragment
 * size a program sees comes out of that conversion, and the kernel computes
 * part of it with the chain of the configuration before, which is why the
 * order of SETFMT, CHANNELS and SPEED can change it; ApplyParams() follows
 * snd_pcm_oss_change_params_locked() and snd_pcm_oss_period_size() step by
 * step for that reason. The samples themselves leave Blink at the program's
 * rate, decoded to stereo floats: the host resamples, as the rate plugin
 * would, and keeps the first two channels, as the route plugin does.
 *
 * Nothing here ticks. The card's ring holds frames that play at its rate from
 * the moment the stream started, so what has played, what is free and when a
 * wait ends are all worked out from Program time when a call asks
 * (x86-devices-plan.md, decision 8). */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
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

// <linux/soundcard.h>'s formats.
#define AFMT_QUERY      0x00000000
#define AFMT_MU_LAW     0x00000001
#define AFMT_U8         0x00000008
#define AFMT_S16_LE     0x00000010
#define AFMT_S16_BE     0x00000020
#define AFMT_S8         0x00000040
#define AFMT_U16_LE     0x00000080
#define AFMT_U16_BE     0x00000100
#define AFMT_S32_LE     0x00001000
#define AFMT_S32_BE     0x00002000
#define AFMT_S24_LE     0x00008000
#define AFMT_S24_BE     0x00010000
#define AFMT_S24_PACKED 0x00040000

// What SNDCTL_DSP_GETFMTS answers through the plugins: snd-pcm-oss's fixed
// mask, which has no A-law.
#define OSS_FORMATS                                                     \
  (AFMT_MU_LAW | AFMT_U8 | AFMT_S16_LE | AFMT_S16_BE | AFMT_S8 |        \
   AFMT_U16_LE | AFMT_U16_BE | AFMT_S32_LE | AFMT_S32_BE | AFMT_S24_LE | \
   AFMT_S24_BE | AFMT_S24_PACKED)

#define SNDCTL_DSP_RESET          0x00005000
#define SNDCTL_DSP_SYNC           0x00005001
#define SNDCTL_DSP_SPEED          0xc0045002
#define SNDCTL_DSP_STEREO         0xc0045003
#define SNDCTL_DSP_GETBLKSIZE     0xc0045004
#define SNDCTL_DSP_SETFMT         0xc0045005
#define SNDCTL_DSP_CHANNELS       0xc0045006
#define SOUND_PCM_WRITE_FILTER    0xc0045007
#define SNDCTL_DSP_POST           0x00005008
#define SNDCTL_DSP_SUBDIVIDE      0xc0045009
#define SNDCTL_DSP_SETFRAGMENT    0xc004500a
#define SNDCTL_DSP_GETFMTS        0x8004500b
#define SNDCTL_DSP_GETOSPACE      0x8010500c
#define SNDCTL_DSP_GETISPACE      0x8010500d
#define SNDCTL_DSP_NONBLOCK       0x0000500e
#define SNDCTL_DSP_GETCAPS        0x8004500f
#define SNDCTL_DSP_GETTRIGGER     0x80045010
#define SNDCTL_DSP_SETTRIGGER     0x40045010
#define SNDCTL_DSP_GETIPTR        0x800c5011
#define SNDCTL_DSP_GETOPTR        0x800c5012
#define SNDCTL_DSP_MAPINBUF       0x80105013
#define SNDCTL_DSP_MAPOUTBUF      0x80105014
#define SNDCTL_DSP_SETSYNCRO      0x00005015
#define SNDCTL_DSP_SETDUPLEX      0x00005016
#define SNDCTL_DSP_GETODELAY      0x80045017
#define SNDCTL_DSP_PROFILE        0x40045017
#define SOUND_PCM_READ_RATE       0x80045002
#define SOUND_PCM_READ_CHANNELS   0x80045006
#define SOUND_PCM_READ_BITS       0x80045005
#define SOUND_PCM_READ_FILTER     0x80045007
#define OSS_GETVERSION            0x80044d76
#define OSS_ALSAEMULVER           0x80044df9
#define SOUND_MIXER_INFO          0x805c4d65
#define SOUND_OLD_MIXER_INFO      0x80304d65
#define SOUND_MIXER_READ_RECSRC   0x80044dff
#define SOUND_MIXER_WRITE_RECSRC  0xc0044dff
#define SOUND_MIXER_READ_DEVMASK  0x80044dfe
#define SOUND_MIXER_READ_RECMASK  0x80044dfd
#define SOUND_MIXER_READ_CAPS     0x80044dfc
#define SOUND_MIXER_READ_STEREODEVS 0x80044dfb
#define SIOC_IN                   0x40000000
#define SIOC_OUT                  0x80000000

#define SNDRV_OSS_VERSION 0x030810  // 3.8.1a
#define PCM_ENABLE_OUTPUT 2
#define DSP_CAP_DUPLEX    0x00000100
#define DSP_CAP_REALTIME  0x00000200
#define DSP_CAP_TRIGGER   0x00001000

// QEMU's hda-duplex codec through hda_intel on an ICH6 controller: 16-bit
// stereo at the codec's rates, a buffer of at most AZX_MAX_BUF_SIZE (4 MiB),
// periods of 128 bytes up to half of it, 2 to AZX_MAX_FRAG (32) of them, and
// no 128-byte alignment (AZX_DCAPS_NO_ALIGN_BUFSIZE).
#define SLAVE_FRAME_BYTES   4
#define SLAVE_BUFFER_FRAMES (4 * 1024 * 1024 / SLAVE_FRAME_BYTES)
#define SLAVE_PERIOD_MIN    (128 / SLAVE_FRAME_BYTES)
#define SLAVE_PERIOD_MAX    (SLAVE_BUFFER_FRAMES / 2)
#define SLAVE_PERIODS_MAX   32
static const u32 kSlaveRates[] = {16000, 22050, 32000, 44100,
                                  48000, 88200, 96000};

// The rate plugin's fixed point (sound/core/oss/rate.c).
#define RATE_SHIFT 11
#define RATE_BITS  (1 << RATE_SHIFT)

#define DSP_SETUP    0  // configured, not prepared: SNDRV_PCM_STATE_SETUP
#define DSP_PREPARED 1
#define DSP_RUNNING  2
#define DSP_XRUN     3  // it played everything it was given

// The rate conversion plugin of the chain snd-pcm-oss built last, which the
// next configuration computes some of its sizes with, and the pair of frame
// counts it remembers to scale exactly by powers of two.
struct RatePlugin {
  bool present;
  u32 src_rate, dst_rate, pitch;
  i64 old_src_frames, old_dst_frames;
};

// Everything about the playback substream but the staged bytes. Undo puts it
// back from a copy, so it holds no pointers.
struct DspState {
  // what the program set (runtime->oss), and whether it still has to be
  // applied (params) or the stream prepared (prepare)
  u32 format, channels, rate;
  u32 fragshift, maxfrags, subdivision;
  bool params, prepare;
  // the configuration applied last
  u32 slave_rate, slave_period, periods;
  u32 period_bytes, frame_bytes;
  u64 buffer_bytes, capacity;  // OSS bytes; the card's ring in its frames
  struct RatePlugin plug;
  // the fragment being staged (runtime->oss.buffer)
  u32 buffer_used, period_ptr;
  u64 bytes;  // runtime->oss.bytes: every byte the card was given
  // the card's ring: `written` frames since it was prepared, the first heard
  // at `t0` once it runs
  u8 state;
  u32 segment;
  i64 t0;
  u64 written;
};

static struct DspState dsp;
static u8 *staging;
static struct DeviceFile *owner;  // the description holding playback

// The mixer: a channel's levels, 0 to 100 for each side.
struct MixerSlot {
  bool present, stereo;
  u8 left, right;
};

#define MIXER_SLOTS  31
#define MIXER_VOLUME 0
#define MIXER_PCM    4
#define MIXER_IGAIN  12

static struct MixerSlot mixer[MIXER_SLOTS];
static u32 mixer_changes;

// SOUND_MIXER_INFO's modify_counter on the guest before any program writes
// the mixer: the changes alsactl init and the boot made to card 0.
#define MIXER_CHANGES_AT_BOOT 14

// ------------------------------------------------------------ formats

static u32 FormatFrom(u32 format) {
  switch (format) {
    case AFMT_MU_LAW:
    case AFMT_U8:
    case AFMT_S16_LE:
    case AFMT_S16_BE:
    case AFMT_S8:
    case AFMT_U16_LE:
    case AFMT_U16_BE:
    case AFMT_S32_LE:
    case AFMT_S32_BE:
    case AFMT_S24_LE:
    case AFMT_S24_BE:
    case AFMT_S24_PACKED:
      return format;
    default:
      return AFMT_U8;  // snd_pcm_oss_format_from()'s default
  }
}

static u32 PhysicalWidth(u32 format) {
  switch (format) {
    case AFMT_MU_LAW:
    case AFMT_U8:
    case AFMT_S8:
      return 8;
    case AFMT_S16_LE:
    case AFMT_S16_BE:
    case AFMT_U16_LE:
    case AFMT_U16_BE:
      return 16;
    case AFMT_S24_PACKED:
      return 24;
    default:
      return 32;
  }
}

// ALSA's ulaw2linear().
static int MulawToLinear(u8 u) {
  int t;
  u = ~u;
  t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return (u & 0x80) ? 0x84 - t : t - 0x84;
}

static float Sample(const u8 *p) {
  switch (dsp.format) {
    case AFMT_MU_LAW:
      return MulawToLinear(p[0]) / 32768.f;
    case AFMT_U8:
      return (p[0] - 128) / 128.f;
    case AFMT_S8:
      return (i8)p[0] / 128.f;
    case AFMT_S16_LE:
      return (i16)(p[0] | p[1] << 8) / 32768.f;
    case AFMT_S16_BE:
      return (i16)(p[1] | p[0] << 8) / 32768.f;
    case AFMT_U16_LE:
      return ((p[0] | p[1] << 8) - 32768) / 32768.f;
    case AFMT_U16_BE:
      return ((p[1] | p[0] << 8) - 32768) / 32768.f;
    case AFMT_S24_LE:
      return (i32)((u32)(p[0] | p[1] << 8 | p[2] << 16) << 8) / 2147483648.f;
    case AFMT_S24_BE:
      return (i32)((u32)(p[3] | p[2] << 8 | p[1] << 16) << 8) / 2147483648.f;
    case AFMT_S24_PACKED:
      return (i32)((u32)(p[0] | p[1] << 8 | p[2] << 16) << 8) / 2147483648.f;
    case AFMT_S32_LE:
      return (i32)Read32(p) / 2147483648.f;
    case AFMT_S32_BE:
      return (i32)((u32)p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]) /
             2147483648.f;
    default:
      return 0;
  }
}

/* Fills `size` bytes with the format's silence, as
 * snd_pcm_format_set_silence() does. */
static void SetSilence(u8 *p, u32 size) {
  u32 i;
  switch (dsp.format) {
    case AFMT_U8:
      memset(p, 0x80, size);
      break;
    case AFMT_MU_LAW:
      memset(p, 0x7f, size);
      break;
    case AFMT_U16_LE:
      for (i = 0; i < size; ++i) p[i] = i & 1 ? 0x80 : 0;
      break;
    case AFMT_U16_BE:
      for (i = 0; i < size; ++i) p[i] = i & 1 ? 0 : 0x80;
      break;
    default:
      memset(p, 0, size);
      break;
  }
}

/* Hands the host `frames` frames the program wrote, starting at `start`: its
 * first two channels as the route plugin keeps them, a mono stream on both
 * sides, at the program's rate. */
static void EmitFrames(i64 start, const u8 *data, u32 frames) {
  u32 i, sample;
  float *out;
  if (!frames || !(out = (float *)malloc(frames * 2 * sizeof(float)))) return;
  sample = PhysicalWidth(dsp.format) / 8;
  for (i = 0; i < frames; ++i) {
    const u8 *frame = data + (u64)i * dsp.frame_bytes;
    out[i * 2] = Sample(frame);
    out[i * 2 + 1] = dsp.channels > 1 ? Sample(frame + sample) : out[i * 2];
  }
  SoundEmitPcm(start, dsp.rate, out, frames);
  free(out);
}

// ------------------------------------------------------------ the plugins

static i64 DivRoundClosest(u64 x, u64 d) {
  return (x + d / 2) / d;
}

// rate_src_frames(): the program's frames for `frames` of the card's.
static i64 RateSrcFrames(struct RatePlugin *r, i64 frames) {
  i64 res, frames1, res1;
  if (!frames) return 0;
  if (r->src_rate < r->dst_rate) {
    res = (((u64)frames * r->pitch) + RATE_BITS / 2) >> RATE_SHIFT;
  } else {
    res = DivRoundClosest((u64)frames << RATE_SHIFT, r->pitch);
  }
  if (r->old_src_frames > 0) {
    frames1 = frames;
    res1 = r->old_dst_frames;
    while (r->old_src_frames < frames1) {
      frames1 >>= 1;
      res1 <<= 1;
    }
    while (r->old_src_frames > frames1) {
      frames1 <<= 1;
      res1 >>= 1;
    }
    if (r->old_src_frames == frames1) return res1;
  }
  r->old_src_frames = frames;
  r->old_dst_frames = res;
  return res;
}

// rate_dst_frames(): the card's frames for `frames` of the program's.
static i64 RateDstFrames(struct RatePlugin *r, i64 frames) {
  i64 res, frames1, res1;
  if (!frames) return 0;
  if (r->src_rate < r->dst_rate) {
    res = DivRoundClosest((u64)frames << RATE_SHIFT, r->pitch);
  } else {
    res = (((u64)frames * r->pitch) + RATE_BITS / 2) >> RATE_SHIFT;
  }
  if (r->old_dst_frames > 0) {
    frames1 = frames;
    res1 = r->old_src_frames;
    while (r->old_dst_frames < frames1) {
      frames1 >>= 1;
      res1 <<= 1;
    }
    while (r->old_dst_frames > frames1) {
      frames1 <<= 1;
      res1 >>= 1;
    }
    if (r->old_dst_frames == frames1) return res1;
  }
  r->old_dst_frames = frames;
  r->old_src_frames = res;
  return res;
}

// snd_pcm_plug_client_size() and snd_pcm_plug_slave_size(): only the rate
// plugin changes a frame count.
static i64 ClientSize(struct RatePlugin *r, i64 frames) {
  return r->present && frames > 0 ? RateSrcFrames(r, frames) : frames;
}

static i64 SlaveSize(struct RatePlugin *r, i64 frames) {
  return r->present && frames > 0 ? RateDstFrames(r, frames) : frames;
}

static struct RatePlugin NewRatePlugin(u32 client, u32 slave) {
  struct RatePlugin r;
  memset(&r, 0, sizeof(r));
  if (client == slave) return r;
  r.present = true;
  r.src_rate = client;
  r.dst_rate = slave;
  if (client < slave) {
    r.pitch = ((client << RATE_SHIFT) + (slave >> 1)) / slave;
  } else {
    r.pitch = ((slave << RATE_SHIFT) + (client >> 1)) / client;
  }
  return r;
}

static i64 RounddownPow2(i64 x) {
  i64 p = 1;
  while (p <= x / 2) p <<= 1;
  return p;
}

static i64 RoundupPow2(i64 x) {
  i64 p = 1;
  while (p < x) p <<= 1;
  return p;
}

/* choose_rate(): the first multiple of the program's rate the card plays,
 * else the card's rate nearest it, the higher on a tie. */
static u32 ChooseRate(u32 rate) {
  u64 multiple;
  u32 i, below = 0, above = 0;
  for (multiple = rate; multiple <= 96000; multiple += rate) {
    for (i = 0; i < ARRAYLEN(kSlaveRates); ++i) {
      if (kSlaveRates[i] == multiple) return multiple;
    }
  }
  for (i = 0; i < ARRAYLEN(kSlaveRates); ++i) {
    if (kSlaveRates[i] <= rate) below = kSlaveRates[i];
    if (kSlaveRates[i] >= rate && !above) above = kSlaveRates[i];
  }
  if (!above) return below;
  if (!below) return above;
  return rate - below < above - rate ? below : above;
}

// ------------------------------------------------------------ the ring

static u64 Played(i64 now) {
  unsigned __int128 n;
  if (dsp.state == DSP_XRUN) return dsp.written;
  if (dsp.state != DSP_RUNNING || now <= dsp.t0) return 0;
  n = (unsigned __int128)(now - dsp.t0) * dsp.slave_rate / 1000000000;
  return n < dsp.written ? (u64)n : dsp.written;
}

/* A stream that played everything it was given stops, as ALSA's does with
 * the stop threshold snd-pcm-oss sets: the next write starts it again. */
static void UpdateRing(i64 now) {
  if (dsp.state == DSP_RUNNING && Played(now) >= dsp.written) {
    dsp.state = DSP_XRUN;
  }
}

static u64 Queued(i64 now) {
  return dsp.state == DSP_RUNNING ? dsp.written - Played(now) : 0;
}

/* When the card's frame `frame` of the running stream plays. */
static i64 FrameTime(u64 frame) {
  return dsp.t0 + (i64)((unsigned __int128)frame * 1000000000 / dsp.slave_rate);
}

/* The first moment the card has played `frame` frames. */
static i64 PlayedBy(u64 frame) {
  return dsp.t0 + (i64)(((unsigned __int128)frame * 1000000000 +
                         dsp.slave_rate - 1) /
                        dsp.slave_rate);
}

/* When `frames` of the ring are free. */
static i64 RoomDeadline(u64 frames, i64 now) {
  if (dsp.state != DSP_RUNNING) return now;
  if (frames > dsp.capacity) frames = dsp.capacity;
  if (Queued(now) + frames <= dsp.capacity) return now;
  return PlayedBy(dsp.written + frames - dsp.capacity);
}

// snd_pcm_oss_bytes(): the card's frames as OSS bytes.
static i64 OssBytes(u64 frames) {
  u64 slave = dsp.capacity * SLAVE_FRAME_BYTES;
  u64 bytes = frames * SLAVE_FRAME_BYTES;
  if (!slave || slave == dsp.buffer_bytes) return bytes;
  return (i64)((unsigned __int128)dsp.buffer_bytes * bytes / slave);
}

// ------------------------------------------------------------ passes

/* What a call does to the substream is journaled as one record: the state
 * it found, the staged bytes when it disturbs them, whether it dropped
 * frames that had not played, and when the first frame it gave the card
 * plays. A call that halts to wait makes one record each time it runs. */
struct DspPass {
  struct DspState before;
  u8 *staged;
  u32 staged_size;
  bool saved, transferred, dropped;
  i64 first_frame;
  i64 halt_at;  // when a call that has to wait can go on
};

#define PASS_TRANSFERRED 1
#define PASS_DROPPED     2

// A call that has to wait returns this, with the time in its pass.
#define DSP_HALT (-2)

static void BeginPass(struct DspPass *p) {
  memset(p, 0, sizeof(*p));
  p->before = dsp;
  p->first_frame = -1;
}

/* Keeps the bytes staged when the call began, before it lets any of them
 * go: an appended byte never overwrites them before that. */
static void SaveStaging(struct DspPass *p) {
  if (p->saved) return;
  p->saved = true;
  if (!p->before.buffer_used || !staging) return;
  if ((p->staged = (u8 *)malloc(p->before.buffer_used))) {
    memcpy(p->staged, staging, p->before.buffer_used);
    p->staged_size = p->before.buffer_used;
  }
}

static void EndPass(struct DspPass *p) {
  u8 *record;
  u32 size;
  if (memcmp(&dsp, &p->before, sizeof(dsp)) || p->transferred || p->dropped) {
    size = sizeof(p->before) + 1 + 8 + 4 + p->staged_size;
    if ((record = (u8 *)malloc(size))) {
      memcpy(record, &p->before, sizeof(p->before));
      record[sizeof(p->before)] = (p->transferred ? PASS_TRANSFERRED : 0) |
                                  (p->dropped ? PASS_DROPPED : 0);
      Write64(record + sizeof(p->before) + 1, p->first_frame);
      Write32(record + sizeof(p->before) + 9, p->staged_size);
      memcpy(record + sizeof(p->before) + 13, p->staged, p->staged_size);
      DebugHistoryJournal(JOURNAL_DSP_PASS, record, size);
      free(record);
    }
  }
  free(p->staged);
  p->staged = 0;
}

/* SNDRV_PCM_IOCTL_DROP: what the ring holds is gone, unplayed. */
static void DropRing(struct DspPass *p, i64 now) {
  UpdateRing(now);
  if (Queued(now)) {
    SoundEmitCut(now, SOUND_DSP);
    p->dropped = true;
  }
  dsp.state = DSP_SETUP;
  dsp.written = 0;
  dsp.t0 = 0;
  ++dsp.segment;
}

/* snd_pcm_oss_prepare(). */
static void Prepare(struct DspPass *p) {
  SaveStaging(p);
  dsp.state = DSP_PREPARED;
  dsp.written = 0;
  dsp.t0 = 0;
  ++dsp.segment;
  dsp.prepare = false;
  dsp.buffer_used = 0;
  dsp.period_ptr = 0;
}

/* snd_pcm_plug_alloc(): a period's buffer for each plugin of the chain
 * snd_pcm_plug_format_plugins() builds but the first, each in its source
 * format, which snd_pcm_plugin_alloc() refuses with ENOMEM past 1024 × 1024,
 * a limit it checks in bits: so a long fragment the card took fails here,
 * and every call that applies the settings fails the same way until they
 * change. The chain into the card's S16 stereo: µ-law decoded when the rate
 * changes, channels past two dropped, S16 for the rate plugin and the rate
 * plugin, the card's format, mono made stereo. The rate plugin's frames are
 * the program's, the plugins after it the card's. */
static bool PluginBuffersFit(struct RatePlugin *plug, u32 format, i64 frames) {
  int plugins = 0;
  u32 width = PhysicalWidth(format), channels = dsp.channels;
  bool fit = true;
#define PLUGIN(WIDTH, CHANNELS)                                          \
  do {                                                                   \
    if (plugins++ && (u64)frames * (CHANNELS) * (WIDTH) > 1024 * 1024) { \
      fit = false;                                                       \
    }                                                                    \
  } while (0)
  if (plug->present && format == AFMT_MU_LAW) {
    PLUGIN(width, channels);
    width = 16;
    format = AFMT_S16_LE;
  }
  if (channels > 2) {
    PLUGIN(width, channels);
    channels = 2;
  }
  if (plug->present) {
    if (format != AFMT_S16_LE) {
      PLUGIN(width, channels);
      width = 16;
      format = AFMT_S16_LE;
    }
    PLUGIN(width, channels);
    // the plugin after it, if any, asks it how many frames it makes
    if (channels < 2) frames = RateDstFrames(plug, frames);
  }
  if (format != AFMT_S16_LE) {
    PLUGIN(width, channels);
    width = 16;
    format = AFMT_S16_LE;
  }
  if (channels < 2) PLUGIN(width, channels);
#undef PLUGIN
  return fit;
}

/* snd_pcm_oss_change_params_locked(), with snd_pcm_oss_period_size(): the
 * fragment size and count for what the program set, part of it computed
 * through the chain of the configuration before. */
static int ApplyParams(struct DspPass *p, i64 now) {
  u8 *grown;
  u32 format, width, frame, slave_rate, sd;
  i64 buffer, period, minp, maxp, periods, s, n, speriod, speriods, client;
  struct RatePlugin *old = &dsp.plug, plug;
  if (!dsp.params) return 0;
  format = FormatFrom(dsp.format);
  width = PhysicalWidth(format);
  frame = width * dsp.channels / 8;
  slave_rate = ChooseRate(dsp.rate);
  buffer = ClientSize(old, (i64)SLAVE_BUFFER_FRAMES * frame);
  if (buffer <= 0) goto Invalid;
  buffer = RounddownPow2(buffer);
  if (dsp.fragshift) {
    period = (i64)1 << dsp.fragshift;
    if (period > buffer / 2) period = buffer / 2;
  } else {
    i64 bytes_per_second = (i64)dsp.rate * width * dsp.channels / 8;
    period = buffer;
    do {
      period /= 2;
    } while (period > bytes_per_second);
    if (!dsp.subdivision) {
      sd = 4;
      if (period / sd > 4096) sd *= 2;
      if (period / sd < 4096) sd = 1;
    } else {
      sd = dsp.subdivision;
    }
    period /= sd;
    if (period < 16) period = 16;
  }
  minp = ClientSize(old, SLAVE_PERIOD_MIN);
  if (minp > 0) {
    minp = RoundupPow2(minp * frame);
    if (period < minp) period = minp;
  }
  maxp = ClientSize(old, SLAVE_PERIOD_MAX);
  if (maxp > 0) {
    maxp = RounddownPow2(maxp * frame);
    if (period > maxp) period = maxp;
  }
  periods = buffer / period;
  s = SLAVE_PERIODS_MAX;
  if (dsp.maxfrags && s > dsp.maxfrags) s = dsp.maxfrags;
  if (periods > s) periods = s;
  if (periods < 2) periods = 2;
  while (period * periods > buffer) period /= 2;
  if (period < 16) goto Invalid;
  if (period > 1024 * 1024) {
    errno = ENOMEM;
    goto Failed;
  }
  // the card's period nearest the fragment, and as many of them as fit
  n = SlaveSize(old, period / frame);
  speriod = MAX(SLAVE_PERIOD_MIN, MIN(SLAVE_PERIOD_MAX, n));
  speriods = MIN(periods, MIN(SLAVE_PERIODS_MAX, SLAVE_BUFFER_FRAMES / speriod));
  if (speriods < 2) speriods = 2;
  DropRing(p, now);
  plug = NewRatePlugin(dsp.rate, slave_rate);
  if ((client = ClientSize(&plug, speriod)) <= 0) goto Invalid;
  if (!PluginBuffersFit(&plug, format, client)) {
    errno = ENOMEM;
    goto Failed;
  }
  SaveStaging(p);
  if (!(grown = (u8 *)realloc(staging, client * frame))) {
    errno = ENOMEM;
    goto Failed;
  }
  staging = grown;
  dsp.format = format;
  dsp.plug = plug;
  dsp.slave_rate = slave_rate;
  dsp.slave_period = speriod;
  dsp.periods = speriods;
  dsp.frame_bytes = frame;
  dsp.period_bytes = client * frame;
  dsp.buffer_bytes = (u64)dsp.period_bytes * speriods;
  dsp.capacity = (u64)speriod * speriods;
  dsp.params = false;
  dsp.prepare = true;
  dsp.buffer_used = 0;
  dsp.period_ptr = 0;
  return 0;
Invalid:
  errno = EINVAL;
Failed:
  // snd_pcm_oss_release_buffers(): the staged bytes and the chain go
  SaveStaging(p);
  memset(&dsp.plug, 0, sizeof(dsp.plug));
  dsp.buffer_used = 0;
  dsp.period_ptr = 0;
  return -1;
}

static int MakeReady(struct DspPass *p, i64 now) {
  if (dsp.params && ApplyParams(p, now) == -1) return -1;
  if (dsp.prepare) Prepare(p);
  return 0;
}

// How Write2() gives the card frames it has no room for.
#define WRITE_BLOCK    0  // it waits for room
#define WRITE_NONBLOCK 1  // it gives what fits
#define WRITE_FORCE    2  // it gives them all: the program has ended

/* Gives the card up to `bytes` bytes of whole frames at `data`, after what
 * it holds, as the plugins' transfer to ALSA does. Returns the bytes it took,
 * 0 when there is no room, or DSP_HALT when it has to wait for room. */
static i64 Write2(struct DspPass *p, const u8 *data, u32 bytes, int mode,
                  i64 now) {
  u32 frames;
  u64 slave, room;
  i64 client, start;
  if (!(frames = bytes / dsp.frame_bytes)) return 0;
  UpdateRing(now);
  if (dsp.state == DSP_XRUN) {
    // snd_pcm_oss_write3() prepares a stream that ran dry
    dsp.state = DSP_PREPARED;
    dsp.written = 0;
    ++dsp.segment;
  }
  slave = SlaveSize(&dsp.plug, frames);
  room = dsp.capacity - Queued(now);
  if (room < slave && mode != WRITE_FORCE) {
    if (mode == WRITE_BLOCK) {
      p->halt_at = RoomDeadline(slave, now);
      return DSP_HALT;
    }
    if (!room) return 0;
    slave = room;
  }
  client = ClientSize(&dsp.plug, slave);
  if (client > frames) client = frames;
  if (dsp.state != DSP_RUNNING) {
    // the start threshold is a frame
    dsp.state = DSP_RUNNING;
    dsp.t0 = now;
  }
  start = FrameTime(dsp.written);
  EmitFrames(start, data, client);
  dsp.written += slave;
  dsp.bytes += (u64)client * dsp.frame_bytes;
  if (!p->transferred) p->first_frame = start;
  p->transferred = true;
  return client * dsp.frame_bytes;
}

/* Reads `size` bytes at `offset` of what the segments hold together. */
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

/* snd_pcm_oss_write1(): a write stages bytes until a fragment is full and
 * gives the card whole fragments, so a short write stays silent until the
 * fragment fills, SYNC or close. `df->progress` counts the bytes taken,
 * across the times Blink starts a write that waited over. */
static i64 Write1(struct Machine *m, struct DeviceFile *df,
                  const struct GuestSegment *segments, u32 count, u64 size,
                  bool nonblock, struct DspPass *p) {
  i64 tmp = 0, now;
  u64 rest, n;
  while (df->progress < size) {
    now = SoundNow();
    if (MakeReady(p, now) == -1) {
      tmp = -1;
      break;
    }
    rest = size - df->progress;
    if (rest < dsp.period_bytes || dsp.buffer_used > 0) {
      n = MIN(rest, dsp.period_bytes - dsp.buffer_used);
      if (n) {
        if (CopySegments(m, segments, count, df->progress,
                         staging + dsp.buffer_used, n) == -1) {
          tmp = -1;
          break;
        }
        dsp.buffer_used += n;
        df->progress += n;
      }
      if (dsp.buffer_used == dsp.period_bytes) {
        SaveStaging(p);
        tmp = Write2(p, staging + dsp.period_ptr,
                     dsp.buffer_used - dsp.period_ptr,
                     nonblock ? WRITE_NONBLOCK : WRITE_BLOCK, now);
        if (tmp == DSP_HALT) return DSP_HALT;
        if (tmp <= 0) {
          errno = EAGAIN;
          tmp = -1;
          break;
        }
        dsp.period_ptr = (dsp.period_ptr + tmp) % dsp.period_bytes;
        if (!dsp.period_ptr) {
          dsp.buffer_used = 0;
        } else if (nonblock) {
          errno = EAGAIN;
          tmp = -1;
          break;
        }
      }
    } else {
      // a whole fragment straight from the program's buffer; the staging
      // buffer is empty, so it holds it on the way
      SaveStaging(p);
      if (CopySegments(m, segments, count, df->progress, staging,
                       dsp.period_bytes) == -1) {
        tmp = -1;
        break;
      }
      tmp = Write2(p, staging, dsp.period_bytes,
                   nonblock ? WRITE_NONBLOCK : WRITE_BLOCK, now);
      if (tmp == DSP_HALT) return DSP_HALT;
      if (tmp <= 0) {
        errno = EAGAIN;
        tmp = -1;
        break;
      }
      df->progress += tmp;
      if (nonblock && tmp != dsp.period_bytes) {
        errno = EAGAIN;
        tmp = -1;
        break;
      }
    }
    tmp = 0;
    // a signal ends the write with what it took, at a fragment's end
    if (df->progress < size && (m->signals & ~m->sigmask)) break;
  }
  return df->progress > 0 ? (i64)df->progress : tmp;
}

static i64 FinishWrite(struct DeviceFile *df, i64 rc) {
  df->progress = 0;
  df->progress_identity = 0;
  return rc;
}

/* Halts the call until the time its pass waits for, room or the end of the
 * buffer; the instruction starts over then. */
static _Noreturn void HaltPass(struct Machine *m, struct DspPass *p) {
  GuestWaitHaltWake(m, GetMaxTime(), 0, DeviceTimespec(p->halt_at));
}

i64 OssWrite(struct Machine *m, struct DeviceFile *df,
             const struct GuestSegment *segments, u32 count, int oflags) {
  u32 i;
  i64 rc;
  u64 size, identity;
  struct DspPass p;
  if (!df->sound->playback) {
    errno = ENXIO;
    return -1;
  }
  for (size = i = 0; i < count; ++i) size += segments[i].len;
  if (!size) return 0;
  identity = blinkenlib_active_instruction();
  if (df->progress_identity != identity) {
    df->progress_identity = identity;
    df->progress = 0;
  }
  BeginPass(&p);
  rc = Write1(m, df, segments, count, size, oflags & O_NONBLOCK, &p);
  EndPass(&p);
  if (rc != DSP_HALT) return FinishWrite(df, rc);
  if (df->progress && (GuestWaitCancelled() || (m->signals & ~m->sigmask))) {
    return FinishWrite(df, df->progress);
  }
  if (!df->progress && GuestWaitInterruptedRestartable(m)) {
    return FinishWrite(df, eintr());
  }
  HaltPass(m, &p);
}

/* snd_pcm_oss_sync(): the staged fragment is padded with silence and given
 * to the card, then everything plays out. Returns 0, -1 with errno, or
 * DSP_HALT while it waits; `wait` is false for the end of the program, which
 * plays the fragment out without waiting. */
static int Sync(struct DspPass *p, i64 now, bool wait) {
  u32 size;
  i64 rc;
  u64 rest;
  if (MakeReady(p, now) == -1) return -1;
  if (dsp.buffer_used > 0) {
    SaveStaging(p);
    SetSilence(staging + dsp.buffer_used, dsp.period_bytes - dsp.buffer_used);
    dsp.buffer_used = dsp.period_bytes;
    // snd_pcm_oss_sync1() waits for room even without O_NONBLOCK
    size = dsp.period_bytes - dsp.period_ptr;
    rc = Write2(p, staging + dsp.period_ptr, size,
                wait ? WRITE_BLOCK : WRITE_FORCE, now);
    if (rc == DSP_HALT) return DSP_HALT;
    dsp.buffer_used = 0;
    dsp.period_ptr = 0;
  }
  // the rest of the card's period is silence (appl_ptr % period_size)
  UpdateRing(now);
  if (dsp.state == DSP_RUNNING && dsp.written % dsp.slave_period) {
    rest = dsp.slave_period - dsp.written % dsp.slave_period;
    if (wait && dsp.capacity - Queued(now) < rest) {
      p->halt_at = RoomDeadline(rest, now);
      return DSP_HALT;
    }
    dsp.written += rest;
    p->transferred = true;
    if (p->first_frame < 0) p->first_frame = FrameTime(dsp.written - rest);
  }
  if (!wait) return 0;
  // SNDRV_PCM_IOCTL_DRAIN
  UpdateRing(now);
  if (dsp.state == DSP_RUNNING) {
    p->halt_at = PlayedBy(dsp.written);
    return DSP_HALT;
  }
  if (dsp.state != DSP_SETUP) {
    dsp.state = DSP_SETUP;
    dsp.written = 0;
    dsp.t0 = 0;
    ++dsp.segment;
  }
  dsp.prepare = true;
  return 0;
}

/* SNDCTL_DSP_SYNC, which halts the call until the buffer has played. */
static int SyncIoctl(struct Machine *m) {
  int rc;
  struct DspPass p;
  BeginPass(&p);
  rc = Sync(&p, SoundNow(), true);
  EndPass(&p);
  if (rc != DSP_HALT) return rc;
  if (GuestWaitInterruptedRestartable(m)) return eintr();
  HaltPass(m, &p);
}

/* close() of the last descriptor holding playback: snd_pcm_oss_release()
 * syncs, and a signal ends the wait, the rest being dropped at release. */
void OssCloseWait(struct Machine *m, struct DeviceFile *df) {
  int rc;
  struct DspPass p;
  if (!df->sound->playback || owner != df) return;
  BeginPass(&p);
  rc = Sync(&p, SoundNow(), true);
  EndPass(&p);
  if (rc != DSP_HALT) return;
  if (GuestWaitCancelled() || (m->signals & ~m->sigmask)) return;
  HaltPass(m, &p);
}

/* The end of the program by exit_group(): the staged fragment is played out
 * as close would, without waiting for it. */
void OssProgramExit(void) {
  struct DspPass p;
  if (!owner) return;
  BeginPass(&p);
  Sync(&p, SoundNow(), false);
  EndPass(&p);
}

/* A signal killed the program: the drain at release is interrupted at once
 * and what was queued is dropped. */
void OssProgramKilled(void) {
  struct DspPass p;
  if (!owner || dsp.state != DSP_RUNNING) return;
  BeginPass(&p);
  DropRing(&p, SoundNow());
  SaveStaging(&p);
  dsp.buffer_used = 0;
  dsp.period_ptr = 0;
  dsp.prepare = true;
  EndPass(&p);
}

// ------------------------------------------------------------ open, release

/* snd_pcm_oss_init_substream(): /dev/dsp opens at 8000 Hz, unsigned 8-bit,
 * mono, nothing applied yet. */
static void InitPlayback(void) {
  memset(&dsp, 0, sizeof(dsp));
  dsp.format = AFMT_U8;
  dsp.channels = 1;
  dsp.rate = 8000;
  dsp.params = true;
  dsp.state = DSP_SETUP;
  free(staging);
  staging = 0;
}

/* The card has one playback substream: a second open for writing answers
 * EBUSY, as snd-pcm-oss's open does with its nonblock_open default. Reading
 * is recording, which this machine does not cover (x86-devices.md). */
int OssOpen(struct DeviceFile *df, int oflags) {
  int access = oflags & O_ACCMODE;
  if (access == O_WRONLY || access == O_RDWR) {
    if (owner) {
      errno = EBUSY;
      return -1;
    }
    owner = df;
    df->sound->playback = true;
    InitPlayback();
  }
  if (access == O_RDONLY || access == O_RDWR) df->sound->capture = true;
  return 0;
}

void OssRelease(struct DeviceFile *df, bool drop) {
  i64 now;
  if (owner != df) return;
  if (dsp.state == DSP_RUNNING) {
    now = SoundNow();
    UpdateRing(now);
    if (Queued(now)) SoundEmitCut(now, SOUND_DSP);
  }
  owner = 0;
  InitPlayback();
}

void ResetOss(void) {
  owner = 0;
  InitPlayback();
  // The guest's HDA card through hda_generic has "Master" and "Capture"
  // controls, so VOLUME and IGAIN are its OSS channels; the levels are what
  // alsactl init sets on a card with no saved state (Master at -20 dB of
  // 74 steps, Capture at its top), and the mixer has counted the 14 control
  // changes made since the card came up by the time a program asks, as the
  // pinned guest's does.
  memset(mixer, 0, sizeof(mixer));
  mixer[MIXER_VOLUME] = (struct MixerSlot){true, true, 73, 73};
  mixer[MIXER_IGAIN] = (struct MixerSlot){true, true, 100, 100};
  mixer_changes = MIXER_CHANGES_AT_BOOT;
}

void OssTearDown(void) {
  owner = 0;
  InitPlayback();
}

// ------------------------------------------------------------ the mixer

/* The gains VOLUME and PCM put on /dev/dsp's sound: a channel the card has no
 * control for changes nothing, so it counts as full. */
void GetMixerGains(u8 volume[2], u8 pcm[2]) {
  volume[0] = mixer[MIXER_VOLUME].present ? mixer[MIXER_VOLUME].left : 100;
  volume[1] = mixer[MIXER_VOLUME].present ? mixer[MIXER_VOLUME].right : 100;
  pcm[0] = mixer[MIXER_PCM].present ? mixer[MIXER_PCM].left : 100;
  pcm[1] = mixer[MIXER_PCM].present ? mixer[MIXER_PCM].right : 100;
}

/* Whether a channel's levels change the gains on /dev/dsp. */
static bool AffectsGains(int slot) {
  return (slot == MIXER_VOLUME || slot == MIXER_PCM) && mixer[slot].present;
}

static void ReportMixer(void) {
  u8 volume[2], pcm[2];
  GetMixerGains(volume, pcm);
  SoundEmitMixer(volume, pcm);
}

static int PutInt(struct Machine *m, i64 addr, i32 value) {
  u8 word[4];
  Write32(word, value);
  return CopyToUserWrite(m, addr, word, 4) == -1 ? efault() : 0;
}

static int GetInt(struct Machine *m, i64 addr, i32 *value) {
  u8 word[4];
  if (CopyFromUserRead(m, word, addr, 4) == -1) return efault();
  *value = Read32(word);
  return 0;
}

// The amplifier step snd_mixer_oss_conv2() writes for a level: 74 steps.
static int AmpStep(int level) {
  return (74 * level + 50) / 100;
}

/* snd_mixer_oss_set_volume(): levels above 100 are 100, a mono channel takes
 * the left level for both, and a channel the card has no control for keeps
 * what was written. Every control a write changes counts in
 * SOUND_MIXER_INFO's modify_counter. */
static int SetVolume(int slot, i32 value) {
  int left = value & 0xff, right = (value >> 8) & 0xff;
  u8 record[7];
  struct MixerSlot *s = mixer + slot;
  if (left > 100) left = 100;
  if (right > 100) right = 100;
  if (!s->stereo) right = left;
  if (s->left != left || s->right != right) {
    record[0] = slot;
    record[1] = s->left;
    record[2] = s->right;
    Write32(record + 3, mixer_changes);
    DebugHistoryJournal(JOURNAL_MIXER_LEVELS, record, sizeof(record));
    if (s->present) {
      if (AmpStep(s->left) != AmpStep(left) ||
          AmpStep(s->right) != AmpStep(right)) {
        ++mixer_changes;  // the volume control
      }
      if ((s->left > 0) != (left > 0) || (s->right > 0) != (right > 0)) {
        ++mixer_changes;  // the switch
      }
    }
    s->left = left;
    s->right = right;
    if (AffectsGains(slot)) ReportMixer();
  }
  return left | right << 8;
}

static int GetVolume(int slot) {
  struct MixerSlot *s = mixer + slot;
  return s->left | (s->stereo ? s->right : s->left) << 8;
}

static u32 MixerMask(bool stereo) {
  u32 i, mask = 0;
  for (i = 0; i < MIXER_SLOTS; ++i) {
    if (mixer[i].present && (!stereo || mixer[i].stereo)) mask |= 1u << i;
  }
  return mask;
}

/* snd_mixer_oss_ioctl1(), on /dev/mixer and, as OSS allows, on /dev/dsp. */
static int MixerRequest(struct Machine *m, u32 cmd, i64 addr) {
  i32 value;
  u8 info[92];
  if (((cmd >> 8) & 0xff) == 'M') {
    switch (cmd) {
      case SOUND_MIXER_INFO:
      case SOUND_OLD_MIXER_INFO:
        // the card's driver and the mixer's name, which hda_generic gives
        // QEMU's hda-duplex codec
        memset(info, 0, sizeof(info));
        strcpy((char *)info, "HDA-Intel");
        strcpy((char *)info + 16, "QEMU Generic");
        Write32(info + 48, mixer_changes);
        return CopyToUserWrite(m, addr, info,
                               cmd == SOUND_MIXER_INFO ? 92 : 48) == -1
                   ? efault()
                   : 0;
      case SOUND_MIXER_WRITE_RECSRC:
        // no channel the card has is a recording source OSS can switch
        if (GetInt(m, addr, &value) == -1) return -1;
        return PutInt(m, addr, 0);
      case OSS_GETVERSION:
        return PutInt(m, addr, SNDRV_OSS_VERSION);
      case OSS_ALSAEMULVER:
        return PutInt(m, addr, 1);
      case SOUND_MIXER_READ_DEVMASK:
        return PutInt(m, addr, MixerMask(false));
      case SOUND_MIXER_READ_STEREODEVS:
        return PutInt(m, addr, MixerMask(true));
      case SOUND_MIXER_READ_RECMASK:
      case SOUND_MIXER_READ_CAPS:
      case SOUND_MIXER_READ_RECSRC:
        return PutInt(m, addr, 0);
      default:
        break;
    }
  }
  if (cmd & SIOC_IN) {
    if (GetInt(m, addr, &value) == -1) return -1;
    if ((cmd & 0xff) > 30) {
      errno = EIO;
      return -1;
    }
    return PutInt(m, addr, SetVolume(cmd & 0xff, value));
  }
  if (cmd & SIOC_OUT) {
    if ((cmd & 0xff) > 30) {
      errno = EIO;
      return -1;
    }
    return PutInt(m, addr, GetVolume(cmd & 0xff));
  }
  errno = ENXIO;
  return -1;
}

int MixerIoctl(struct Machine *m, int fildes, u64 request, i64 addr) {
  return MixerRequest(m, request, addr);
}

// ------------------------------------------------------------ ioctls

/* snd_pcm_oss_get_active_substream(): what the program set is applied. */
static int Apply(struct DspPass *p) {
  return dsp.params ? ApplyParams(p, SoundNow()) : 0;
}

static int SetFormat(struct DspPass *p, i32 format) {
  if (format != AFMT_QUERY) {
    if (Apply(p) == -1) return -1;
    if (!(OSS_FORMATS & format)) format = AFMT_U8;
    if (dsp.format != (u32)format) {
      dsp.params = true;
      dsp.format = format;
    }
  }
  return Apply(p) == -1 ? -1 : (int)dsp.format;
}

static int SetRate(struct DspPass *p, i32 rate) {
  if (rate < 1000) rate = 1000;
  if (rate > 192000) rate = 192000;
  if (dsp.rate != (u32)rate) {
    dsp.params = true;
    dsp.rate = rate;
  }
  return Apply(p) == -1 ? -1 : (int)dsp.rate;
}

/* snd_pcm_oss_set_channels(), which takes the count unsigned: 0 is 1, and
 * anything past 128, -1 among them, EINVAL. */
static int SetChannels(struct DspPass *p, u32 channels) {
  if (channels < 1) channels = 1;
  if (channels > 128) return einval();
  if (dsp.channels != (u32)channels) {
    dsp.params = true;
    dsp.channels = channels;
  }
  return Apply(p) == -1 ? -1 : (int)dsp.channels;
}

static int GetCaps(struct DeviceFile *df) {
  // DSP_CAP_MMAP is left out: mmap of /dev/dsp is not covered, and a careful
  // program falls back to write()
  return DSP_CAP_TRIGGER | DSP_CAP_REALTIME |
         (df->sound->capture ? DSP_CAP_DUPLEX : 0) | 1;
}

static int GetSpace(struct Machine *m, struct DspPass *p, i64 addr) {
  u8 info[16];
  i64 now, bytes;
  if (Apply(p) == -1) return -1;
  now = SoundNow();
  UpdateRing(now);
  Write32(info + 4, dsp.periods);       // fragstotal
  Write32(info + 8, dsp.period_bytes);  // fragsize
  if (dsp.prepare) {
    bytes = (i64)dsp.period_bytes * dsp.periods;
  } else if (dsp.state == DSP_XRUN) {
    bytes = OssBytes(dsp.capacity);  // DELAY answers EPIPE
  } else {
    bytes = OssBytes(dsp.capacity - Queued(now)) - dsp.buffer_used;
  }
  // info.bytes / runtime->oss.period_bytes, an int over a size_t: a
  // negative count of bytes free comes out as floor division would have it
  Write32(info, (u32)((u64)bytes / dsp.period_bytes));  // fragments
  Write32(info + 12, bytes);
  return CopyToUserWrite(m, addr, info, sizeof(info)) == -1 ? efault() : 0;
}

static int GetOdelay(struct DspPass *p) {
  i64 now = SoundNow();
  if (MakeReady(p, now) == -1) return -1;
  UpdateRing(now);
  if (dsp.state != DSP_RUNNING) return 0;
  return OssBytes(Queued(now));
}

static int GetOptr(struct Machine *m, struct DspPass *p, i64 addr) {
  u8 info[12];
  i64 now = SoundNow(), delay, played;
  if (MakeReady(p, now) == -1) return -1;
  UpdateRing(now);
  memset(info, 0, sizeof(info));
  if (dsp.state == DSP_RUNNING || dsp.state == DSP_XRUN) {
    played = Played(now);
    delay = dsp.state == DSP_RUNNING ? OssBytes(dsp.written - played) : 0;
    Write32(info, (dsp.bytes - delay) & INT_MAX);  // bytes
    Write32(info + 4, (delay + (dsp.state == DSP_RUNNING ? dsp.buffer_used : 0)) /
                          dsp.period_bytes);                // blocks
    Write32(info + 8, OssBytes(played % dsp.capacity));  // ptr
  } else {
    Write32(info, dsp.bytes & INT_MAX);
  }
  return CopyToUserWrite(m, addr, info, sizeof(info)) == -1 ? efault() : 0;
}

/* snd_pcm_oss_ioctl(). Each call that changes the substream is one journal
 * record. */
static int DspRequest(struct Machine *m, struct DeviceFile *df, u32 cmd,
                      i64 addr, struct DspPass *p) {
  int rc;
  i32 value;
  switch (cmd) {
    case SNDCTL_DSP_RESET:
      DropRing(p, SoundNow());
      SaveStaging(p);
      dsp.prepare = true;
      dsp.buffer_used = 0;
      dsp.period_ptr = 0;
      return 0;
    case SNDCTL_DSP_SPEED:
      if (GetInt(m, addr, &value) == -1) return -1;
      if ((rc = SetRate(p, value)) == -1) return -1;
      return PutInt(m, addr, rc);
    case SOUND_PCM_READ_RATE:
      if (Apply(p) == -1) return -1;
      return PutInt(m, addr, dsp.rate);
    case SNDCTL_DSP_STEREO:
      if (GetInt(m, addr, &value) == -1) return -1;
      if ((rc = SetChannels(p, value > 0 ? 2 : 1)) == -1) return -1;
      return PutInt(m, addr, rc - 1);
    case SNDCTL_DSP_GETBLKSIZE:
      if (Apply(p) == -1) return -1;
      return PutInt(m, addr, dsp.period_bytes);
    case SNDCTL_DSP_SETFMT:
      if (GetInt(m, addr, &value) == -1) return -1;
      if ((rc = SetFormat(p, value)) == -1) return -1;
      return PutInt(m, addr, rc);
    case SOUND_PCM_READ_BITS:
      if (Apply(p) == -1) return -1;
      return PutInt(m, addr, dsp.format);
    case SNDCTL_DSP_CHANNELS:
      if (GetInt(m, addr, &value) == -1) return -1;
      if ((rc = SetChannels(p, value)) == -1) return -1;
      return PutInt(m, addr, rc);
    case SOUND_PCM_READ_CHANNELS:
      if (Apply(p) == -1) return -1;
      return PutInt(m, addr, dsp.channels);
    case SOUND_PCM_WRITE_FILTER:
    case SOUND_PCM_READ_FILTER:
      errno = EIO;
      return -1;
    case SNDCTL_DSP_POST:
      // START on a stream a write already started, or with nothing to play
      return MakeReady(p, SoundNow());
    case SNDCTL_DSP_SUBDIVIDE:
      if (GetInt(m, addr, &value) == -1) return -1;
      if (!value) return PutInt(m, addr, dsp.subdivision ? dsp.subdivision : 1);
      if (dsp.subdivision || dsp.fragshift) return einval();
      if (value != 1 && value != 2 && value != 4 && value != 8 && value != 16) {
        return einval();
      }
      dsp.subdivision = value;
      dsp.params = true;
      return PutInt(m, addr, value);
    case SNDCTL_DSP_SETFRAGMENT:
      // once: a second call answers EINVAL
      if (GetInt(m, addr, &value) == -1) return -1;
      if (dsp.subdivision || dsp.fragshift) return einval();
      if ((value & 0xffff) >= 25) return einval();
      dsp.fragshift = MAX(4, value & 0xffff);
      dsp.maxfrags = MAX(2, (value >> 16) & 0xffff);
      dsp.params = true;
      return 0;
    case SNDCTL_DSP_GETFMTS:
      if (Apply(p) == -1) return -1;
      return PutInt(m, addr, OSS_FORMATS);
    case SNDCTL_DSP_GETOSPACE:
      return GetSpace(m, p, addr);
    case SNDCTL_DSP_NONBLOCK:
      if (!(df->status & O_NONBLOCK)) {
        u8 record[12];
        memcpy(record, &df, sizeof(df));
        Write32(record + 8, df->status);
        DebugHistoryJournal(JOURNAL_DSP_STATUS, record, sizeof(record));
        df->status |= O_NONBLOCK;
      }
      return 0;
    case SNDCTL_DSP_GETCAPS:
      return PutInt(m, addr, GetCaps(df));
    case SNDCTL_DSP_GETTRIGGER:
      return PutInt(m, addr, PCM_ENABLE_OUTPUT);
    case SNDCTL_DSP_SETTRIGGER:
      // the trigger stays on: turning it off is useful only with mmap,
      // which is not covered
      if (GetInt(m, addr, &value) == -1) return -1;
      if (MakeReady(p, SoundNow()) == -1) return -1;
      return value & PCM_ENABLE_OUTPUT ? 0 : einval();
    case SNDCTL_DSP_GETOPTR:
      return GetOptr(m, p, addr);
    case SNDCTL_DSP_SETSYNCRO:
    case SNDCTL_DSP_PROFILE:
      return 0;
    case SNDCTL_DSP_SETDUPLEX:
      if (GetCaps(df) & DSP_CAP_DUPLEX) return 0;
      errno = EIO;
      return -1;
    case SNDCTL_DSP_GETODELAY:
      if ((rc = GetOdelay(p)) == -1) {
        PutInt(m, addr, 0);
        return -1;
      }
      return PutInt(m, addr, rc);
    case SNDCTL_DSP_GETISPACE:
    case SNDCTL_DSP_GETIPTR:
    case SNDCTL_DSP_MAPINBUF:
    case SNDCTL_DSP_MAPOUTBUF:
    default:
      return einval();
  }
}

int OssIoctl(struct Machine *m, int fildes, u64 request, i64 addr) {
  int rc;
  u32 cmd = request;
  struct DspPass p;
  struct DeviceFile *df;
  if (!(df = SoundDeviceFile(fildes)) || !df->sound) return ebadf();
  if (cmd == OSS_GETVERSION) return PutInt(m, addr, SNDRV_OSS_VERSION);
  if (cmd == OSS_ALSAEMULVER) return PutInt(m, addr, 1);
  if (((cmd >> 8) & 0xff) == 'M') return MixerRequest(m, cmd, addr);
  if (((cmd >> 8) & 0xff) != 'P') return einval();
  // recording is not covered: a description without playback has nothing
  // these requests could act on
  if (!df->sound->playback) return einval();
  if (cmd == SNDCTL_DSP_SYNC) return SyncIoctl(m);
  BeginPass(&p);
  rc = DspRequest(m, df, cmd, addr, &p);
  EndPass(&p);
  return rc;
}

// ------------------------------------------------------------ poll, waits

/* snd_pcm_oss_poll(): writable unless the stream runs with less than a
 * fragment free. */
int OssPoll(struct pollfd *fds, nfds_t nfds, int timeout) {
  nfds_t i;
  int ready;
  i64 now = SoundNow();
  struct DeviceFile *df;
  for (ready = i = 0; i < nfds; ++i) {
    fds[i].revents = 0;
    if ((df = SoundDeviceFile(fds[i].fd)) && df->sound &&
        df->sound->playback) {
      UpdateRing(now);
      if (dsp.state != DSP_RUNNING ||
          dsp.capacity - Queued(now) >= dsp.slave_period) {
        fds[i].revents = fds[i].events & POLLOUT;
      }
    }
    if (fds[i].revents) ++ready;
  }
  return ready;
}

i64 OssReadyDeadline(struct DeviceFile *df, int events) {
  i64 now;
  if (!(events & POLLOUT) || !df->sound->playback) return -1;
  now = SoundNow();
  UpdateRing(now);
  return RoomDeadline(dsp.slave_period, now);
}

// ------------------------------------------------------------ undo

void UndoOssJournal(u32 kind, const u8 *data, u32 size) {
  u8 flags, *grown;
  i64 now, first_frame;
  u32 staged_size;
  u64 written, played;
  struct DspState before, current;
  struct DeviceFile *df;
  switch (kind) {
    case JOURNAL_DSP_STATUS:
      memcpy(&df, data, sizeof(df));
      df->status = Read32(data + 8);
      break;
    case JOURNAL_MIXER_LEVELS:
      mixer[data[0]].left = data[1];
      mixer[data[0]].right = data[2];
      mixer_changes = Read32(data + 3);
      if (AffectsGains(data[0])) ReportMixer();
      break;
    case JOURNAL_DSP_PASS:
      memcpy(&before, data, sizeof(before));
      flags = data[sizeof(before)];
      first_frame = Read64(data + sizeof(before) + 1);
      staged_size = Read32(data + sizeof(before) + 9);
      now = SoundNow();
      UpdateRing(now);
      current = dsp;
      // what the call gave the card and has not played is taken back;
      // nothing heard plays again
      if (flags & PASS_TRANSFERRED) {
        SoundEmitCut(MAX(now, first_frame), SOUND_DSP);
      }
      dsp = before;
      if (flags & PASS_DROPPED) {
        // a stop is not undone: the frames it dropped stay dropped
        dsp.state = before.params || before.prepare ? DSP_SETUP : DSP_PREPARED;
        dsp.written = 0;
        dsp.t0 = 0;
        dsp.segment = current.segment + 1;
      } else if (before.segment == current.segment &&
                 (current.state == DSP_RUNNING || current.state == DSP_XRUN)) {
        dsp.state = current.state;
        dsp.t0 = current.t0;
        dsp.written = current.written;
        played = Played(now);
        written = MAX(before.written, MIN(current.written, played));
        if (written == before.written) {
          dsp.state = before.state;
          dsp.t0 = before.t0;
          dsp.written = before.written;
        } else {
          dsp.state = DSP_RUNNING;
          dsp.written = written;
        }
      }
      if (dsp.period_bytes && (!staging || before.period_bytes != current.period_bytes)) {
        if ((grown = (u8 *)realloc(staging, dsp.period_bytes))) staging = grown;
      }
      if (staged_size && staging) {
        memcpy(staging, data + sizeof(before) + 13, staged_size);
      }
      break;
    default:
      break;
  }
}
