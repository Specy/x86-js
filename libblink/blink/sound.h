#ifndef BLINK_SOUND_H_
#define BLINK_SOUND_H_
#include <poll.h>
#include <stdbool.h>

#include "blink/devices.h"
#include "blink/machine.h"
#include "blink/types.h"

/* The sound devices of the QEMU guest x86's devices follow
 * (docs/design/x86-devices.md): OSS's /dev/dsp and /dev/mixer on the HDA card
 * (oss.c), the virtual raw MIDI port (rawmidi.c) and the PC speaker with the
 * console's tone ioctls (speaker.c). What they play leaves Blink as a
 * timeline on Program time (sound.c): samples with the time they start
 * playing, MIDI messages with the time their last byte leaves the port, tones
 * with the time they change, and cuts, which drop what was scheduled after a
 * time. */

// History journal kinds (debughistory.h): 36 to 43 /dev/dsp, 44 to 47 the
// mixer, 48 to 55 the MIDI port, 56 to 59 the speaker and the console.
#define JOURNAL_DSP_PASS        36  // the dsp before a call changed it
#define JOURNAL_DSP_STATUS      37  // the status flags SNDCTL_DSP_NONBLOCK set
#define JOURNAL_MIXER_LEVELS    44  // a mixer channel's levels before a write
#define JOURNAL_MIDI_WRITE      48  // what a write queued on the port
#define JOURNAL_MIDI_PARAMS     49  // the port's buffer settings before PARAMS
#define JOURNAL_MIDI_PVERSION   50  // the protocol version USER_PVERSION set
#define JOURNAL_TONE            56  // the speaker's tone before a change
#define JOURNAL_CONSOLE_TERMIOS 57  // /dev/tty0's termios before TCSETS

// What a cut drops, as the host's soundCut names it.
#define SOUND_ALL     0
#define SOUND_DSP     1
#define SOUND_MIDI    2
#define SOUND_SPEAKER 3

// The open file description's own state for a sound device (struct
// DeviceFile's `sound`).
struct SoundFile {
  bool playback;     // /dev/dsp: it holds the card's playback substream
  bool capture;      // /dev/dsp: opened for reading too
  bool output;       // the MIDI port: it holds the output substream
  bool input;        // the MIDI port: opened for reading too
  bool append;       // the MIDI port: OSS's path or O_APPEND, atomic writes
  u32 pversion;      // the MIDI port: what USER_PVERSION set
};

// sound.c: the timeline the host receives
void SoundEmitPcm(i64, u32, const float *, u32);
void SoundEmitMidi(i64, const u8 *, u32);
void SoundEmitTone(i64, double);
void SoundEmitMixer(const u8[2], const u8[2]);
void SoundEmitCut(i64, int);
i64 SoundNow(void);

// sound.c: the devices' lifecycle, called from the device table and Blink
bool IsSoundDevice(const struct DeviceNode *);
int SoundOpen(struct DeviceFile *, int);
void SoundRelease(struct DeviceFile *);
void SoundCloseWait(struct Machine *, struct DeviceFile *);
bool IsJournaledSoundFd(const struct Fd *);
i64 SoundWrite(struct Machine *, int, const struct GuestSegment *, u32, int);
i64 SoundReadyDeadline(struct DeviceFile *, int);
void ResetSound(void);
void SoundTearDown(void);
void SoundProgramExit(struct Machine *);
void SoundProgramKilled(void);
void UndoSoundJournal(u32, const u8 *, u32);
struct DeviceFile *SoundDeviceFile(int);

// oss.c
int OssOpen(struct DeviceFile *, int);
void OssRelease(struct DeviceFile *, bool);
void OssCloseWait(struct Machine *, struct DeviceFile *);
i64 OssWrite(struct Machine *, struct DeviceFile *, const struct GuestSegment *,
             u32, int);
int OssIoctl(struct Machine *, int, u64, i64);
int MixerIoctl(struct Machine *, int, u64, i64);
int OssPoll(struct pollfd *, nfds_t, int);
i64 OssReadyDeadline(struct DeviceFile *, int);
void ResetOss(void);
void OssTearDown(void);
void OssProgramExit(void);
void OssProgramKilled(void);
void UndoOssJournal(u32, const u8 *, u32);
void GetMixerGains(u8[2], u8[2]);

// rawmidi.c
int MidiOpen(struct DeviceFile *, int);
void MidiRelease(struct DeviceFile *, bool);
void MidiCloseWait(struct Machine *, struct DeviceFile *);
i64 MidiWrite(struct Machine *, struct DeviceFile *,
              const struct GuestSegment *, u32, int);
int MidiIoctl(struct Machine *, int, u64, i64);
int MidiPoll(struct pollfd *, nfds_t, int);
i64 MidiReadyDeadline(struct DeviceFile *, int);
void ResetMidi(void);
void MidiTearDown(void);
void MidiProgramKilled(void);
void UndoMidiJournal(u32, const u8 *, u32);

// speaker.c
int ConsoleIoctl(struct Machine *, int, u64, i64);
void ResetSpeaker(void);
void UndoSpeakerJournal(u32, const u8 *, u32);

#endif /* BLINK_SOUND_H_ */
