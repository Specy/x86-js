/* The devices a program reaches through /dev, as the QEMU guest that x86's
 * devices follow has them (docs/design/x86-devices.md, ADR 0067).
 *
 * This file holds their one table: each node's path, its device number and
 * what it is, and the udev links to them (evdev.c has the input devices'). The
 * wrapper makes the nodes, the links and /proc/bus/input/devices from it
 * before any program starts, and an open() finds what it opened here by the
 * device number of the node it reached, so a path through a link opens the
 * same device and stat() answers as on Linux. The numbers, the names and the
 * links are the pinned guest's, as its probe recorded them
 * (docs/research/x86-reference-guest.md, M0 of x86-devices-plan.md).
 *
 * Each device is a struct FdCb of its own. What open() made is the open file
 * description, a struct DeviceFile that dup() shares and the last close()
 * releases, as Linux's struct file is. The sound devices, /dev/dsp,
 * /dev/mixer, the raw MIDI port and /dev/tty0's tone ioctls, are in sound.c,
 * oss.c, rawmidi.c and speaker.c. */
#include "blink/devices.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/uio.h>

#include "blink/assert.h"
#include "blink/blinkenlib.h"
#include "blink/endian.h"
#include "blink/environment.h"
#include "blink/errno.h"
#include "blink/evdev.h"
#include "blink/fbdev.h"
#include "blink/linux.h"
#include "blink/macros.h"
#include "blink/sound.h"
#include "blink/syscall.h"
#include "blink/thread.h"
#include "blink/timespec.h"
#include "blink/vfs.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// A listener that throws must not unwind through the open() that failed.
EM_JS(void, NotifyUnsupportedDeviceHost, (const char *path), {
  try {
    if (Module.blinkUnsupportedDevice) Module.blinkUnsupportedDevice(UTF8ToString(path));
  } catch (error) {
    setTimeout(() => { throw error; }, 0);
  }
});
#endif

#define NODE(PATH, MAJOR, MINOR, MODE, KIND) \
  {PATH, MAJOR, MINOR, MODE, KIND, -1, 0}
#define INPUT(N, WHICH) \
  {"/dev/input/event" #N, 13, 64 + N, 0660, DEVICE_INPUT, WHICH, 0}
// a raw MIDI node and the device of card 1 it opens
#define MIDI(PATH, MAJOR, MINOR, UNIT) \
  {PATH, MAJOR, MINOR, 0660, DEVICE_MIDI, -1, UNIT}
// a virtual console the program does not use: VT1 is the foreground one
#define VT(N) NODE("/dev/tty" #N, 4, N, 0600, DEVICE_UNSUPPORTED)

static const struct DeviceNode kDeviceNodes[] = {
    NODE("/dev/fb0", 29, 0, 0660, DEVICE_FRAMEBUFFER),
    // the serial line root is logged in on, the kernel's console too
    NODE("/dev/ttyS0", 4, 64, 0600, DEVICE_SERIAL),
    NODE("/dev/console", 5, 1, 0600, DEVICE_SERIAL),
    // the foreground virtual console, VT1, where tty1's getty waits
    NODE("/dev/tty0", 4, 0, 0600, DEVICE_CONSOLE),
    NODE("/dev/tty1", 4, 1, 0600, DEVICE_CONSOLE),
    VT(2), VT(3), VT(4), VT(5), VT(6), VT(7), VT(8), VT(9), VT(10), VT(11),
    VT(12), VT(13), VT(14), VT(15), VT(16), VT(17), VT(18), VT(19), VT(20),
    VT(21), VT(22), VT(23), VT(24), VT(25), VT(26), VT(27), VT(28), VT(29),
    VT(30), VT(31), VT(32), VT(33), VT(34), VT(35), VT(36), VT(37), VT(38),
    VT(39), VT(40), VT(41), VT(42), VT(43), VT(44), VT(45), VT(46), VT(47),
    VT(48), VT(49), VT(50), VT(51), VT(52), VT(53), VT(54), VT(55), VT(56),
    VT(57), VT(58), VT(59), VT(60), VT(61), VT(62), VT(63),
    // in the order the guest probes them: the AT keyboard, the PS/2 mouse,
    // the USB tablet, the PC speaker, the ACPI power button
    INPUT(0, INPUT_KEYBOARD),
    INPUT(1, INPUT_MOUSE),
    INPUT(2, INPUT_TABLET),
    INPUT(3, INPUT_SPEAKER),
    INPUT(4, INPUT_POWER_BUTTON),
    NODE("/dev/mixer", 14, 0, 0660, DEVICE_MIXER),
    NODE("/dev/dsp", 14, 3, 0660, DEVICE_DSP),
    // OSS numbers card 1's raw MIDI ports 16 + 2 (device 0, as /dev/midi1
    // and /dev/dmmidi1) and 16 + 13 (device 1, as /dev/amidi1 and
    // /dev/admmidi1): snd-rawmidi's midi_map and amidi_map
    MIDI("/dev/midi1", 14, 18, 0),
    MIDI("/dev/dmmidi1", 14, 25, 0),
    MIDI("/dev/amidi1", 14, 29, 1),
    MIDI("/dev/admmidi1", 14, 30, 1),
    // ALSA's minors are dynamic (CONFIG_SND_DYNAMIC_MINORS), given out as
    // devices register: the sequencer, card 1's four raw MIDI devices and its
    // control, card 0's PCM, hwdep and control, then card 2's (loaded after
    // card 0 in the pinned guest, so the numbers hold at every boot), and the
    // timer at its fixed minor
    MIDI("/dev/snd/midiC1D0", 116, 2, 0),
    MIDI("/dev/snd/midiC1D1", 116, 3, 1),
    MIDI("/dev/snd/midiC1D2", 116, 4, 2),
    MIDI("/dev/snd/midiC1D3", 116, 5, 3),
    // the guest's nodes this design does not cover: opening one answers ENODEV
    NODE("/dev/snd/seq", 116, 1, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/snd/controlC1", 116, 6, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/snd/pcmC0D0p", 116, 7, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/snd/pcmC0D0c", 116, 8, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/snd/hwC0D0", 116, 9, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/snd/controlC0", 116, 10, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/snd/pcmC2D0p", 116, 11, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/snd/controlC2", 116, 12, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/snd/timer", 116, 33, 0660, DEVICE_UNSUPPORTED),
    // card 1's OSS mixer, which has no controls, and card 2's OSS devices:
    // the USB card FluidSynth plays on, as a program would find it
    NODE("/dev/mixer1", 14, 16, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/mixer2", 14, 32, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/dsp2", 14, 35, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/audio2", 14, 36, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/audio", 14, 4, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/dri/card0", 226, 0, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/input/mice", 13, 63, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/input/mouse0", 13, 32, 0660, DEVICE_UNSUPPORTED),
    NODE("/dev/input/mouse1", 13, 33, 0660, DEVICE_UNSUPPORTED),
    // joydev's node for the tablet, which has absolute axes
    NODE("/dev/input/js0", 13, 0, 0664, DEVICE_UNSUPPORTED),
    NODE("/dev/uinput", 10, 223, 0600, DEVICE_UNSUPPORTED),
};

#undef NODE
#undef INPUT
#undef MIDI
#undef VT

// udev's links, as the pinned guest's udev 257 makes them. The USB devices'
// name the controller's PCI address (00:04.0) and port, the tablet on port 1
// and the audio card on port 2, once as usb- and once as usbv2-; the
// tablet's serial is QEMU's, built from its port. Its "-mouse" links go to
// js0: joydev's node takes the name udev gives a device with absolute axes.
static const struct DeviceLink kDeviceLinks[] = {
    {"/dev/input/by-path/platform-i8042-serio-0-event-kbd", "../event0"},
    {"/dev/input/by-path/platform-i8042-serio-1-event-mouse", "../event1"},
    {"/dev/input/by-path/platform-i8042-serio-1-mouse", "../mouse0"},
    {"/dev/input/by-path/pci-0000:00:04.0-usb-0:1:1.0-event-mouse",
     "../event2"},
    {"/dev/input/by-path/pci-0000:00:04.0-usb-0:1:1.0-mouse", "../js0"},
    {"/dev/input/by-path/pci-0000:00:04.0-usbv2-0:1:1.0-event-mouse",
     "../event2"},
    {"/dev/input/by-path/pci-0000:00:04.0-usbv2-0:1:1.0-mouse", "../js0"},
    {"/dev/input/by-path/platform-pcspkr-event-spkr", "../event3"},
    {"/dev/input/by-path/platform-LNXPWRBN:00-event", "../event4"},
    {"/dev/input/by-id/usb-QEMU_QEMU_USB_Tablet_28754-0000:00:04.0-1-event-mouse",
     "../event2"},
    {"/dev/input/by-id/usb-QEMU_QEMU_USB_Tablet_28754-0000:00:04.0-1-mouse",
     "../js0"},
    {"/dev/snd/by-path/pci-0000:00:05.0", "../controlC0"},
    {"/dev/snd/by-path/platform-snd_virmidi.0", "../controlC1"},
    {"/dev/snd/by-path/pci-0000:00:04.0-usb-0:2:1.0", "../controlC2"},
    {"/dev/snd/by-path/pci-0000:00:04.0-usbv2-0:2:1.0", "../controlC2"},
    {"/dev/snd/by-id/usb-QEMU_QEMU_USB_Audio_1-0000:00:04.0-2-00",
     "../controlC2"},
    {"/dev/dri/by-path/pci-0000:00:01.0-card", "../card0"},
};

// struct input_event on x86-64: a timeval, then type, code and value.
#define INPUT_EVENT_SIZE 24

const struct DeviceNode *GetDeviceNodes(int *count) {
  *count = ARRAYLEN(kDeviceNodes);
  return kDeviceNodes;
}

const struct DeviceLink *GetDeviceLinks(int *count) {
  *count = ARRAYLEN(kDeviceLinks);
  return kDeviceLinks;
}

// The node's st_rdev as Emscripten's makedev() packs it, which is also what
// Linux's encoding gives for minors below 256.
u32 GetDeviceNumber(const struct DeviceNode *node) {
  return node->major << 8 | node->minor;
}

const struct DeviceNode *FindDeviceNode(u64 rdev) {
  int i;
  for (i = 0; i < ARRAYLEN(kDeviceNodes); ++i) {
    if (GetDeviceNumber(kDeviceNodes + i) == rdev) return kDeviceNodes + i;
  }
  return 0;
}

void NotifyUnsupportedDevice(const struct DeviceNode *node) {
#ifdef __EMSCRIPTEN__
  NotifyUnsupportedDeviceHost(node->path);
#endif
}

struct DeviceFile *RetainDeviceFile(struct DeviceFile *df) {
  if (df) ++df->references;
  return df;
}

void ReleaseDeviceFile(struct DeviceFile *df) {
  if (!df || --df->references) return;
  if (df->node->kind == DEVICE_INPUT) ReleaseEvdev(df);
  SoundRelease(df);
  free(df);
}

/* The open file description of the device a guest descriptor refers to, for
 * the callbacks, which are given the descriptor's number only. */
static struct DeviceFile *GetDeviceFile(int fildes) {
  struct Fd *fd;
  struct DeviceFile *df = 0;
  if (!g_machine) return 0;
  LOCK(&g_machine->system->fds.lock);
  if ((fd = GetFd(&g_machine->system->fds, fildes))) df = fd->device;
  UNLOCK(&g_machine->system->fds.lock);
  return df;
}

bool IsDeviceFd(const struct Fd *fd) {
  return fd->device != 0;
}

/* The descriptor's flags with the status flags of the open file description
 * it refers to, which a device keeps for every duplicate, as Linux keeps
 * them in its struct file. */
int DeviceFileFlags(const struct Fd *fd, int flags) {
  if (!fd->device) return flags;
  return (flags & ~SETFL_FLAGS) | fd->device->status;
}

void DeviceFileSetFlags(struct Fd *fd, int flags) {
  if (fd->device) fd->device->status = flags & SETFL_FLAGS;
}

/* Program time, the monotonic clock every device keeps its time on, in ns. */
i64 DeviceNow(void) {
  struct timespec now;
  HostNow(CLOCK_MONOTONIC, &now);
  return ToNanoseconds(now);
}

struct timespec DeviceTimespec(i64 ns) {
  struct timespec ts;
  if (ns < 0) ns = 0;
  ts.tv_sec = ns / 1000000000;
  ts.tv_nsec = ns % 1000000000;
  return ts;
}

/* A buffer that drains at `rate` units a second whenever it holds something,
 * kept lazily: nothing ticks, and how much it holds is worked out from the
 * Program time a call asks at. What drained is counted from when the buffer
 * last started draining, so no rounding builds up while it never runs dry. */
void DeviceDrainSet(struct DeviceDrain *d, u64 capacity, u64 rate) {
  memset(d, 0, sizeof(*d));
  d->capacity = capacity;
  d->rate = rate;
}

static u64 DeviceDrained(const struct DeviceDrain *d, i64 now) {
  unsigned __int128 drained;
  if (!d->queued || now <= d->start) return 0;
  drained = (unsigned __int128)(now - d->start) * d->rate / 1000000000;
  return drained < d->queued ? (u64)drained : d->queued;
}

u64 DeviceDrainLevel(struct DeviceDrain *d, i64 now) {
  u64 drained = DeviceDrained(d, now);
  if (drained == d->queued) {
    d->queued = 0;  // it ran dry
    return 0;
  }
  return d->queued - drained;
}

void DeviceDrainAdd(struct DeviceDrain *d, i64 now, u64 units) {
  DeviceDrainLevel(d, now);
  if (!d->queued) d->start = now;
  d->queued += units;
}

/* When at least `room` units are free, in Program time: `now` when they
 * already are. */
i64 DeviceDrainDeadline(struct DeviceDrain *d, i64 now, u64 room) {
  u64 level, target;
  unsigned __int128 ns;
  level = DeviceDrainLevel(d, now);
  if (room > d->capacity) room = d->capacity;
  if (level + room <= d->capacity) return now;
  // drained ≥ queued − (capacity − room), the first nanosecond it holds
  target = d->queued - (d->capacity - room);
  ns = ((unsigned __int128)target * 1000000000 + d->rate - 1) / d->rate;
  return d->start + (i64)ns;
}

// ------------------------------------------------------------------ callbacks

static int CloseDevice(int fildes) {
  return VfsClose(fildes);
}

static int NotTerminalGet(int fd, struct termios *tio) {
  return enotty();
}
static int NotTerminalSet(int fd, int action, const struct termios *tio) {
  return enotty();
}
static int NotTerminalSize(int fd, struct winsize *ws) {
  return enotty();
}
static int NotTerminalSetSize(int fd, const struct winsize *ws) {
  return enotty();
}

static size_t IovsSize(const struct iovec *iov, int iovcnt) {
  int i;
  size_t size;
  for (size = i = 0; i < iovcnt; ++i) size += iov[i].iov_len;
  return size;
}

// Reads and writes the devices have no semantics for: fbdev's come with M2;
// OSS's mixer has neither, and reading /dev/dsp is recording, not covered.
static ssize_t ReadNothing(int fildes, const struct iovec *iov, int iovcnt) {
  return einval();
}

static ssize_t WriteNothing(int fildes, const struct iovec *iov, int iovcnt) {
  return einval();
}

// A device whose reads never yield anything: nothing plays into the MIDI
// port, and no key reaches the virtual console on a serial-console machine.
// A blocking read waits in WaitForDeviceRead() before it gets here.
static ssize_t ReadNever(int fildes, const struct iovec *iov, int iovcnt) {
  return eagain();
}

// What the virtual console is written goes to a screen nobody sees.
static ssize_t WriteDiscarded(int fildes, const struct iovec *iov,
                              int iovcnt) {
  return IovsSize(iov, iovcnt);
}

// A device without a poll of its own, which Linux reports always ready.
static int PollReady(struct pollfd *fds, nfds_t nfds, int timeout) {
  nfds_t i;
  int ready;
  for (ready = i = 0; i < nfds; ++i) {
    fds[i].revents = fds[i].events & (POLLIN | POLLOUT);
    if (fds[i].revents) ++ready;
  }
  return ready;
}

// Writable, never readable: the MIDI port's input, the console's keyboard.
static int PollWritable(struct pollfd *fds, nfds_t nfds, int timeout) {
  nfds_t i;
  int ready;
  for (ready = i = 0; i < nfds; ++i) {
    fds[i].revents = fds[i].events & POLLOUT;
    if (fds[i].revents) ++ready;
  }
  return ready;
}

static int IoctlUnknown(struct Machine *m, int fildes, u64 request, i64 addr) {
  return enotty();
}

// Linux's str_to_user(): the string and its NUL, cut to the buffer's size and
// then not terminated, and the length copied.
int IoctlString(struct Machine *m, const char *string, u64 request,
                i64 addr) {
  u32 size;
  if (!string) {
    errno = ENOENT;
    return -1;
  }
  size = MIN(strlen(string) + 1, IOC_SIZE(request));
  if (CopyToUserWrite(m, addr, (void *)string, size) == -1) return efault();
  return size;
}

#define DEVICE_CB(READ, WRITE, POLL, IOCTL) \
  {                                         \
      .close = CloseDevice,                 \
      .readv = READ,                        \
      .writev = WRITE,                      \
      .poll = POLL,                         \
      .tcgetattr = NotTerminalGet,          \
      .tcsetattr = NotTerminalSet,          \
      .tcgetwinsize = NotTerminalSize,      \
      .tcsetwinsize = NotTerminalSetSize,   \
      .ioctl = IOCTL,                       \
  }

static const struct FdCb kFdCbFramebuffer =
    DEVICE_CB(ReadFramebuffer, WriteFramebuffer, PollReady, IoctlFramebuffer);
static const struct FdCb kFdCbInput =
    DEVICE_CB(ReadEvdev, WriteEvdev, PollEvdev, IoctlEvdev);
// the dsp's and the port's writes go through WriteDevice(), which paces them
static const struct FdCb kFdCbDsp =
    DEVICE_CB(ReadNothing, WriteNothing, OssPoll, OssIoctl);
static const struct FdCb kFdCbMixer =
    DEVICE_CB(ReadNothing, WriteNothing, PollReady, MixerIoctl);
static const struct FdCb kFdCbMidi =
    DEVICE_CB(ReadNever, WriteNothing, MidiPoll, MidiIoctl);
static const struct FdCb kFdCbConsole =
    DEVICE_CB(ReadNever, WriteDiscarded, PollWritable, ConsoleIoctl);

const struct FdCb *GetDeviceCb(const struct DeviceNode *node) {
  switch (node->kind) {
    case DEVICE_FRAMEBUFFER:
      return &kFdCbFramebuffer;
    case DEVICE_INPUT:
      return &kFdCbInput;
    case DEVICE_DSP:
      return &kFdCbDsp;
    case DEVICE_MIXER:
      return &kFdCbMixer;
    case DEVICE_MIDI:
      return &kFdCbMidi;
    case DEVICE_CONSOLE:
      return &kFdCbConsole;
    default:
      return 0;
  }
}

/* Gives a descriptor open() just made the device's callbacks and a new open
 * file description. */
int OpenDevice(struct Machine *m, struct Fd *fd, const struct DeviceNode *node) {
  struct DeviceFile *df;
  if (!(df = (struct DeviceFile *)calloc(1, sizeof(*df)))) return enomem();
  df->references = 1;
  df->node = node;
  df->status = fd->oflags & SETFL_FLAGS;
  if (IsSoundDevice(node) && SoundOpen(df, fd->oflags) == -1) {
    free(df);
    return -1;
  }
  if (node->kind == DEVICE_FRAMEBUFFER && OpenFramebuffer() == -1) {
    free(df);
    return -1;
  }
  // each open of an input device is a reader of its own (evdev.c)
  if (node->kind == DEVICE_INPUT && OpenEvdev(df) == -1) {
    free(df);
    return -1;
  }
  fd->cb = GetDeviceCb(node);
  fd->device = df;
  return 0;
}

/* What can end a wait on `fd` for `events` (POLLIN, POLLOUT), as WAKE_* bits:
 * the terminal's input, or events reaching an input device the host delivers
 * to. A device's timed readiness is a deadline instead (see
 * GetFdReadyDeadline()). */
u32 GetFdWakeSources(const struct Fd *fd, int events) {
  if (!(events & POLLIN) || !fd->device) return 0;
  if (fd->device->node->kind != DEVICE_INPUT) return 0;
  switch (fd->device->node->input) {
    case INPUT_KEYBOARD:
      return WAKE_KEYBOARD;
    case INPUT_TABLET:
      return WAKE_TABLET;
    default:
      return 0;
  }
}

/* When a device that keeps time becomes ready for `events`, in Program time,
 * or -1 when nothing but an event from outside can make it ready: a sound
 * device with room to write, or the PC Speaker device's reader when
 * KDMKTONE's timer may complete its packet (EvdevReadyDeadline()). */
i64 GetFdReadyDeadline(const struct Fd *fd, int events) {
  i64 at = -1, sound;
  struct DeviceFile *df = fd->device;
  if (!df) return -1;
  if ((events & POLLIN) && df->node->kind == DEVICE_INPUT) {
    at = EvdevReadyDeadline(df);
  }
  if ((events & POLLOUT) && (sound = SoundReadyDeadline(df, events)) >= 0 &&
      (at < 0 || sound < at)) {
    at = sound;
  }
  return at;
}

/* Halts a blocking read a device has nothing for, before the read sets
 * anything up, as WaitForTerminalInput() does: the read starts over when the
 * host resumes it. Returns -1 with errno for a read the device refuses, and
 * 0 for a read that goes on to the device's readv(). */
int WaitForDeviceRead(struct Machine *m, int fildes, u64 size, int oflags) {
  u32 wake;
  i64 ready = -1;
  struct Fd *fd;
  struct DeviceFile *df;
  LOCK(&m->system->fds.lock);
  df = (fd = GetFd(&m->system->fds, fildes)) ? fd->device : 0;
  wake = fd ? GetFdWakeSources(fd, POLLIN) : 0;
  UNLOCK(&m->system->fds.lock);
  if (!df || !size) return 0;
  switch (df->node->kind) {
    case DEVICE_INPUT:
      // evdev refuses a buffer that cannot hold one event, waiting or not
      if (size < INPUT_EVENT_SIZE) return einval();
      if (!EvdevReadWaits(df)) return 0;
      // once the reader is settled: a KDMKTONE timer still to come
      ready = EvdevReadyDeadline(df);
      break;
    case DEVICE_MIDI:
    case DEVICE_CONSOLE:
      break;
    default:
      return 0;
  }
  if (oflags & O_NONBLOCK) return 0;
  if (GuestWaitInterruptedRestartable(m)) return eintr();
  if (ready >= 0) {
    GuestWaitHaltWake(m, GetMaxTime(), wake, DeviceTimespec(ready));
  }
  GuestWaitHalt(m, GetMaxTime(), wake);
}

/* Whether a read (or, with `write`, a write) of `fildes` journals what it
 * does, so that it is no Undo barrier: an input device's reads and writes
 * (evdev.c), and what a write queues on /dev/dsp or the MIDI port (sound.c).
 * The framebuffer journals the calls that reach it itself
 * (FramebufferJournalsSyscall()); every other device's read or write that
 * moves something stays a barrier. */
bool IsJournaledDeviceFildes(struct Machine *m, int fildes, bool write) {
  bool journaled = false;
  struct Fd *fd;
  LOCK(&m->system->fds.lock);
  if ((fd = GetFd(&m->system->fds, fildes)) && fd->device) {
    switch (fd->device->node->kind) {
      case DEVICE_INPUT:
        journaled = true;
        break;
      case DEVICE_DSP:
      case DEVICE_MIDI:
        journaled = write;
        break;
      default:
        break;
    }
  }
  UNLOCK(&m->system->fds.lock);
  return journaled;
}

/* Whether writes to `fildes` go through WriteDevice(). */
bool IsPacedDevice(struct Machine *m, int fildes) {
  bool paced;
  struct Fd *fd;
  LOCK(&m->system->fds.lock);
  paced = (fd = GetFd(&m->system->fds, fildes)) && fd->device &&
          (fd->device->node->kind == DEVICE_DSP ||
           fd->device->node->kind == DEVICE_MIDI);
  UNLOCK(&m->system->fds.lock);
  return paced;
}

/* What kind of device `fildes` is (DEVICE_*), or 0 for anything else. */
int GetDeviceKind(struct Machine *m, int fildes) {
  int kind;
  struct Fd *fd;
  LOCK(&m->system->fds.lock);
  kind = (fd = GetFd(&m->system->fds, fildes)) && fd->device
             ? fd->device->node->kind
             : 0;
  UNLOCK(&m->system->fds.lock);
  return kind;
}

/* Whether `fd` is a device without a file position: every one but the
 * framebuffer. Linux opens them with stream_open() (evdev, the raw MIDI
 * port) or nonseekable_open() (OSS's dsp and mixer, the console's tty), which
 * take lseek(), pread() and pwrite() away from the file: ESPIPE, before the
 * call looks at anything else of the file or waits. */
bool IsDeviceFdUnseekable(const struct Fd *fd) {
  return fd->device && fd->device->node->kind != DEVICE_FRAMEBUFFER;
}

bool IsUnseekableDeviceFildes(struct Machine *m, int fildes) {
  bool unseekable;
  struct Fd *fd;
  LOCK(&m->system->fds.lock);
  unseekable =
      (fd = GetFd(&m->system->fds, fildes)) && IsDeviceFdUnseekable(fd);
  UNLOCK(&m->system->fds.lock);
  return unseekable;
}

/* Forgets the progress of a blocking write that instruction `identity` made,
 * which Undo of that instruction takes back. */
void DeviceForgetProgress(u64 identity) {
  struct Dll *e;
  struct Fd *fd;
  if (!g_machine || !identity) return;
  LOCK(&g_machine->system->fds.lock);
  for (e = dll_first(g_machine->system->fds.list); e;
       e = dll_next(g_machine->system->fds.list, e)) {
    fd = FD_CONTAINER(e);
    if (fd->device && fd->device->progress_identity == identity) {
      fd->device->progress_identity = 0;
      fd->device->progress = 0;
    }
  }
  UNLOCK(&g_machine->system->fds.lock);
}

/* A write to a device whose buffer drains in Program time, /dev/dsp or the
 * raw MIDI port (sound.c): it queues what fits and, unless O_NONBLOCK, waits
 * for room until every byte is queued, as a blocking write on Linux does.
 *
 * Blink runs a blocked instruction again from its start once the wait ends,
 * so the write keeps what it queued in the open file description, under the
 * instruction's identity; the write run again goes on from there, and Undo
 * of that instruction forgets it. */
i64 WriteDevice(struct Machine *m, int fildes,
                const struct GuestSegment *segments, u32 count, int oflags) {
  return SoundWrite(m, fildes, segments, count, oflags);
}

/* How many bytes `segments` hold in all, no more than one call moves on
 * Linux (MAX_RW_COUNT), so the sum never wraps; the system calls cut them to
 * that already. */
u64 GuestSegmentsSize(const struct GuestSegment *segments, u32 count) {
  u32 i;
  u64 size;
  for (size = i = 0; i < count; ++i) {
    size += MIN(segments[i].len, MAX_RW_COUNT_LINUX - size);
  }
  return size;
}

/* WriteDevice() for a writev()'s vectors. Linux takes at most MAX_RW_COUNT
 * bytes in one call, the vectors past that cut short (__import_iovec()), so
 * their total never overflows. */
i64 WriteDeviceGuestIovs(struct Machine *m, int fildes, i64 iovaddr, u32 iovlen,
                         int oflags) {
  u32 i;
  i64 rc;
  u64 len, total;
  struct GuestSegment *segments;
  const struct iovec_linux *iovs;
  if (!iovlen) return 0;
  if (!(iovs = (const struct iovec_linux *)SchlepR(
            m, iovaddr, iovlen * sizeof(struct iovec_linux)))) {
    return -1;
  }
  if (!(segments = (struct GuestSegment *)malloc(iovlen * sizeof(*segments)))) {
    return enomem();
  }
  for (total = i = 0; i < iovlen; ++i) {
    len = Read64(iovs[i].len);
    if (len > MAX_RW_COUNT_LINUX - total) len = MAX_RW_COUNT_LINUX - total;
    segments[i].addr = Read64(iovs[i].base);
    segments[i].len = len;
    total += len;
  }
  // the system call frees it, or the run loop if the write halts to wait;
  // AddToFreeList() frees it itself when it fails
  if (!AddToFreeList(m, segments)) return enomem();
  rc = WriteDevice(m, fildes, segments, iovlen, oflags);
  return rc;
}

/* What close() of `fildes` waits for before it releases the device, when it
 * is the last descriptor of the description: a sound device's queue playing
 * out. It halts the instruction while it waits and returns once it is done;
 * the descriptor is still there when the instruction starts over. */
void DeviceCloseWait(struct Machine *m, int fildes) {
  struct Fd *fd;
  struct DeviceFile *df;
  LOCK(&m->system->fds.lock);
  df = (fd = GetFd(&m->system->fds, fildes)) ? fd->device : 0;
  UNLOCK(&m->system->fds.lock);
  if (df && df->sound) SoundCloseWait(m, df);
}

// ---------------------------------------------------------- exports for the wrapper

EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_device_count(void) {
  return ARRAYLEN(kDeviceNodes);
}

EMSCRIPTEN_KEEPALIVE
const char *blinkenlib_device_path(u32 index) {
  return index < ARRAYLEN(kDeviceNodes) ? kDeviceNodes[index].path : 0;
}

/* The node's st_rdev, for FS.mkdev(). */
EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_device_number(u32 index) {
  return index < ARRAYLEN(kDeviceNodes) ? GetDeviceNumber(kDeviceNodes + index)
                                        : 0;
}

EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_device_mode(u32 index) {
  return index < ARRAYLEN(kDeviceNodes) ? kDeviceNodes[index].mode : 0;
}

EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_device_kind(u32 index) {
  return index < ARRAYLEN(kDeviceNodes) ? kDeviceNodes[index].kind : 0;
}

EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_device_link_count(void) {
  return ARRAYLEN(kDeviceLinks);
}

EMSCRIPTEN_KEEPALIVE
const char *blinkenlib_device_link_path(u32 index) {
  return index < ARRAYLEN(kDeviceLinks) ? kDeviceLinks[index].path : 0;
}

EMSCRIPTEN_KEEPALIVE
const char *blinkenlib_device_link_target(u32 index) {
  return index < ARRAYLEN(kDeviceLinks) ? kDeviceLinks[index].target : 0;
}
