/* /dev/fb0, as Linux 7.2's DRM fbdev emulation answers on the QEMU guest's
 * bochs display (docs/design/x86-devices.md, "Screen size and format" and
 * "Double buffering and the vsync wait"; docs/research/x86-reference-guest.md):
 * the fbdev emulation's shadow buffer behind fb_chrdev.c, with
 * drm_fb_helper.c's screen information, check and pan.
 *
 * bochs-drm has a vertical blank on 7.2, from a timer at the mode's 60 Hz,
 * and the emulation's pan is an atomic commit that waits for it: a pan
 * returns at the next refresh, a pan to the page already shown too, and an
 * FBIOPUT_VSCREENINFO that changes anything at the second, its mode's commit
 * taking one and its pan the next. Each is a wait on Program time with that
 * deadline (in a Testcase the virtual clock), as FBIO_WAITFORVSYNC is.
 *
 * The scanout shows the mode the Display configuration set at the program's
 * start (setDisplayMode(), the guest's video=), XRGB8888, over a buffer twice
 * as tall (drm_kms_helper.drm_fbdev_overalloc=200). The buffer is one host
 * allocation, made black when /dev/fb0 is first opened and kept until the
 * next program starts: mmap() points the guest's page entries into it (see
 * MapFramebuffer() and ReserveVirtual()), read(), write() and their relatives
 * reach the same bytes, and the wrapper reads the page the scanout shows
 * straight out of the wasm heap.
 *
 * Undo: a store through a mapping is an ordinary memory write, journaled by
 * the machine. What else changes the device is journaled here, with the kinds
 * in fbdev.h: the screen information, the pan and the blank an ioctl changed,
 * a file offset a read, a write or lseek() moved, and the bytes a write()
 * replaced. Opening the device and mapping it stay Undo barriers, as every
 * descriptor and mapping change is. */
#include "blink/fbdev.h"

#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#include "blink/blinkenlib.h"
#include "blink/debughistory.h"
#include "blink/devices.h"
#include "blink/endian.h"
#include "blink/environment.h"
#include "blink/errno.h"
#include "blink/linux.h"
#include "blink/macros.h"
#include "blink/thread.h"
#include "blink/timespec.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// A listener that throws must not unwind through the system call that
// presented the page.
EM_JS(void, NotifyFramebufferPresentHost, (u32 yoffset), {
  try {
    if (Module.blinkFramebufferPresent) Module.blinkFramebufferPresent(yoffset);
  } catch (error) {
    setTimeout(() => { throw error; }, 0);
  }
});
#endif

// fbdev's requests (<linux/fb.h>), which fb_ioctl() matches exactly.
#define FBIOGET_VSCREENINFO_LINUX 0x4600
#define FBIOPUT_VSCREENINFO_LINUX 0x4601
#define FBIOGET_FSCREENINFO_LINUX 0x4602
#define FBIOPAN_DISPLAY_LINUX     0x4606
#define FBIO_CURSOR_LINUX         0xc0684608
#define FBIOBLANK_LINUX           0x4611
#define FBIO_WAITFORVSYNC_LINUX   0x40044620

#define FB_ACTIVATE_NOW_LINUX      0
#define FB_ACTIVATE_MASK_LINUX     15
#define FB_ACTIVATE_FORCE_LINUX    128
#define FB_ACTIVATE_INV_MODE_LINUX 256
#define FB_ACTIVATE_KD_TEXT_LINUX  512
#define FB_VMODE_MASK_LINUX        255
#define FB_VMODE_YWRAP_LINUX       256
#define FB_BLANK_POWERDOWN_LINUX   4
#define FB_TYPE_PACKED_PIXELS_LINUX 0
#define FB_VISUAL_TRUECOLOR_LINUX  2

// struct fb_var_screeninfo, 160 bytes of 32-bit fields
#define VAR_SIZE         160
#define VAR_XRES         0
#define VAR_YRES         4
#define VAR_XRES_VIRTUAL 8
#define VAR_YRES_VIRTUAL 12
#define VAR_XOFFSET      16
#define VAR_YOFFSET      20
#define VAR_BPP          24
#define VAR_GRAYSCALE    28
#define VAR_RED          32  // each bitfield is offset, length, msb_right
#define VAR_TRANSP       68
#define VAR_NONSTD       80
#define VAR_ACTIVATE     84
#define VAR_HEIGHT       88
#define VAR_WIDTH        92
#define VAR_ACCEL_FLAGS  96  // to the end, what __fill_var() clears
#define VAR_PIXCLOCK     100
#define VAR_LEFT_MARGIN  104  // then right, upper and lower
#define VAR_HSYNC_LEN    120
#define VAR_VSYNC_LEN    124
#define VAR_SYNC         128
#define VAR_VMODE        132

// struct fb_fix_screeninfo on x86-64, 80 bytes
#define FIX_SIZE 80

// The physical size the guest's connector reports, in mm: QEMU's EDID for
// its default preferred mode of 1280×800 at 100 dpi, 32 by 20 cm in the
// EDID's base block, which is where Linux takes display_info's from.
#define FRAMEBUFFER_WIDTH_MM  320
#define FRAMEBUFFER_HEIGHT_MM 200

// The display's refresh: FBIO_WAITFORVSYNC and every pan return at the next
// of these boundaries of Program time.
#define VSYNC_HZ 60

struct FramebufferState {
  u8 var[VAR_SIZE];  // as FBIOGET_VSCREENINFO answers it
  u32 scanout;       // the first line the scanout shows
  u32 blank;         // FB_BLANK_*: anything but FB_BLANK_UNBLANK shows black
};

static struct {
  u8 *pixels;  // whole pages, page-aligned; none until /dev/fb0 opens
  u32 width, height;  // the mode the scanout shows
  u32 smem_len;       // the buffer's bytes: a line's times the lines
  u32 mapped_len;     // smem_len rounded up to whole pages, which mmap sees
  struct FramebufferState state;
} fb;

// The Display configuration, which a program takes when it starts.
static u32 mode_width = 320, mode_height = 240;

static u32 LineLength(void) {
  return fb.width * 4;
}

static u32 VirtualHeight(void) {
  return fb.height * 2;
}

static void NotifyPresent(void) {
#ifdef __EMSCRIPTEN__
  NotifyFramebufferPresentHost(fb.state.scanout);
#endif
}

static void SetBitfield(u8 *var, int at, u32 offset, u32 length) {
  Write32(var + at, offset);
  Write32(var + at + 4, length);
  Write32(var + at + 8, 0);
}

// drm_fb_helper_fill_pixel_fmt() for XRGB8888, whose depth is 24.
static void FillPixelFormat(u8 *var) {
  SetBitfield(var, VAR_RED, 16, 8);
  SetBitfield(var, VAR_RED + 12, 8, 8);
  SetBitfield(var, VAR_RED + 24, 0, 8);
  SetBitfield(var, VAR_TRANSP, 0, 0);
}

// __fill_var(): what the screen information always says, whatever was asked.
static void FillVar(u8 *var) {
  Write32(var + VAR_XRES_VIRTUAL, fb.width);
  Write32(var + VAR_YRES_VIRTUAL, VirtualHeight());
  Write32(var + VAR_BPP, 32);
  Write32(var + VAR_HEIGHT, Read32(fb.state.var + VAR_HEIGHT));
  Write32(var + VAR_WIDTH, Read32(fb.state.var + VAR_WIDTH));
  memset(var + VAR_ACCEL_FLAGS, 0, VAR_SIZE - VAR_ACCEL_FLAGS);
}

/* Takes the Display configuration for the program about to start, and lets
 * the last program's framebuffer go: its mappings went with its machine. */
void ResetFramebuffer(void) {
  free(fb.pixels);
  memset(&fb, 0, sizeof(fb));
  fb.width = mode_width;
  fb.height = mode_height;
}

/* What the fbdev emulation's probe makes, the first time a program opens the
 * device: a buffer of the mode's width by twice its height, black, whose
 * smem_len is its size in bytes, not rounded to pages (8 by 8 has 512 on the
 * guest); a mapping sees it in whole pages. Later opens find it as the
 * earlier ones left it. */
int OpenFramebuffer(void) {
  void *pixels;
  u8 *var;
  if (fb.pixels) return 0;
  if (!fb.width) ResetFramebuffer();
  fb.smem_len = LineLength() * VirtualHeight();
  fb.mapped_len = ROUNDUP(fb.smem_len, 4096);
  if (posix_memalign(&pixels, 4096, fb.mapped_len)) return enomem();
  memset(pixels, 0, fb.mapped_len);
  fb.pixels = (u8 *)pixels;
  // drm_fb_helper_fill_var(), then the connector's size from
  // drm_setup_crtcs_fb()
  var = fb.state.var;
  memset(var, 0, VAR_SIZE);
  Write32(var + VAR_HEIGHT, FRAMEBUFFER_HEIGHT_MM);
  Write32(var + VAR_WIDTH, FRAMEBUFFER_WIDTH_MM);
  FillVar(var);
  FillPixelFormat(var);
  Write32(var + VAR_XRES, fb.width);
  Write32(var + VAR_YRES, fb.height);
  fb.state.scanout = 0;
  fb.state.blank = 0;
  return 0;
}

static struct DeviceFile *GetFramebufferFile(struct System *s, int fildes) {
  struct Fd *fd;
  struct DeviceFile *df = 0;
  LOCK(&s->fds.lock);
  if ((fd = GetFd(&s->fds, fildes)) && fd->device &&
      fd->device->node->kind == DEVICE_FRAMEBUFFER) {
    df = fd->device;
  }
  UNLOCK(&s->fds.lock);
  return df;
}

static struct DeviceFile *FramebufferFile(int fildes) {
  return g_machine && fb.pixels ? GetFramebufferFile(g_machine->system, fildes)
                                : 0;
}

bool IsFramebufferFildes(struct Machine *m, int fildes) {
  return fb.pixels && GetFramebufferFile(m->system, fildes);
}

// ------------------------------------------------------------------ the file

static void SetPosition(struct DeviceFile *df, i64 position) {
  u8 record[16];
  if (df->position == position) return;
  Write64(record, (uintptr_t)df);
  Write64(record + 8, df->position);
  DebugHistoryJournal(JOURNAL_FRAMEBUFFER_POSITION, record, sizeof(record));
  df->position = position;
}

/* fb_sys_read() at `position`, vector after vector as Linux's loop over a
 * file without read_iter goes: short at the end of smem_len, nothing past it.
 * The guest's bytes it fills are journaled by the read itself. */
static ssize_t ReadAt(i64 position, const struct iovec *iov, int iovcnt) {
  int i;
  u64 n;
  ssize_t done = 0;
  for (i = 0; i < iovcnt; ++i) {
    if ((u64)position >= fb.smem_len) break;
    n = MIN(iov[i].iov_len, fb.smem_len - (u64)position);
    memmove(iov[i].iov_base, fb.pixels + position, n);
    done += n;
    position += n;
    if (n < iov[i].iov_len) break;
  }
  return done;
}

/* fb_sys_write() at `position`: EFBIG past the end of smem_len, ENOSPC at it,
 * and short when it gets there. What it replaces is journaled first. */
static ssize_t WriteAt(i64 position, const struct iovec *iov, int iovcnt) {
  int i;
  u64 size, n, left;
  u8 *record;
  for (size = i = 0; i < iovcnt; ++i) size += iov[i].iov_len;
  if ((u64)position > fb.smem_len) {
    errno = EFBIG;
    return -1;
  }
  if (!size) return 0;
  if (!(left = MIN(size, fb.smem_len - (u64)position))) {
    errno = ENOSPC;
    return -1;
  }
  if (!DebugHistoryPending()) {
    // nothing records this instruction: what DebugHistoryJournal() does
    // then, without copying a frame's worth of bytes first
    DebugHistoryMarkIrreversible();
  } else {
    if (!(record = (u8 *)malloc(8 + left))) return enomem();
    Write64(record, position);
    memcpy(record + 8, fb.pixels + position, left);
    DebugHistoryJournal(JOURNAL_FRAMEBUFFER_BYTES, record, 8 + left);
    free(record);
  }
  for (size = left, i = 0; i < iovcnt && left; ++i) {
    n = MIN(iov[i].iov_len, left);
    memmove(fb.pixels + position, iov[i].iov_base, n);
    position += n;
    left -= n;
  }
  return size;
}

ssize_t ReadFramebuffer(int fildes, const struct iovec *iov, int iovcnt) {
  ssize_t rc;
  struct DeviceFile *df;
  if (!(df = FramebufferFile(fildes))) return ebadf();
  if ((rc = ReadAt(df->position, iov, iovcnt)) > 0) {
    SetPosition(df, df->position + rc);
  }
  return rc;
}

ssize_t WriteFramebuffer(int fildes, const struct iovec *iov, int iovcnt) {
  ssize_t rc;
  struct DeviceFile *df;
  if (!(df = FramebufferFile(fildes))) return ebadf();
  if ((rc = WriteAt(df->position, iov, iovcnt)) > 0) {
    SetPosition(df, df->position + rc);
  }
  return rc;
}

// pread() and pwrite() at an offset, which leave the file offset alone.
ssize_t PreadFramebuffer(int fildes, const struct iovec *iov, int iovcnt,
                         i64 offset) {
  if (!FramebufferFile(fildes)) return ebadf();
  if (offset < 0) return einval();
  return ReadAt(offset, iov, iovcnt);
}

ssize_t PwriteFramebuffer(int fildes, const struct iovec *iov, int iovcnt,
                          i64 offset) {
  if (!FramebufferFile(fildes)) return ebadf();
  if (offset < 0) return einval();
  return WriteAt(offset, iov, iovcnt);
}

/* default_llseek() on a device whose inode is empty: any offset from 0 on,
 * SEEK_END from 0, SEEK_DATA and SEEK_HOLE finding no data. */
i64 SeekFramebuffer(int fildes, i64 offset, int whence) {
  struct DeviceFile *df;
  if (!(df = FramebufferFile(fildes))) return ebadf();
  switch (whence) {
    case SEEK_SET_LINUX:
    case SEEK_END_LINUX:
      break;
    case SEEK_CUR_LINUX:
      if (!offset) return df->position;
      if (__builtin_add_overflow(offset, df->position, &offset)) {
        return einval();
      }
      break;
    case 3:  // SEEK_DATA
      if (offset >= 0) {
        errno = ENXIO;
        return -1;
      }
      break;
    case 4:  // SEEK_HOLE
      if (offset >= 0) {
        errno = ENXIO;
        return -1;
      }
      offset = 0;
      break;
    default:
      return einval();
  }
  if (offset < 0) return einval();
  SetPosition(df, offset);
  return offset;
}

/* fb_deferred_io_fsync(): the shadow buffer reaches the display now, which
 * the host hears as a present. */
int SyncFramebuffer(int fildes) {
  if (!FramebufferFile(fildes)) return ebadf();
  NotifyPresent();
  return 0;
}

// --------------------------------------------------------------- the ioctls

static void SaveState(void) {
  DebugHistoryJournal(JOURNAL_FRAMEBUFFER_STATE, &fb.state, sizeof(fb.state));
}

/* A DRM commit with the scanout at line `yoffset` and column `xoffset`, which
 * shows the whole mode: it fails with ENOSPC, as the atomic check of the
 * plane's source does, when the mode does not fit the buffer there. It also
 * makes the display active again, as every commit of drm_client_modeset's
 * does, which ends a blank. */
static int Commit(u32 xoffset, u32 yoffset) {
  if (xoffset || yoffset > VirtualHeight() - fb.height) {
    errno = ENOSPC;
    return -1;
  }
  fb.state.scanout = yoffset;
  fb.state.blank = 0;
  NotifyPresent();
  return 0;
}

static bool SameMode(const u8 *a, const u8 *b) {
  int at;
  static const int kFields[] = {VAR_XRES,        VAR_YRES,          VAR_PIXCLOCK,
                                VAR_HSYNC_LEN,   VAR_VSYNC_LEN,     VAR_LEFT_MARGIN,
                                VAR_LEFT_MARGIN + 4, VAR_LEFT_MARGIN + 8,
                                VAR_LEFT_MARGIN + 12, VAR_SYNC};
  for (at = 0; at < ARRAYLEN(kFields); ++at) {
    if (Read32(a + kFields[at]) != Read32(b + kFields[at])) return false;
  }
  return (Read32(a + VAR_VMODE) & FB_VMODE_MASK_LINUX) ==
         (Read32(b + VAR_VMODE) & FB_VMODE_MASK_LINUX);
}

static bool SamePixelFormat(const u8 *a, const u8 *b) {
  return !memcmp(a + VAR_BPP, b + VAR_BPP, VAR_NONSTD - VAR_BPP);
}

static bool NoPixelFormat(const u8 *var) {
  int i;
  for (i = VAR_RED; i < VAR_NONSTD; ++i) {
    if (var[i]) return false;
  }
  return true;
}

/* The next of the display's refreshes after `now`, in Program time: the
 * first k / 60 s, rounded up to a nanosecond, later than it. */
static i64 NextVsync(i64 now) {
  unsigned __int128 k;
  if (now < 0) now = 0;
  k = (unsigned __int128)now * VSYNC_HZ / 1000000000 + 1;
  return (k * 1000000000 + VSYNC_HZ - 1) / VSYNC_HZ;
}

/* Waits for the vertical blank `blanks` refreshes from now, which an atomic
 * commit of the fbdev emulation waits for, as FBIO_WAITFORVSYNC waits for
 * one: the call halts with that deadline, kept while Blink starts it over,
 * and goes on once it has passed. */
static void WaitForBlanks(struct Machine *m, int blanks) {
  i64 now = DeviceNow(), at = now;
  struct timespec deadline;
  while (blanks-- > 0) at = NextVsync(at);
  deadline = GuestWaitDeadline(DeviceTimespec(at));
  if (GuestWaitCancelled() || now >= ToNanoseconds(deadline)) return;
#ifdef __EMSCRIPTEN__
  GuestWaitHalt(m, deadline, 0);
#endif
}

/* Whether the commit to the scanout at `xoffset` and `yoffset` would pass the
 * atomic check: the whole mode fits the buffer there. */
static bool CommitFits(u32 xoffset, u32 yoffset) {
  return !xoffset && yoffset <= VirtualHeight() - fb.height;
}

/* fb_set_var() with drm_fb_helper_check_var() as the check: a size up to the
 * buffer's (8 at least), 32 bpp or less, which reads back as 32, and the
 * pixel format the device has; the scanout keeps showing the whole mode.
 * What it applies, drm_fb_helper_set_par()'s commit and fb_pan_display()'s,
 * waits for a vertical blank each (a pan the check refuses, none). */
static int SetVar(struct Machine *m, u8 *var) {
  u32 xres, yres, product, activate, blank;
  activate = Read32(var + VAR_ACTIVATE);
  if (activate & FB_ACTIVATE_INV_MODE_LINUX) {
    // deleting the mode in use is refused; any other is not in the list
    return SameMode(var, fb.state.var) ? einval() : 0;
  }
  if (!(activate & FB_ACTIVATE_FORCE_LINUX) &&
      !memcmp(var, fb.state.var, VAR_SIZE)) {
    return 0;
  }
  xres = Read32(var + VAR_XRES);
  yres = Read32(var + VAR_YRES);
  if (xres < 8 || yres < 8) return einval();
  if (__builtin_mul_overflow(xres, yres, &product) ||
      __builtin_mul_overflow(Read32(var + VAR_XRES_VIRTUAL),
                             Read32(var + VAR_YRES_VIRTUAL), &product)) {
    return einval();
  }
  Write32(var + VAR_PIXCLOCK, 0);
  if (Read32(var + VAR_BPP) > 32 || xres > fb.width ||
      yres > VirtualHeight() || Read32(var + VAR_XRES_VIRTUAL) > fb.width ||
      Read32(var + VAR_YRES_VIRTUAL) > VirtualHeight()) {
    return einval();
  }
  FillVar(var);
  if (Read32(var + VAR_YOFFSET) > VirtualHeight() - yres ||
      Read32(var + VAR_XOFFSET) > fb.width - xres) {
    return einval();
  }
  if (Read32(var + VAR_GRAYSCALE) || Read32(var + VAR_NONSTD)) return einval();
  if (NoPixelFormat(var)) FillPixelFormat(var);
  if (!SamePixelFormat(var, fb.state.var)) return einval();
  // FB_ACTIVATE_TEST and the like: checked, and given back as it would be
  if ((activate & FB_ACTIVATE_MASK_LINUX) != FB_ACTIVATE_NOW_LINUX) return 0;
  WaitForBlanks(m, CommitFits(Read32(var + VAR_XOFFSET),
                              Read32(var + VAR_YOFFSET))
                       ? 2
                       : 1);
  SaveState();
  memcpy(fb.state.var, var, VAR_SIZE);
  // drm_fb_helper_set_par() commits the mode where the scanout was, which
  // ends a blank, then fb_pan_display() pans to the new offsets, whose
  // failure goes unreported
  blank = fb.state.blank;
  fb.state.blank = 0;
  if (Commit(Read32(var + VAR_XOFFSET), Read32(var + VAR_YOFFSET)) == -1 &&
      blank) {
    NotifyPresent();
  }
  return 0;
}

static int PutVar(struct Machine *m, i64 addr) {
  u8 var[VAR_SIZE];
  if (CopyFromUserRead(m, var, addr, VAR_SIZE) == -1) return efault();
  // only for the kernel's own use
  Write32(var + VAR_ACTIVATE,
          Read32(var + VAR_ACTIVATE) & ~FB_ACTIVATE_KD_TEXT_LINUX);
  // fbcon_modechange_possible() has no console on this framebuffer to
  // refuse for, fbcon=map:1 keeping it off
  if (SetVar(m, var) == -1) return -1;
  if (CopyToUserWrite(m, addr, var, VAR_SIZE) == -1) return efault();
  return 0;
}

/* fb_pan_display() with drm_fb_helper_pan_display(): ypanstep and xpanstep 1,
 * no ywrap, within what the screen information's size leaves of the buffer,
 * and the commit's own check that the whole mode fits; then the commit, which
 * waits for the next vertical blank, a pan to the page shown already too. */
static int PanDisplay(struct Machine *m, i64 addr) {
  u32 xoffset, yoffset, vmode;
  u8 var[VAR_SIZE];
  struct FramebufferState old;
  if (CopyFromUserRead(m, var, addr, VAR_SIZE) == -1) return efault();
  xoffset = Read32(var + VAR_XOFFSET);
  yoffset = Read32(var + VAR_YOFFSET);
  vmode = Read32(var + VAR_VMODE);
  if ((yoffset && (vmode & FB_VMODE_YWRAP_LINUX)) ||
      yoffset > Read32(fb.state.var + VAR_YRES_VIRTUAL) -
                    Read32(fb.state.var + VAR_YRES) ||
      xoffset > Read32(fb.state.var + VAR_XRES_VIRTUAL) -
                    Read32(fb.state.var + VAR_XRES)) {
    return einval();
  }
  if (!CommitFits(xoffset, yoffset)) {
    errno = ENOSPC;
    return -1;
  }
  WaitForBlanks(m, 1);
  old = fb.state;
  if (Commit(xoffset, yoffset) == -1) return -1;
  DebugHistoryJournal(JOURNAL_FRAMEBUFFER_STATE, &old, sizeof(old));
  Write32(fb.state.var + VAR_XOFFSET, xoffset);
  Write32(fb.state.var + VAR_YOFFSET, yoffset);
  Write32(fb.state.var + VAR_VMODE,
          Read32(fb.state.var + VAR_VMODE) & ~FB_VMODE_YWRAP_LINUX);
  if (CopyToUserWrite(m, addr, var, VAR_SIZE) == -1) return efault();
  return 0;
}

static int GetFix(struct Machine *m, i64 addr) {
  u8 fix[FIX_SIZE];
  memset(fix, 0, sizeof(fix));
  // drm_fb_helper_fill_info(): the driver's name and "drmfb"
  memcpy(fix, "bochs-drmdrmfb", 15);
  // smem_start stays 0: FBINFO_HIDE_SMEM_START
  Write32(fix + 24, fb.smem_len);
  Write32(fix + 28, FB_TYPE_PACKED_PIXELS_LINUX);
  Write32(fix + 32, 0);  // type_aux
  Write32(fix + 36, FB_VISUAL_TRUECOLOR_LINUX);
  Write16(fix + 40, 1);  // xpanstep
  Write16(fix + 42, 1);  // ypanstep
  Write16(fix + 44, 0);  // ywrapstep
  Write32(fix + 48, LineLength());
  // no MMIO, FB_ACCEL_NONE and no capabilities
  if (CopyToUserWrite(m, addr, fix, sizeof(fix)) == -1) return efault();
  return 0;
}

static int Blank(u64 blank) {
  u32 was;
  if (blank > FB_BLANK_POWERDOWN_LINUX) return einval();
  // drm_fb_helper_blank(): every level but FB_BLANK_UNBLANK turns the
  // display off
  if (blank != fb.state.blank) {
    SaveState();
    was = fb.state.blank;
    fb.state.blank = blank;
    if (!was != !blank) NotifyPresent();
  }
  return 0;
}

/* drm_fb_helper_ioctl()'s FBIO_WAITFORVSYNC, which reads no argument and
 * cannot be interrupted: it waits for the next refresh, which the wait keeps
 * as its deadline while Blink starts the call over. */
static int WaitForVsync(struct Machine *m) {
  WaitForBlanks(m, 1);
  return 0;
}

int IoctlFramebuffer(struct Machine *m, int fildes, u64 request, i64 addr) {
  if (!FramebufferFile(fildes)) return ebadf();
  switch ((u32)request) {
    case FBIOGET_VSCREENINFO_LINUX:
      if (CopyToUserWrite(m, addr, fb.state.var, VAR_SIZE) == -1) {
        return efault();
      }
      return 0;
    case FBIOPUT_VSCREENINFO_LINUX:
      return PutVar(m, addr);
    case FBIOGET_FSCREENINFO_LINUX:
      return GetFix(m, addr);
    case FBIOPAN_DISPLAY_LINUX:
      return PanDisplay(m, addr);
    case FBIOBLANK_LINUX:
      return Blank(addr);
    case FBIO_CURSOR_LINUX:
      return einval();
    case FBIO_WAITFORVSYNC_LINUX:
      return WaitForVsync(m);
    default:
      // what fb_ioctl() hands drm_fb_helper_ioctl(), which knows no other
      return enotty();
  }
}

// ---------------------------------------------------------------- mapping

/* The host bytes a mapping of `size` bytes at `offset` of the descriptor
 * shows, for ReserveVirtual(): null with ENODEV when it is not the
 * framebuffer, and with EINVAL when the range goes past the buffer's last
 * page, which a deferred-I/O mapping would only fault on (SIGBUS) once
 * touched. */
u8 *MapFramebuffer(struct System *s, int fildes, i64 offset, i64 size) {
  if (!fb.pixels || !GetFramebufferFile(s, fildes)) {
    errno = ENODEV;
    return 0;
  }
  if (offset < 0 || (u64)offset > fb.mapped_len ||
      (u64)ROUNDUP(size, 4096) > fb.mapped_len - (u64)offset) {
    errno = EINVAL;
    return 0;
  }
  return fb.pixels + offset;
}

/* Whether the system call, which Blink would otherwise take for an Undo
 * barrier, only did to the framebuffer what this file journals. */
bool FramebufferJournalsSyscall(struct Machine *m, u64 call, i64 fildes) {
  switch (call & 0xfff) {
    case 0x000:  // read
    case 0x001:  // write
    case 0x008:  // lseek
    case 0x011:  // pread64
    case 0x012:  // pwrite64
    case 0x013:  // readv
    case 0x014:  // writev
    case 0x127:  // preadv
    case 0x128:  // pwritev
    case 0x147:  // preadv2
    case 0x148:  // pwritev2
      return fildes >= 0 && fildes <= INT_MAX && IsFramebufferFildes(m, fildes);
    default:
      return false;
  }
}

void UndoFramebufferJournal(u32 kind, const u8 *p, u32 size) {
  u64 offset;
  struct DeviceFile *df;
  struct FramebufferState old;
  switch (kind) {
    case JOURNAL_FRAMEBUFFER_STATE:
      old = fb.state;
      memcpy(&fb.state, p, sizeof(fb.state));
      if (old.scanout != fb.state.scanout || !old.blank != !fb.state.blank) {
        NotifyPresent();
      }
      break;
    case JOURNAL_FRAMEBUFFER_POSITION:
      df = (struct DeviceFile *)(uintptr_t)Read64(p);
      df->position = Read64(p + 8);
      break;
    case JOURNAL_FRAMEBUFFER_BYTES:
      offset = Read64(p);
      if (fb.pixels && offset + (size - 8) <= fb.smem_len) {
        memcpy(fb.pixels + offset, p + 8, size - 8);
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------- exports for the wrapper

/* The mode the next program's framebuffer has, as the guest's video= would
 * set it: a width that is a multiple of 8 and a height, both 8 to 1024. */
EMSCRIPTEN_KEEPALIVE
bool blinkenlib_set_display_mode(u32 width, u32 height) {
  if (width < 8 || width > 1024 || width % 8 || height < 8 || height > 1024) {
    return false;
  }
  mode_width = width;
  mode_height = height;
  return true;
}

/* The framebuffer's bytes in the wasm heap, or 0 until the program opens
 * /dev/fb0: smem_len bytes, the page the scanout shows starting
 * blinkenlib_framebuffer_yoffset() lines in. */
EMSCRIPTEN_KEEPALIVE
u8 *blinkenlib_framebuffer_pixels(void) {
  return fb.pixels;
}

EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_framebuffer_size(void) {
  return fb.pixels ? fb.smem_len : 0;
}

EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_framebuffer_width(void) {
  return fb.width;
}

EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_framebuffer_height(void) {
  return fb.height;
}

EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_framebuffer_line_length(void) {
  return LineLength();
}

EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_framebuffer_yoffset(void) {
  return fb.state.scanout;
}

EMSCRIPTEN_KEEPALIVE
bool blinkenlib_framebuffer_blanked(void) {
  return fb.state.blank != 0;
}
