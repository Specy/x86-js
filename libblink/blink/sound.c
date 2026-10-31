/* The sound devices' timeline and lifecycle (sound.h).
 *
 * Nothing here plays: the devices hand the host what they would play, each
 * thing with the Program time it is heard at, as soon as it is decided. The
 * host schedules it; a cut tells it to drop what it scheduled after a time,
 * when Undo, a reset or the end of the machine takes back sound that has not
 * played yet. */
#include "blink/sound.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>

#include "blink/blinkenlib.h"
#include "blink/debughistory.h"
#include "blink/errno.h"
#include "blink/fds.h"
#include "blink/thread.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// Times cross as two 32-bit halves; a listener that throws must not unwind
// through the system call that made the sound.
EM_JS(void, SoundPcmHost,
      (u32 lo, u32 hi, u32 rate, const float *frames, u32 count), {
        try {
          if (Module.blinkSoundPcm) {
            const samples = new Float32Array(HEAPU8.buffer, frames, count * 2);
            Module.blinkSoundPcm(lo >>> 0, hi >>> 0, rate >>> 0, samples.slice());
          }
        } catch (error) {
          setTimeout(() => { throw error; }, 0);
        }
      });
EM_JS(void, SoundMidiHost, (u32 lo, u32 hi, const u8 *message, u32 size), {
  try {
    if (Module.blinkSoundMidi)
      Module.blinkSoundMidi(lo >>> 0, hi >>> 0, HEAPU8.slice(message, message + size));
  } catch (error) {
    setTimeout(() => { throw error; }, 0);
  }
});
EM_JS(void, SoundToneHost, (u32 lo, u32 hi, double hz), {
  try {
    if (Module.blinkSoundTone) Module.blinkSoundTone(lo >>> 0, hi >>> 0, hz);
  } catch (error) {
    setTimeout(() => { throw error; }, 0);
  }
});
EM_JS(void, SoundMixerHost, (int vl, int vr, int pl, int pr), {
  try {
    if (Module.blinkSoundMixer) Module.blinkSoundMixer(vl, vr, pl, pr);
  } catch (error) {
    setTimeout(() => { throw error; }, 0);
  }
});
EM_JS(void, SoundCutHost, (u32 lo, u32 hi, int device), {
  try {
    if (Module.blinkSoundCut) Module.blinkSoundCut(lo >>> 0, hi >>> 0, device);
  } catch (error) {
    setTimeout(() => { throw error; }, 0);
  }
});
#endif

/* Whether anything was handed to the host since the machine started: the end
 * of the machine cuts only then, so that it never asks a clock that nothing
 * needed. */
static bool scheduled;

i64 SoundNow(void) {
  return DeviceNow();
}

/* `count` stereo frames, interleaved, at `rate`, the first heard at `start`. */
void SoundEmitPcm(i64 start, u32 rate, const float *frames, u32 count) {
  if (!count) return;
  scheduled = true;
#ifdef __EMSCRIPTEN__
  SoundPcmHost((u64)start, (u64)start >> 32, rate, frames, count);
#endif
}

/* One complete MIDI message, which reaches the synthesizer at `at`. */
void SoundEmitMidi(i64 at, const u8 *message, u32 size) {
  scheduled = true;
#ifdef __EMSCRIPTEN__
  SoundMidiHost((u64)at, (u64)at >> 32, message, size);
#endif
}

/* The PC speaker sounds `hz` from `at` on; 0 is silence. */
void SoundEmitTone(i64 at, double hz) {
  scheduled = true;
#ifdef __EMSCRIPTEN__
  SoundToneHost((u64)at, (u64)at >> 32, hz);
#endif
}

/* The mixer's gains for /dev/dsp, each side 0 to 100. */
void SoundEmitMixer(const u8 volume[2], const u8 pcm[2]) {
#ifdef __EMSCRIPTEN__
  SoundMixerHost(volume[0], volume[1], pcm[0], pcm[1]);
#endif
}

/* Everything `device` (SOUND_*) scheduled after `after` is dropped. */
void SoundEmitCut(i64 after, int device) {
#ifdef __EMSCRIPTEN__
  SoundCutHost((u64)after, (u64)after >> 32, device);
#endif
}

bool IsSoundDevice(const struct DeviceNode *node) {
  return node->kind == DEVICE_DSP || node->kind == DEVICE_MIXER ||
         node->kind == DEVICE_MIDI;
}

/* The open file description of the device a guest descriptor refers to. */
struct DeviceFile *SoundDeviceFile(int fildes) {
  struct Fd *fd;
  struct DeviceFile *df = 0;
  if (!g_machine) return 0;
  LOCK(&g_machine->system->fds.lock);
  if ((fd = GetFd(&g_machine->system->fds, fildes))) df = fd->device;
  UNLOCK(&g_machine->system->fds.lock);
  return df;
}

/* What open() does for a sound device beyond making the description: claim
 * the card's playback substream or the port's output, as the driver's open
 * does. */
int SoundOpen(struct DeviceFile *df, int oflags) {
  int rc = 0;
  if (!(df->sound = (struct SoundFile *)calloc(1, sizeof(*df->sound)))) {
    return enomem();
  }
  switch (df->node->kind) {
    case DEVICE_DSP:
      rc = OssOpen(df, oflags);
      break;
    case DEVICE_MIDI:
      rc = MidiOpen(df, oflags);
      break;
    default:
      break;
  }
  if (rc == -1) {
    free(df->sound);
    df->sound = 0;
  }
  return rc;
}

/* The driver's release, at the last close of the description. A close() has
 * already waited for what was queued (SoundCloseWait()); anything else that
 * closes it, the end of the machine included, drops what is left. */
void SoundRelease(struct DeviceFile *df) {
  if (!df->sound) return;
  switch (df->node->kind) {
    case DEVICE_DSP:
      OssRelease(df, true);
      break;
    case DEVICE_MIDI:
      MidiRelease(df, true);
      break;
    default:
      break;
  }
  free(df->sound);
  df->sound = 0;
}

/* What close() of the last descriptor of a description waits for before it
 * releases it: the dsp's buffer playing out, the port's bytes leaving. It
 * halts the instruction while it waits, as a blocking write does, and
 * returns once there is nothing left to wait for or a signal ended the
 * wait, which drops the rest as Linux's release does. */
void SoundCloseWait(struct Machine *m, struct DeviceFile *df) {
  if (!df->sound || df->references != 1) return;
  switch (df->node->kind) {
    case DEVICE_DSP:
      OssCloseWait(m, df);
      break;
    case DEVICE_MIDI:
      MidiCloseWait(m, df);
      break;
    default:
      break;
  }
}

i64 SoundWrite(struct Machine *m, int fildes,
               const struct GuestSegment *segments, u32 count, int oflags) {
  struct DeviceFile *df;
  if (!(df = SoundDeviceFile(fildes)) || !df->sound) return ebadf();
  switch (df->node->kind) {
    case DEVICE_DSP:
      return OssWrite(m, df, segments, count, oflags);
    case DEVICE_MIDI:
      return MidiWrite(m, df, segments, count, oflags);
    default:
      return einval();
  }
}

/* When `df` becomes ready for `events`, in Program time, or -1. */
i64 SoundReadyDeadline(struct DeviceFile *df, int events) {
  if (!df->sound) return -1;
  switch (df->node->kind) {
    case DEVICE_DSP:
      return OssReadyDeadline(df, events);
    case DEVICE_MIDI:
      return MidiReadyDeadline(df, events);
    default:
      return -1;
  }
}

/* Every program starts with the guest's levels on the mixer, the speaker
 * silent and the devices closed; the host hears the levels. */
void ResetSound(void) {
  u8 volume[2], pcm[2];
  ResetOss();
  ResetMidi();
  ResetSpeaker();
  GetMixerGains(volume, pcm);
  SoundEmitMixer(volume, pcm);
}

/* The machine is going away, the program's descriptors already closed:
 * nothing it scheduled plays any more. */
void SoundTearDown(void) {
  OssTearDown();
  MidiTearDown();
  ResetSpeaker();
  if (scheduled) SoundEmitCut(SoundNow(), SOUND_ALL);
  scheduled = false;
}

/* exit_group(): Linux's exit closes the descriptors, which plays the dsp's
 * last fragment out; here the host is told at once (x86-devices.md, "/dev/dsp
 * in a Testcase, under Undo and at the end"). */
void SoundProgramExit(struct Machine *m) {
  OssProgramExit();
}

/* A signal ended the program: its release finds the signal pending, so the
 * dsp's drain and the port's are interrupted and what was queued is
 * dropped. */
void SoundProgramKilled(void) {
  OssProgramKilled();
  MidiProgramKilled();
}

void UndoSoundJournal(u32 kind, const u8 *data, u32 size) {
  if (kind >= 36 && kind < 48) {
    UndoOssJournal(kind, data, size);
  } else if (kind >= 48 && kind < 56) {
    UndoMidiJournal(kind, data, size);
  } else if (kind >= 56 && kind < 60) {
    UndoSpeakerJournal(kind, data, size);
  }
}
