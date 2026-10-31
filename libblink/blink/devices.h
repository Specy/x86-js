#ifndef BLINK_DEVICES_H_
#define BLINK_DEVICES_H_
#include <stdbool.h>
#include <time.h>

#include "blink/fds.h"
#include "blink/machine.h"
#include "blink/types.h"

// What a device file stands for. Each node the wrapper makes in /dev has one.
#define DEVICE_FRAMEBUFFER 1  // fbdev, /dev/fb0
#define DEVICE_INPUT       2  // evdev, /dev/input/event*
#define DEVICE_DSP         3  // OSS sampled sound, /dev/dsp
#define DEVICE_MIXER       4  // OSS mixer, /dev/mixer
#define DEVICE_MIDI        5  // a raw MIDI port, OSS's /dev/midi1 or ALSA's
#define DEVICE_CONSOLE     6  // the virtual console, /dev/tty0
#define DEVICE_UNSUPPORTED 7  // the guest has it; opening it answers ENODEV
#define DEVICE_SERIAL      8  // the serial line, the program's own terminal

// The guest's input devices, in /dev/input's order: event0 to event4.
#define INPUT_KEYBOARD     0
#define INPUT_MOUSE        1
#define INPUT_TABLET       2
#define INPUT_SPEAKER      3
#define INPUT_POWER_BUTTON 4
#define INPUT_DEVICES      5

// What can end a wait, besides its deadline and a signal: the bits of
// GuestWaitHalt()'s `wake`. Only the keyboard and the tablet ever receive
// events from the host, so a wait on any other input device has none.
#define WAKE_TERMINAL 1
#define WAKE_KEYBOARD 2
#define WAKE_TABLET   4

// An ioctl request: its number and type in the low 16 bits, then the size of
// its argument and its direction, as Linux's _IOC() packs them.
#define IOC_NRTYPE(request) ((u32)(request)&0xffff)
#define IOC_SIZE(request)   (((u32)(request) >> 16) & 0x3fff)
#define IOC_DIR(request)    (((u32)(request) >> 30) & 3)
#define IOC_NONE_LINUX      0
#define IOC_WRITE_LINUX     1
#define IOC_READ_LINUX      2
// Whether `request` is the sized request `type` and `nr` in direction `dir`,
// whatever size it names, as EVIOCGNAME(len) and the like are matched.
#define IOC_MATCHES(request, dir, type, nr) \
  (IOC_NRTYPE(request) == ((type) << 8 | (nr)) && IOC_DIR(request) == (dir))

struct DeviceNode {
  const char *path;
  u32 major, minor;
  u16 mode;  // its permissions
  u8 kind;
  i8 input;  // INPUT_*, or -1
  u8 unit;   // the device of its card a raw MIDI node opens
};

// Bytes of the program's memory a write takes, a write's buffer or one of a
// writev's vectors.
struct GuestSegment {
  i64 addr;
  u64 len;
};

struct DeviceLink {
  const char *path;
  const char *target;
};

struct SoundFile;

// Time a device keeps lazily, from Program time (see DeviceDrain*): a buffer
// that drains at a fixed rate whenever it holds something.
struct DeviceDrain {
  u64 capacity;  // in units: bytes, or frames
  u64 rate;      // units a second
  u64 queued;    // units queued since the buffer last ran empty
  i64 start;     // the Program time, in ns, it began draining them
};

// The open file description of a device: what open() made, shared by every
// descriptor dup() makes of it, and released with the last one.
struct DeviceFile {
  u32 references;
  const struct DeviceNode *node;
  int status;  // its status flags, O_NONBLOCK among them, which dup() shares
  // A blocking write the halt-and-restart protocol runs again from the start
  // goes on from what it already queued: `progress` bytes, which belong to
  // the instruction `progress_identity` only.
  u64 progress_identity;
  u64 progress;
  i64 position;  // the file offset, for a device that has one: fbdev.c
  // the sound devices' own state for this open (sound.h), or null
  struct SoundFile *sound;
};

const struct DeviceNode *GetDeviceNodes(int *);
const struct DeviceLink *GetDeviceLinks(int *);
u32 GetDeviceNumber(const struct DeviceNode *);
const struct DeviceNode *FindDeviceNode(u64);
const struct FdCb *GetDeviceCb(const struct DeviceNode *);
int OpenDevice(struct Machine *, struct Fd *, const struct DeviceNode *);
void NotifyUnsupportedDevice(const struct DeviceNode *);
struct DeviceFile *RetainDeviceFile(struct DeviceFile *);
void ReleaseDeviceFile(struct DeviceFile *);
bool IsDeviceFd(const struct Fd *);
int DeviceFileFlags(const struct Fd *, int);
void DeviceFileSetFlags(struct Fd *, int);
u32 GetFdWakeSources(const struct Fd *, int);
i64 GetFdReadyDeadline(const struct Fd *, int);
int WaitForDeviceRead(struct Machine *, int, u64, int);
i64 WriteDevice(struct Machine *, int, const struct GuestSegment *, u32, int);
i64 WriteDeviceGuestIovs(struct Machine *, int, i64, u32, int);
u64 GuestSegmentsSize(const struct GuestSegment *, u32);
bool IsPacedDevice(struct Machine *, int);
int GetDeviceKind(struct Machine *, int);
bool IsDeviceFdUnseekable(const struct Fd *);
bool IsUnseekableDeviceFildes(struct Machine *, int);
bool IsJournaledDeviceFildes(struct Machine *, int, bool);
int IoctlString(struct Machine *, const char *, u64, i64);
void DeviceForgetProgress(u64);
i64 DeviceNow(void);
void DeviceDrainSet(struct DeviceDrain *, u64, u64);
u64 DeviceDrainLevel(struct DeviceDrain *, i64);
void DeviceDrainAdd(struct DeviceDrain *, i64, u64);
i64 DeviceDrainDeadline(struct DeviceDrain *, i64, u64);
struct timespec DeviceTimespec(i64);
void DeviceCloseWait(struct Machine *, int);

#endif /* BLINK_DEVICES_H_ */
