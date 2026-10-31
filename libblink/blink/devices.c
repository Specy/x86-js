/* The devices a program reaches through /dev, as the QEMU guest that x86's
 * devices follow has them (docs/design/x86-devices.md, ADR 0067).
 *
 * This file holds their one table: each node's path, its device number and
 * what it is; the udev links to them; the input devices' identities. The
 * wrapper makes the nodes, the links and /proc/bus/input/devices from it
 * before any program starts, and an open() finds what it opened here by the
 * device number of the node it reached, so a path through a link opens the
 * same device and stat() answers as on Linux. The numbers, the names and the
 * links are Linux's conventional ones for that machine, provisional until the
 * pinned guest's own are recorded (M0 of x86-devices-plan.md); the comments
 * say which are least certain.
 *
 * Each device is a struct FdCb of its own. What open() made is the open file
 * description, a struct DeviceFile that dup() shares and the last close()
 * releases, as Linux's struct file is. Their semantics come with the
 * milestones that follow this one: until then a device opens, answers ENOTTY
 * to the ioctls it does not know yet, and reads and writes as said below. */
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
#include "blink/fbdev.h"
#include "blink/linux.h"
#include "blink/macros.h"
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

static const struct DeviceNode kDeviceNodes[] = {
    {"/dev/fb0", 29, 0, 0660, DEVICE_FRAMEBUFFER, -1},
    {"/dev/tty0", 4, 0, 0620, DEVICE_CONSOLE, -1},
    {"/dev/input/event0", 13, 64, 0660, DEVICE_INPUT, INPUT_POWER_BUTTON},
    {"/dev/input/event1", 13, 65, 0660, DEVICE_INPUT, INPUT_KEYBOARD},
    {"/dev/input/event2", 13, 66, 0660, DEVICE_INPUT, INPUT_MOUSE},
    {"/dev/input/event3", 13, 67, 0660, DEVICE_INPUT, INPUT_TABLET},
    {"/dev/input/event4", 13, 68, 0660, DEVICE_INPUT, INPUT_SPEAKER},
    {"/dev/mixer", 14, 0, 0660, DEVICE_MIXER, -1},
    {"/dev/dsp", 14, 3, 0660, DEVICE_DSP, -1},
    // OSS numbers a card's raw MIDI port 16 × card + 2: card 1 is snd-virmidi
    {"/dev/midi1", 14, 18, 0660, DEVICE_MIDI, -1},
    // ALSA's minors are dynamic on Debian; these are the static scheme's
    // (card × 32, + 8 for raw MIDI, + 16 and + 24 for playback and capture)
    {"/dev/snd/midiC1D0", 116, 40, 0660, DEVICE_MIDI, -1},
    // the guest's nodes this design does not cover: opening one answers ENODEV
    {"/dev/dri/card0", 226, 0, 0660, DEVICE_UNSUPPORTED, -1},
    {"/dev/snd/controlC0", 116, 0, 0660, DEVICE_UNSUPPORTED, -1},
    {"/dev/snd/pcmC0D0p", 116, 16, 0660, DEVICE_UNSUPPORTED, -1},
    {"/dev/snd/pcmC0D0c", 116, 24, 0660, DEVICE_UNSUPPORTED, -1},
    {"/dev/snd/seq", 116, 1, 0660, DEVICE_UNSUPPORTED, -1},
    {"/dev/input/mice", 13, 63, 0660, DEVICE_UNSUPPORTED, -1},
    {"/dev/input/mouse0", 13, 32, 0660, DEVICE_UNSUPPORTED, -1},
    {"/dev/input/mouse1", 13, 33, 0660, DEVICE_UNSUPPORTED, -1},
    {"/dev/audio", 14, 4, 0660, DEVICE_UNSUPPORTED, -1},
};

// udev's links. The tablet's name the USB controller's PCI address, which the
// pinned guest fixes and these guess; its serial is QEMU's, built from it.
static const struct DeviceLink kDeviceLinks[] = {
    {"/dev/input/by-path/platform-i8042-serio-0-event-kbd", "../event1"},
    {"/dev/input/by-path/platform-i8042-serio-1-event-mouse", "../event2"},
    {"/dev/input/by-path/platform-i8042-serio-1-mouse", "../mouse0"},
    {"/dev/input/by-path/platform-pcspkr-event-spkr", "../event4"},
    {"/dev/input/by-path/pci-0000:00:04.0-usb-0:1:1.0-event-mouse",
     "../event3"},
    {"/dev/input/by-path/pci-0000:00:04.0-usb-0:1:1.0-mouse", "../mouse1"},
    {"/dev/input/by-id/usb-QEMU_QEMU_USB_Tablet_28754-0000:00:04.0-1-event-mouse",
     "../event3"},
    {"/dev/input/by-id/usb-QEMU_QEMU_USB_Tablet_28754-0000:00:04.0-1-mouse",
     "../mouse1"},
};

// What EVIOCGNAME, EVIOCGPHYS, EVIOCGUNIQ and EVIOCGID answer and
// /proc/bus/input/devices lists. The input numbers and the sysfs paths are
// the least certain: they depend on the order the guest probes its devices.
struct InputIdentity {
  const char *name, *phys, *uniq, *sysfs, *handlers, *bits;
  u16 bustype, vendor, product, version;
};

static const struct InputIdentity kInputIdentities[INPUT_DEVICES] = {
    {"Power Button", "LNXPWRBN/button/input0", 0,
     "/devices/LNXSYSTM:00/LNXPWRBN:00/input/input0", "kbd event0",
     "B: PROP=0\nB: EV=3\nB: KEY=10000000000000 0\n", 0x19, 0, 1, 0},
    {"AT Translated Set 2 keyboard", "isa0060/serio0/input0", 0,
     "/devices/platform/i8042/serio0/input/input1", "sysrq kbd event1 leds",
     "B: PROP=0\nB: EV=120013\n"
     "B: KEY=402000000 3803078f800d001 feffffdfffefffff fffffffffffffffe\n"
     "B: MSC=10\nB: LED=7\n",
     0x11, 1, 1, 0xab41},
    // with vmport=off the PS/2 mouse is the IntelliMouse Explorer QEMU emulates
    {"ImExPS/2 Generic Explorer Mouse", "isa0060/serio1/input0", 0,
     "/devices/platform/i8042/serio1/input/input2", "mouse0 event2",
     "B: PROP=1\nB: EV=7\nB: KEY=1f0000 0 0 0 0\nB: REL=143\n", 0x11, 2, 6,
     0},
    {"QEMU QEMU USB Tablet", "usb-0000:00:04.0-1/input0",
     "28754-0000:00:04.0-1",
     "/devices/pci0000:00/0000:00:04.0/usb1/1-1/1-1:1.0/0003:0627:0001.0001/"
     "input/input3",
     "mouse1 event3",
     "B: PROP=0\nB: EV=1f\nB: KEY=70000 0 0 0 0\nB: REL=900\nB: ABS=3\n"
     "B: MSC=10\n",
     0x03, 0x627, 1, 1},
    {"PC Speaker", "isa0061/input0", 0, "/devices/platform/pcspkr/input/input4",
     "kbd event4", "B: PROP=0\nB: EV=40001\nB: SND=6\n", 0x10, 0x1f, 1,
     0x100},
};

// The raw MIDI port's pacing: MIDI's 31,250 baud, ten bits a byte, behind a
// 4 KiB buffer (x86-devices.md, "The raw MIDI port").
#define MIDI_BYTES_PER_SECOND 3125
#define MIDI_BUFFER_BYTES     4096

// struct input_event on x86-64: a timeval, then type, code and value.
#define INPUT_EVENT_SIZE 24

// evdev's ioctls ('E'); what is answered before M3 is a device's identity.
#define EVIOCGVERSION_LINUX 0x80044501
#define EVIOCGID_LINUX      0x80084502
#define EVDEV_VERSION_LINUX 0x010001

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
  if (df && !--df->references) free(df);
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

// Reads and writes the devices have no semantics for before their milestone:
// fbdev's come with M2, OSS's with M4.
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

// No input event reaches a reader before M3 delivers them.
static ssize_t ReadInput(int fildes, const struct iovec *iov, int iovcnt) {
  if (IovsSize(iov, iovcnt) < INPUT_EVENT_SIZE) return einval();
  return eagain();
}

// Whole events are written, as evdev takes them; what they do comes with M3.
static ssize_t WriteInput(int fildes, const struct iovec *iov, int iovcnt) {
  size_t size = IovsSize(iov, iovcnt);
  if (size && size < INPUT_EVENT_SIZE) return einval();
  return size - size % INPUT_EVENT_SIZE;
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

// Writable, never readable: evdev with no events queued, the MIDI port's
// input, the console's keyboard.
static int PollWritable(struct pollfd *fds, nfds_t nfds, int timeout) {
  nfds_t i;
  int ready;
  for (ready = i = 0; i < nfds; ++i) {
    fds[i].revents = fds[i].events & POLLOUT;
    if (fds[i].revents) ++ready;
  }
  return ready;
}

// Writable while its buffer has room.
static int PollMidi(struct pollfd *fds, nfds_t nfds, int timeout) {
  nfds_t i;
  int ready;
  struct DeviceFile *df;
  for (ready = i = 0; i < nfds; ++i) {
    fds[i].revents = 0;
    if ((df = GetDeviceFile(fds[i].fd)) &&
        DeviceDrainLevel(&df->drain, DeviceNow()) < df->drain.capacity) {
      fds[i].revents = fds[i].events & POLLOUT;
    }
    if (fds[i].revents) ++ready;
  }
  return ready;
}

static int IoctlUnknown(struct Machine *m, int fildes, u64 request, i64 addr) {
  return enotty();
}

// Linux's str_to_user(): the string and its NUL, cut to the buffer's size and
// then not terminated, and the length copied.
static int IoctlString(struct Machine *m, const char *string, u64 request,
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

static int IoctlInput(struct Machine *m, int fildes, u64 request, i64 addr) {
  u8 id[8];
  struct DeviceFile *df;
  const struct InputIdentity *identity;
  if (!(df = GetDeviceFile(fildes))) return ebadf();
  identity = kInputIdentities + df->node->input;
  switch (request) {
    case EVIOCGVERSION_LINUX:
      Write32(id, EVDEV_VERSION_LINUX);
      return CopyToUserWrite(m, addr, id, 4) == -1 ? efault() : 0;
    case EVIOCGID_LINUX:
      Write16(id + 0, identity->bustype);
      Write16(id + 2, identity->vendor);
      Write16(id + 4, identity->product);
      Write16(id + 6, identity->version);
      return CopyToUserWrite(m, addr, id, 8) == -1 ? efault() : 0;
    default:
      break;
  }
  if (IOC_MATCHES(request, IOC_READ_LINUX, 'E', 0x06)) {  // EVIOCGNAME(len)
    return IoctlString(m, identity->name, request, addr);
  }
  if (IOC_MATCHES(request, IOC_READ_LINUX, 'E', 0x07)) {  // EVIOCGPHYS(len)
    return IoctlString(m, identity->phys, request, addr);
  }
  if (IOC_MATCHES(request, IOC_READ_LINUX, 'E', 0x08)) {  // EVIOCGUNIQ(len)
    return IoctlString(m, identity->uniq, request, addr);
  }
  return enotty();
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
    DEVICE_CB(ReadInput, WriteInput, PollWritable, IoctlInput);
static const struct FdCb kFdCbDsp =
    DEVICE_CB(ReadNothing, WriteNothing, PollReady, IoctlUnknown);
static const struct FdCb kFdCbMixer =
    DEVICE_CB(ReadNothing, WriteNothing, PollReady, IoctlUnknown);
// writes go through WriteDevice(), which paces them
static const struct FdCb kFdCbMidi =
    DEVICE_CB(ReadNever, WriteNothing, PollMidi, IoctlUnknown);
static const struct FdCb kFdCbConsole =
    DEVICE_CB(ReadNever, WriteDiscarded, PollWritable, IoctlUnknown);

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
  if (node->kind == DEVICE_MIDI) {
    DeviceDrainSet(&df->drain, MIDI_BUFFER_BYTES, MIDI_BYTES_PER_SECOND);
  }
  if (node->kind == DEVICE_FRAMEBUFFER && OpenFramebuffer() == -1) {
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
 * or -1 when nothing but an event from outside can make it ready. */
i64 GetFdReadyDeadline(const struct Fd *fd, int events) {
  struct DeviceFile *df = fd->device;
  if (!df || !(events & POLLOUT)) return -1;
  if (df->node->kind == DEVICE_MIDI) {
    return DeviceDrainDeadline(&df->drain, DeviceNow(), 1);
  }
  return -1;
}

/* Halts a blocking read a device has nothing for, before the read sets
 * anything up, as WaitForTerminalInput() does: the read starts over when the
 * host resumes it. Returns -1 with errno for a read the device refuses, and
 * 0 for a read that goes on to the device's readv(). */
int WaitForDeviceRead(struct Machine *m, int fildes, u64 size, int oflags) {
  u32 wake;
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
      break;
    case DEVICE_MIDI:
    case DEVICE_CONSOLE:
      break;
    default:
      return 0;
  }
  if (oflags & O_NONBLOCK) return 0;
  if (GuestWaitInterruptedRestartable(m)) return eintr();
  GuestWaitHalt(m, GetMaxTime(), wake);
}

/* Whether writes to `fildes` go through WriteDevice(). */
bool IsPacedDevice(struct Machine *m, int fildes) {
  bool paced;
  struct Fd *fd;
  LOCK(&m->system->fds.lock);
  paced = (fd = GetFd(&m->system->fds, fildes)) && fd->device &&
          fd->device->node->kind == DEVICE_MIDI;
  UNLOCK(&m->system->fds.lock);
  return paced;
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

static i64 FinishWrite(struct DeviceFile *df) {
  i64 done = df->progress;
  df->progress = 0;
  df->progress_identity = 0;
  return done;
}

/* Reads `size` bytes at `offset` of what the segments hold together, checked
 * as a write's buffer is; -1 with EFAULT when one is not readable. */
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

/* A write to a device whose buffer drains in Program time, the raw MIDI port
 * for now: it queues what fits and, unless O_NONBLOCK, waits for room until
 * every byte is queued, as a blocking write on Linux does.
 *
 * Blink runs a blocked instruction again from its start once the wait ends,
 * so the write keeps what it queued in the open file description, under the
 * instruction's identity; the write run again goes on from there, and Undo
 * of that instruction forgets it. The wait lasts until the rest fits or the
 * buffer is empty, which returns when Linux's would: once the last byte is
 * queued. The guest's bytes are only read, so nothing here is journaled. */
i64 WriteDevice(struct Machine *m, int fildes,
                const struct GuestSegment *segments, u32 count, int oflags) {
  i64 now;
  u32 i;
  u64 size, room, take, n, identity;
  u8 chunk[512];
  struct DeviceFile *df;
  if (!(df = GetDeviceFile(fildes))) return ebadf();
  for (size = i = 0; i < count; ++i) size += segments[i].len;
  if (!size) return 0;
  identity = blinkenlib_active_instruction();
  if (df->progress_identity != identity) {
    df->progress_identity = identity;
    df->progress = 0;
  }
  for (;;) {
    now = DeviceNow();
    room = df->drain.capacity - DeviceDrainLevel(&df->drain, now);
    take = MIN(room, size - df->progress);
    while (take) {
      n = MIN(take, sizeof(chunk));
      // the bytes are checked and read as a write's are; M4 plays them
      if (CopySegments(m, segments, count, df->progress, chunk, n) == -1) {
        if (df->progress) return FinishWrite(df);
        FinishWrite(df);
        return efault();
      }
      DeviceDrainAdd(&df->drain, now, n);
      df->progress += n;
      take -= n;
    }
    if (df->progress == size) return FinishWrite(df);
    if (oflags & O_NONBLOCK) {
      return df->progress ? FinishWrite(df) : eagain();
    }
    // a signal ends a write that queued something with what it queued, and
    // is delivered as the call returns; one that queued nothing restarts or
    // fails with EINTR as every other wait does
    if (df->progress && (GuestWaitCancelled() || (m->signals & ~m->sigmask))) {
      return FinishWrite(df);
    }
    if (!df->progress && GuestWaitInterruptedRestartable(m)) {
      FinishWrite(df);
      return eintr();
    }
    room = MIN(size - df->progress, df->drain.capacity);
    if (DeviceDrainDeadline(&df->drain, now, room) <= now) continue;
    GuestWaitHaltWake(m, GetMaxTime(), 0,
                      DeviceTimespec(DeviceDrainDeadline(&df->drain, now, room)));
  }
}

/* WriteDevice() for a writev()'s vectors. */
i64 WriteDeviceGuestIovs(struct Machine *m, int fildes, i64 iovaddr, u32 iovlen,
                         int oflags) {
  u32 i;
  i64 rc;
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
  for (i = 0; i < iovlen; ++i) {
    segments[i].addr = Read64(iovs[i].base);
    segments[i].len = Read64(iovs[i].len);
  }
  // the system call frees it, or the run loop if the write halts to wait
  if (!AddToFreeList(m, segments)) return enomem();
  rc = WriteDevice(m, fildes, segments, iovlen, oflags);
  return rc;
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

/* /proc/bus/input/devices: each input device as the kernel's
 * input_devices_seq_show() prints it, in /dev/input's order. */
EMSCRIPTEN_KEEPALIVE
const char *blinkenlib_input_devices_text(void) {
  int i, n;
  size_t used;
  static char text[4096];
  const struct InputIdentity *d;
  for (used = i = 0; i < INPUT_DEVICES; ++i) {
    d = kInputIdentities + i;
    n = snprintf(text + used, sizeof(text) - used,
                 "I: Bus=%04x Vendor=%04x Product=%04x Version=%04x\n"
                 "N: Name=\"%s\"\n"
                 "P: Phys=%s\n"
                 "S: Sysfs=%s\n"
                 "U: Uniq=%s\n"
                 "H: Handlers=%s \n"
                 "%s\n",
                 d->bustype, d->vendor, d->product, d->version, d->name,
                 d->phys ? d->phys : "", d->sysfs, d->uniq ? d->uniq : "",
                 d->handlers, d->bits);
    unassert(n > 0 && n < sizeof(text) - used);
    used += n;
  }
  return text;
}
