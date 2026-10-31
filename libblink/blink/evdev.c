/* The guest's input devices, /dev/input/event0 to event4, through Linux's
 * evdev, as the QEMU guest x86's devices follow has them
 * (docs/design/x86-devices.md, "The keyboard device", "The input devices",
 * "The pointer", ADR 0067): the ACPI Power Button, the AT keyboard, the PS/2
 * mouse, QEMU's USB tablet and the PC Speaker, each with the identity and the
 * capabilities its Linux 6.12 driver gives it.
 *
 * The model is the kernel's, cut down to what these devices use. Each device
 * is an input_dev: its state (keys held, LEDs, sound, the tablet's axes, the
 * keyboard's repeat settings and keymap), and the values of the packet being
 * built, which a SYN_REPORT passes to its readers (input_handle_event() and
 * input_get_disposition() in drivers/input/input.c). Each open() is a reader,
 * an evdev_client with its own queue, clock and masks (drivers/input/evdev.c).
 * The host's reports go in as the hardware's would: a key as the bytes QEMU's
 * PS/2 keyboard sends for it, which atkbd reads into MSC_SCAN and the key
 * (drivers/input/keyboard/atkbd.c); the pointer as QEMU's tablet's HID
 * report, which hid-input turns into MSC_SCAN and the buttons, the axes and
 * the wheel with its hi-res twin (drivers/hid/hid-input.c). The console's
 * keyboard handler sees the keyboard's events and toggles the lock LEDs
 * (drivers/tty/vt/keyboard.c), except while a reader holds EVIOCGRAB, and
 * sounds the PC Speaker for /dev/tty0's KIOCSOUND and KDMKTONE (kd_mksound(),
 * EvdevConsoleSound()). A write goes in as evdev_write() injects it, and an
 * event the PC Speaker's driver takes reaches SpeakerInputEvent() (speaker.c).
 *
 * Each reader's queue holds 4,096 events, where Linux holds 64 for the
 * keyboard; past that, __pass_event()'s rule drops what was unread for a
 * SYN_DROPPED and the newest event. A read takes whole events of the packets
 * complete so far. Event times are Program time on the reader's clock.
 *
 * Undo (ADR 0069). What a read takes, the events EVIOCGKEY, EVIOCGLED,
 * EVIOCGSND, EVIOCGSW and EVIOCSCLOCKID throw away, the clock, the grab, the
 * masks, an axis's absinfo, and what a write or EVIOCSREP did are journaled
 * (JOURNAL_EVDEV_*). Undo puts the events a read took back at the front of
 * its reader's queue, whether or not the read waited for them, and puts a
 * flushed queue back as it was. Host reports are never journaled: the state
 * they leave (keys held, the pointer, the LEDs the lock keys set) is live, and
 * Undo restores what a program changed only where nothing has changed it
 * since. A queue that overflowed since a flush or a write cannot have its
 * dropped events back; Undo then leaves that queue as it is. EVIOCREVOKE and
 * EVIOCSKEYCODE are Undo barriers. */
#include "blink/evdev.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "blink/assert.h"
#include "blink/blinkenlib.h"
#include "blink/debughistory.h"
#include "blink/endian.h"
#include "blink/environment.h"
#include "blink/errno.h"
#include "blink/fds.h"
#include "blink/macros.h"
#include "blink/speaker.h"
#include "blink/thread.h"
#include "blink/timespec.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

// <linux/input-event-codes.h>
#define EV_SYN_LINUX          0x00
#define EV_KEY_LINUX          0x01
#define EV_REL_LINUX          0x02
#define EV_ABS_LINUX          0x03
#define EV_MSC_LINUX          0x04
#define EV_SW_LINUX           0x05
#define EV_LED_LINUX          0x11
#define EV_SND_LINUX          0x12
#define EV_REP_LINUX          0x14
#define EV_FF_LINUX           0x15
#define EV_PWR_LINUX          0x16
#define EV_MAX_LINUX          0x1f
#define EV_CNT_LINUX          0x20
#define SYN_REPORT_LINUX      0
#define SYN_CONFIG_LINUX      1
#define SYN_MT_REPORT_LINUX   2
#define SYN_DROPPED_LINUX     3
#define KEY_MAX_LINUX         0x2ff
#define KEY_CNT_LINUX         0x300
#define REL_MAX_LINUX         0x0f
#define ABS_MAX_LINUX         0x3f
#define ABS_CNT_LINUX         0x40
#define MSC_MAX_LINUX         0x07
#define SW_MAX_LINUX          0x10
#define LED_MAX_LINUX         0x0f
#define SND_MAX_LINUX         0x07
#define SND_BELL_LINUX        0x01
#define SND_TONE_LINUX        0x02
#define FF_MAX_LINUX          0x7f
#define REP_MAX_LINUX         0x01
#define INPUT_PROP_MAX_LINUX  0x1f
#define REL_WHEEL_LINUX       0x08
#define REL_WHEEL_HI_RES_LINUX 0x0b
#define ABS_X_LINUX           0x00
#define ABS_Y_LINUX           0x01
#define ABS_MT_SLOT_LINUX     0x2f
#define MSC_SCAN_LINUX        0x04
#define LED_NUML_LINUX        0x00
#define LED_CAPSL_LINUX       0x01
#define LED_SCROLLL_LINUX     0x02
#define REP_DELAY_LINUX       0x00
#define REP_PERIOD_LINUX      0x01
#define KEY_RESERVED_LINUX    0
#define KEY_LEFTCTRL_LINUX    29
#define KEY_LEFTSHIFT_LINUX   42
#define KEY_RIGHTSHIFT_LINUX  54
#define KEY_LEFTALT_LINUX     56
#define KEY_CAPSLOCK_LINUX    58
#define KEY_NUMLOCK_LINUX     69
#define KEY_SCROLLLOCK_LINUX  70
#define KEY_RIGHTCTRL_LINUX   97
#define KEY_SYSRQ_LINUX       99
#define KEY_RIGHTALT_LINUX    100
#define KEY_PAUSE_LINUX       119
#define KEY_HANGEUL_LINUX     122
#define KEY_HANJA_LINUX       123
#define BTN_LEFT_LINUX        0x110
#define CLOCK_REALTIME_ID     0
#define CLOCK_MONOTONIC_ID    1
#define CLOCK_BOOTTIME_ID     7

// evdev's ioctls (<linux/input.h>): the fixed-size ones, then the sized ones
// with their size masked out (evdev_do_ioctl()'s EVIOC_MASK_SIZE()).
#define EVIOCGVERSION    0x80044501u
#define EVIOCGID         0x80084502u
#define EVIOCGREP        0x80084503u
#define EVIOCSREP        0x40084503u
#define EVIOCGKEYCODE    0x80084504u
#define EVIOCGKEYCODE_V2 0x80284504u
#define EVIOCSKEYCODE    0x40084504u
#define EVIOCSKEYCODE_V2 0x40284504u
#define EVIOCRMFF        0x40044581u
#define EVIOCGEFFECTS    0x80044584u
#define EVIOCGRAB        0x40044590u
#define EVIOCREVOKE      0x40044591u
#define EVIOCGMASK       0x80104592u
#define EVIOCSMASK       0x40104593u
#define EVIOCSCLOCKID    0x400445a0u
#define EVIOCGNAME_0     0x80004506u
#define EVIOCGPHYS_0     0x80004507u
#define EVIOCGUNIQ_0     0x80004508u
#define EVIOCGPROP_0     0x80004509u
#define EVIOCGMTSLOTS_0  0x8000450au
#define EVIOCGKEY_0      0x80004518u
#define EVIOCGLED_0      0x80004519u
#define EVIOCGSND_0      0x8000451au
#define EVIOCGSW_0       0x8000451bu
#define EVIOCSFF_0       0x40004580u
#define EV_VERSION_LINUX 0x010001
#define FF_EFFECT_SIZE   48  // struct ff_effect on x86-64
#define KEYMAP_ENTRY_SIZE 40  // struct input_keymap_entry
#define INPUT_KEYMAP_BY_INDEX 1

// input_get_disposition()'s answers.
#define INPUT_IGNORE_EVENT      0
#define INPUT_PASS_TO_HANDLERS  1
#define INPUT_PASS_TO_DEVICE    2
#define INPUT_FLUSH             4
#define INPUT_PASS_TO_ALL       (INPUT_PASS_TO_HANDLERS | INPUT_PASS_TO_DEVICE)

#define INPUT_EVENT_BYTES   24    // struct input_event on x86-64
#define EVDEV_QUEUE_EVENTS  4096  // a reader's queue, x86-devices.md decision
#define EVDEV_WRITE_MAX     4096  // evdev_write() takes 170 events at a time
#define INPUT_REPORT_MAX    64    // events in one host report
#define KEY_WORDS           12    // BITS_TO_LONGS(KEY_CNT)
#define VALS_MAX            16    // the most any device's max_vals is

// atkbd.c
#define ATKBD_KEYMAP_SIZE 512
#define ATKBD_KEY_UNKNOWN 0
#define ATKBD_KEY_NULL    255
#define ATKBD_SPECIAL     0xfff8
// The console's lock flags, kbd_struct's VC_*LOCK bits, which are also the
// bits of the LEDs kbd_bh() sets.
#define VC_SCROLLOCK 0
#define VC_NUMLOCK   1
#define VC_CAPSLOCK  2
// QEMU's PS/2 keyboard's modifiers (hw/input/ps2.c).
#define MOD_CTRL_L  1
#define MOD_SHIFT_L 2
#define MOD_ALT_L   4
#define MOD_CTRL_R  8
#define MOD_SHIFT_R 16
#define MOD_ALT_R   32

// --------------------------------------------------------------- the devices

struct InputCaps {
  u64 prop, ev, key[KEY_WORDS], rel, abs, msc, led, snd, sw, ff[2];
};

// What EVIOCGNAME, EVIOCGPHYS, EVIOCGUNIQ, EVIOCGID and EVIOCGBIT answer and
// /proc/bus/input/devices lists. The input numbers in the sysfs paths are the
// least certain: they depend on the order the guest probes its devices.
struct InputIdentity {
  const char *name, *phys, *uniq, *sysfs, *handlers;
  u16 bustype, vendor, product, version;
  struct InputCaps caps;  // the keyboard's keys come from its keymap
  u8 max_vals;            // input_dev.max_vals: values a packet holds
  bool absinfo;           // has absolute axes, and answers EVIOCGABS
};

static const struct InputIdentity kInputIdentities[INPUT_DEVICES] = {
    // acpi_button_add(): KEY_POWER and KEY_WAKEUP
    {"Power Button",
     "LNXPWRBN/button/input0",
     0,
     "/devices/LNXSYSTM:00/LNXPWRBN:00/input/input0",
     "kbd event0",
     0x19,
     0,
     1,
     0,
     {.ev = 0x3, .key = {0, 1ull << (116 - 64), 1ull << (143 - 128)}},
     10,
     false},
    // atkbd_set_device_attrs(), translated set 2 with softraw and LEDs
    {"AT Translated Set 2 keyboard",
     "isa0060/serio0/input0",
     0,
     "/devices/platform/i8042/serio0/input/input1",
     "sysrq kbd event1 leds",
     0x11,
     1,
     1,
     0xab41,
     {.ev = 0x120013, .msc = 1 << MSC_SCAN_LINUX, .led = 0x7},
     10,
     false},
    // with vmport=off the PS/2 mouse is the IntelliMouse Explorer QEMU
    // emulates; it stays silent while the tablet is active
    {"ImExPS/2 Generic Explorer Mouse",
     "isa0060/serio1/input0",
     0,
     "/devices/platform/i8042/serio1/input/input2",
     "mouse0 event2",
     0x11,
     2,
     6,
     0,
     {.prop = 0x1, .ev = 0x7, .key = {0, 0, 0, 0, 0x1f0000}, .rel = 0x143},
     14,
     false},
    // hid-generic on QEMU 10.0's usb-tablet: three buttons, X and Y from 0 to
    // 32767, a vertical wheel and its hi-res twin
    {"QEMU QEMU USB Tablet",
     "usb-0000:00:04.0-1/input0",
     "28754-0000:00:04.0-1",
     "/devices/pci0000:00/0000:00:04.0/usb1/1-1/1-1:1.0/0003:0627:0001.0001/"
     "input/input3",
     "mouse1 event3",
     0x03,
     0x627,
     1,
     1,
     {.ev = 0x1f,
      .key = {0, 0, 0, 0, 0x70000},
      .rel = 0x900,
      .abs = 0x3,
      .msc = 1 << MSC_SCAN_LINUX},
     14,
     true},
    // pcspkr_probe()
    {"PC Speaker",
     "isa0061/input0",
     0,
     "/devices/platform/pcspkr/input/input4",
     "kbd event4",
     0x10,
     0x1f,
     1,
     0x100,
     {.ev = 0x40001, .snd = 0x6},
     10,
     false},
};

struct InputValue {
  u16 type, code;
  i32 value;
};

struct Absinfo {
  i32 value, minimum, maximum, fuzz, flat, resolution;
};

struct EvdevClient;

// An input_dev's state.
struct InputDevice {
  u64 keybit[KEY_WORDS];  // the keys it has: the keyboard's follow its keymap
  u64 key[KEY_WORDS];     // the keys held now
  u64 led, snd, sw;
  i32 rep[2];
  struct Absinfo abs[ABS_CNT_LINUX];
  struct InputValue vals[VALS_MAX];  // the packet being built
  u32 num_vals;
  bool stamped;  // its timestamp, taken at the packet's first pass
  i64 stamp_real, stamp_mono;
  struct EvdevClient *grab;
};

// Program time, in ns, on the two clocks event times are in (CLOCK_BOOTTIME
// is CLOCK_MONOTONIC: nothing suspends).
struct InputTime {
  i64 real, mono;
};

// A reader: an open file description of an input device.
struct EvdevClient {
  struct EvdevClient *next;  // every reader, in the order they opened
  struct DeviceFile *file;
  struct InputDevice *device;
  u64 id;
  u8 *events;  // its queue, struct input_events, from events + first
  u32 first, count, allocated;
  u32 readable;  // the events at the front a read may take: whole packets
  u64 epoch;     // how many times its queue overflowed
  int clock;     // CLOCK_REALTIME, CLOCK_MONOTONIC or CLOCK_BOOTTIME
  bool revoked;
  u32 masked;  // the types EVIOCSMASK masked, as bits
  u64 masks[EV_CNT_LINUX][KEY_WORDS];
};

static struct InputDevice devices[INPUT_DEVICES];
static struct EvdevClient *clients;
static u64 last_client_id;
static bool initialized;

// The keyboard's hardware and drivers: QEMU's PS/2 keyboard, atkbd reading
// it, and the console's keyboard handler.
static struct {
  u16 keymap[ATKBD_KEYMAP_SIZE];  // atkbd's keycode table
  u8 modifiers;                   // QEMU's, MOD_*: from the host's keys
  u8 emul;                        // atkbd between bytes
  bool release;
  u32 xl_bit;
  u32 last;
  i64 time;
  int console_flags;  // the console's lock flags, VC_*LOCK bits
  int console_leds;   // the LEDs the console last set (kbd_bh()'s ledstate)
  bool console_pending;  // kbd_bh() is scheduled
} kbd;

// QEMU's tablet: what its HID reports say.
static struct {
  u32 buttons;
  i32 x, y;
} tablet;

// Whether a reader got a whole packet since the host's report began.
static bool woke;

// What a write or EVIOCSREP delivered to each reader, for its journal.
struct Delivery {
  struct EvdevClient *client;
  u64 id, epoch;
  u32 count_before, readable_before;
};
static bool recording;
static struct Delivery *deliveries;
static u32 delivery_count, delivery_allocated;

static i32 report_buffer[3 * INPUT_REPORT_MAX];

// atkbd's keycode table for a translated set 2 keyboard, indexed by
// atkbd_compat_scancode(): atkbd_set2_keycode[] through atkbd_unxlate_table[],
// with Hanja and Hangeul (atkbd_set_keycode_table()). Generated from Linux
// 6.12's drivers/input/keyboard/atkbd.c.
static const u16 kAtkbdKeymap[ATKBD_KEYMAP_SIZE] = {
    [0x1] = 1, [0x2] = 2, [0x3] = 3, [0x4] = 4, [0x5] = 5, [0x6] = 6, [0x7] = 7,
    [0x8] = 8, [0x9] = 9, [0xa] = 10, [0xb] = 11, [0xc] = 12, [0xd] = 13,
    [0xe] = 14, [0xf] = 15, [0x10] = 16, [0x11] = 17, [0x12] = 18, [0x13] = 19,
    [0x14] = 20, [0x15] = 21, [0x16] = 22, [0x17] = 23, [0x18] = 24,
    [0x19] = 25, [0x1a] = 26, [0x1b] = 27, [0x1c] = 28, [0x1d] = 29,
    [0x1e] = 30, [0x1f] = 31, [0x20] = 32, [0x21] = 33, [0x22] = 34,
    [0x23] = 35, [0x24] = 36, [0x25] = 37, [0x26] = 38, [0x27] = 39,
    [0x28] = 40, [0x29] = 41, [0x2a] = 42, [0x2b] = 43, [0x2c] = 44,
    [0x2d] = 45, [0x2e] = 46, [0x2f] = 47, [0x30] = 48, [0x31] = 49,
    [0x32] = 50, [0x33] = 51, [0x34] = 52, [0x35] = 53, [0x36] = 54,
    [0x37] = 55, [0x38] = 56, [0x39] = 57, [0x3a] = 58, [0x3b] = 59,
    [0x3c] = 60, [0x3d] = 61, [0x3e] = 62, [0x3f] = 63, [0x40] = 64,
    [0x41] = 65, [0x42] = 66, [0x43] = 67, [0x44] = 68, [0x45] = 69,
    [0x46] = 70, [0x47] = 71, [0x48] = 72, [0x49] = 73, [0x4a] = 74,
    [0x4b] = 75, [0x4c] = 76, [0x4d] = 77, [0x4e] = 78, [0x4f] = 79,
    [0x50] = 80, [0x51] = 81, [0x52] = 82, [0x53] = 83, [0x54] = 99,
    [0x56] = 86, [0x57] = 87, [0x58] = 88, [0x59] = 117, [0x5c] = 95,
    [0x5d] = 183, [0x5e] = 184, [0x5f] = 185, [0x70] = 93, [0x73] = 89,
    [0x76] = 85, [0x77] = 91, [0x78] = 90, [0x79] = 92, [0x7b] = 94,
    [0x7d] = 124, [0x7e] = 121, [0x90] = 165, [0x99] = 163, [0x9c] = 96,
    [0x9d] = 97, [0xa0] = 113, [0xa1] = 140, [0xa2] = 164, [0xa4] = 166,
    [0xaa] = 255, [0xae] = 114, [0xb0] = 115, [0xb2] = 172, [0xb5] = 98,
    [0xb6] = 255, [0xb7] = 99, [0xb8] = 100, [0xc5] = 119, [0xc6] = 119,
    [0xc7] = 102, [0xc8] = 103, [0xc9] = 104, [0xcb] = 105, [0xcc] = 112,
    [0xcd] = 106, [0xce] = 118, [0xcf] = 107, [0xd0] = 108, [0xd1] = 109,
    [0xd2] = 110, [0xd3] = 111, [0xdb] = 125, [0xdc] = 126, [0xdd] = 127,
    [0xde] = 116, [0xdf] = 142, [0xe3] = 143, [0xe5] = 217, [0xe6] = 156,
    [0xe7] = 173, [0xe8] = 128, [0xe9] = 159, [0xea] = 158, [0xeb] = 157,
    [0xec] = 155, [0xed] = 226, [0xef] = 112, [0x171] = 123, [0x172] = 122,
};

// The scan code, as atkbd_compat_scancode() has it, that QEMU's PS/2
// keyboard sends for each Linux key it can send (its AT set 1 column of
// keycodemapdb's keymaps.csv, which QEMU's tables are generated from), where
// atkbd reads that code back as the same key. Pause, Print Screen, Hangeul
// and Hanja have sequences of their own (see HostKey()).
struct KeyScancode {
  u16 key, scancode;
};
static const struct KeyScancode kKeyScancodes[] = {
    {1, 0x01}, {2, 0x02}, {3, 0x03}, {4, 0x04}, {5, 0x05}, {6, 0x06}, {7, 0x07},
    {8, 0x08}, {9, 0x09}, {10, 0x0a}, {11, 0x0b}, {12, 0x0c}, {13, 0x0d},
    {14, 0x0e}, {15, 0x0f}, {16, 0x10}, {17, 0x11}, {18, 0x12}, {19, 0x13},
    {20, 0x14}, {21, 0x15}, {22, 0x16}, {23, 0x17}, {24, 0x18}, {25, 0x19},
    {26, 0x1a}, {27, 0x1b}, {28, 0x1c}, {29, 0x1d}, {30, 0x1e}, {31, 0x1f},
    {32, 0x20}, {33, 0x21}, {34, 0x22}, {35, 0x23}, {36, 0x24}, {37, 0x25},
    {38, 0x26}, {39, 0x27}, {40, 0x28}, {41, 0x29}, {42, 0x2a}, {43, 0x2b},
    {44, 0x2c}, {45, 0x2d}, {46, 0x2e}, {47, 0x2f}, {48, 0x30}, {49, 0x31},
    {50, 0x32}, {51, 0x33}, {52, 0x34}, {53, 0x35}, {54, 0x36}, {55, 0x37},
    {56, 0x38}, {57, 0x39}, {58, 0x3a}, {59, 0x3b}, {60, 0x3c}, {61, 0x3d},
    {62, 0x3e}, {63, 0x3f}, {64, 0x40}, {65, 0x41}, {66, 0x42}, {67, 0x43},
    {68, 0x44}, {69, 0x45}, {70, 0x46}, {71, 0x47}, {72, 0x48}, {73, 0x49},
    {74, 0x4a}, {75, 0x4b}, {76, 0x4c}, {77, 0x4d}, {78, 0x4e}, {79, 0x4f},
    {80, 0x50}, {81, 0x51}, {82, 0x52}, {83, 0x53}, {85, 0x76}, {86, 0x56},
    {87, 0x57}, {88, 0x58}, {89, 0x73}, {90, 0x78}, {91, 0x77}, {92, 0x79},
    {93, 0x70}, {94, 0x7b}, {95, 0x5c}, {96, 0x9c}, {97, 0x9d}, {98, 0xb5},
    {99, 0x54}, {100, 0xb8}, {102, 0xc7}, {103, 0xc8}, {104, 0xc9}, {105, 0xcb},
    {106, 0xcd}, {107, 0xcf}, {108, 0xd0}, {109, 0xd1}, {110, 0xd2},
    {111, 0xd3}, {112, 0xef}, {113, 0xa0}, {114, 0xae}, {115, 0xb0},
    {116, 0xde}, {117, 0x59}, {118, 0xce}, {119, 0xc6}, {121, 0x7e},
    {124, 0x7d}, {125, 0xdb}, {126, 0xdc}, {127, 0xdd}, {128, 0xe8},
    {140, 0xa1}, {142, 0xdf}, {143, 0xe3}, {155, 0xec}, {156, 0xe6},
    {157, 0xeb}, {158, 0xea}, {159, 0xe9}, {163, 0x99}, {164, 0xa2},
    {165, 0x90}, {166, 0xa4}, {172, 0xb2}, {173, 0xe7}, {183, 0x5d},
    {184, 0x5e}, {185, 0x5f}, {217, 0xe5}, {226, 0xed},
};

static bool TestBit(const u64 *bits, unsigned n) {
  return bits[n / 64] >> (n % 64) & 1;
}
static void SetBit(u64 *bits, unsigned n) {
  bits[n / 64] |= (u64)1 << (n % 64);
}
static void ClearBit(u64 *bits, unsigned n) {
  bits[n / 64] &= ~((u64)1 << (n % 64));
}
static void ChangeBit(u64 *bits, unsigned n) {
  bits[n / 64] ^= (u64)1 << (n % 64);
}
static bool IsSupported(unsigned code, const u64 *bits, unsigned max) {
  return code <= max && TestBit(bits, code);
}

static int DeviceIndex(const struct InputDevice *dev) {
  return dev - devices;
}
static const struct InputIdentity *Identity(const struct InputDevice *dev) {
  return kInputIdentities + DeviceIndex(dev);
}
static const struct InputCaps *Caps(const struct InputDevice *dev) {
  return &Identity(dev)->caps;
}
static bool Has(const struct InputDevice *dev, unsigned type) {
  return Caps(dev)->ev >> type & 1;
}

static void ComputeKeyboardKeys(u64 *keybit) {
  int i;
  memset(keybit, 0, KEY_WORDS * 8);
  for (i = 0; i < ATKBD_KEYMAP_SIZE; ++i) {
    if (kbd.keymap[i] != KEY_RESERVED_LINUX &&
        kbd.keymap[i] != ATKBD_KEY_NULL && kbd.keymap[i] < ATKBD_SPECIAL &&
        kbd.keymap[i] <= KEY_MAX_LINUX) {
      SetBit(keybit, kbd.keymap[i]);
    }
  }
}

/* Every device as the machine boots it: nothing held or lit, the tablet at 0,
 * 0, the keyboard's repeat at atkbd's 250 ms and 33 ms. Every program starts
 * on a machine of its own, as with the file system. */
void ResetInputDevices(void) {
  int i;
  struct InputDevice *dev;
  for (i = 0; i < INPUT_DEVICES; ++i) {
    dev = devices + i;
    memset(dev, 0, sizeof(*dev));
    memcpy(dev->keybit, kInputIdentities[i].caps.key, sizeof(dev->keybit));
  }
  memset(&kbd, 0, sizeof(kbd));
  memcpy(kbd.keymap, kAtkbdKeymap, sizeof(kbd.keymap));
  // kbd_init() runs kbd_bh() as the machine boots, which sets the LEDs to the
  // console's locks: all off, with the BIOS's Num Lock off
  ComputeKeyboardKeys(devices[INPUT_KEYBOARD].keybit);
  devices[INPUT_KEYBOARD].rep[REP_DELAY_LINUX] = 250;
  devices[INPUT_KEYBOARD].rep[REP_PERIOD_LINUX] = 33;
  devices[INPUT_TABLET].abs[ABS_X_LINUX].maximum = 32767;
  devices[INPUT_TABLET].abs[ABS_Y_LINUX].maximum = 32767;
  memset(&tablet, 0, sizeof(tablet));
  initialized = true;
}

static void Initialize(void) {
  if (!initialized) ResetInputDevices();
}

// ------------------------------------------------------------------- time

/* Milliseconds of Program time as HostNow() turns them into a timespec, so
 * that an event's time and clock_gettime() agree to the nanosecond. */
static i64 MillisecondsToNanoseconds(double ms) {
  struct timespec ts;
  ts.tv_sec = ms / 1000;
  ts.tv_nsec = (ms - (double)ts.tv_sec * 1000) * 1000000;
  return ToNanoseconds(ts);
}

static struct InputTime ProgramNow(void) {
  struct timespec ts;
  struct InputTime now;
  HostNow(CLOCK_REALTIME, &ts);
  now.real = ToNanoseconds(ts);
  HostNow(CLOCK_MONOTONIC, &ts);
  now.mono = ToNanoseconds(ts);
  return now;
}

/* input_get_timestamp(): the packet's time, taken the first time it is
 * needed and kept until the packet's SYN_REPORT. */
static struct InputTime Timestamp(struct InputDevice *dev,
                                  struct InputTime now) {
  struct InputTime t;
  if (!dev->stamped) {
    dev->stamped = true;
    dev->stamp_real = now.real;
    dev->stamp_mono = now.mono;
  }
  t.real = dev->stamp_real;
  t.mono = dev->stamp_mono;
  return t;
}

static i64 ClientTime(const struct EvdevClient *c, struct InputTime t) {
  return c->clock == CLOCK_REALTIME_ID ? t.real : t.mono;
}

// ------------------------------------------------------------------ queues

static u8 *EventAt(struct EvdevClient *c, u32 i) {
  return c->events + (size_t)(c->first + i) * INPUT_EVENT_BYTES;
}

static void EncodeEvent(u8 *ev, i64 ns, u16 type, u16 code, i32 value) {
  if (ns < 0) ns = 0;
  Write64(ev, ns / 1000000000);
  Write64(ev + 8, ns % 1000000000 / 1000);
  Write16(ev + 16, type);
  Write16(ev + 18, code);
  Write32(ev + 20, value);
}

static void Reserve(struct EvdevClient *c, u32 more) {
  u32 want;
  u8 *grown;
  if (c->first + c->count + more <= c->allocated) return;
  if (c->first) {
    memmove(c->events, EventAt(c, 0), (size_t)c->count * INPUT_EVENT_BYTES);
    c->first = 0;
  }
  if (c->count + more <= c->allocated) return;
  want = MAX(MAX(c->allocated * 2, c->count + more), 64);
  unassert((grown = (u8 *)realloc(c->events,
                                  (size_t)want * INPUT_EVENT_BYTES)));
  c->events = grown;
  c->allocated = want;
}

static void Append(struct EvdevClient *c, const u8 *ev) {
  Reserve(c, 1);
  memcpy(EventAt(c, c->count), ev, INPUT_EVENT_BYTES);
  ++c->count;
}

static void Prepend(struct EvdevClient *c, const u8 *evs, u32 n) {
  if (!n) return;
  if (c->first < n) {
    Reserve(c, n);
    memmove(c->events + (size_t)n * INPUT_EVENT_BYTES, EventAt(c, 0),
            (size_t)c->count * INPUT_EVENT_BYTES);
    c->first = n;
  }
  c->first -= n;
  c->count += n;
  memcpy(EventAt(c, 0), evs, (size_t)n * INPUT_EVENT_BYTES);
}

static void Remove(struct EvdevClient *c, u32 at, u32 n) {
  memmove(EventAt(c, at), EventAt(c, at + n),
          (size_t)(c->count - at - n) * INPUT_EVENT_BYTES);
  c->count -= n;
}

/* Notes, the first time a write delivers to a reader, where its queue stood,
 * for Undo to take the write's events out again. */
static void NoteDelivery(struct EvdevClient *c) {
  u32 i;
  struct Delivery *grown;
  if (!recording) return;
  for (i = 0; i < delivery_count; ++i) {
    if (deliveries[i].client == c) return;
  }
  if (delivery_count == delivery_allocated) {
    delivery_allocated = MAX(delivery_allocated * 2, 4);
    unassert((grown = (struct Delivery *)realloc(
                  deliveries, delivery_allocated * sizeof(*deliveries))));
    deliveries = grown;
  }
  deliveries[delivery_count++] = (struct Delivery){
      c, c->id, c->epoch, c->count, c->readable};
}

/* __pass_event(): queues an event, and once the reader is a whole buffer
 * behind, drops what it did not read for a SYN_DROPPED and the newest. */
static void PassEvent(struct EvdevClient *c, i64 ns, u16 type, u16 code,
                      i32 value) {
  u8 ev[INPUT_EVENT_BYTES];
  NoteDelivery(c);
  EncodeEvent(ev, ns, type, code, value);
  Append(c, ev);
  if (c->count >= EVDEV_QUEUE_EVENTS) {
    c->first += c->count - 2;
    c->count = 2;
    EncodeEvent(EventAt(c, 0), ns, EV_SYN_LINUX, SYN_DROPPED_LINUX, 0);
    c->readable = 0;
    ++c->epoch;
  }
  if (type == EV_SYN_LINUX && code == SYN_REPORT_LINUX) c->readable = c->count;
}

/* __evdev_queue_syn_dropped(), which leaves the device's timestamp taken. */
static void QueueSynDropped(struct EvdevClient *c, struct InputTime now) {
  u8 ev[INPUT_EVENT_BYTES];
  EncodeEvent(ev, ClientTime(c, Timestamp(c->device, now)), EV_SYN_LINUX,
              SYN_DROPPED_LINUX, 0);
  Append(c, ev);
  if (c->count >= EVDEV_QUEUE_EVENTS) {
    c->first += c->count - 1;
    c->count = 1;
    c->readable = 0;
    ++c->epoch;
  }
}

static size_t MaskCount(unsigned type) {
  switch (type) {
    case EV_SYN_LINUX:
      return EV_CNT_LINUX;
    case EV_KEY_LINUX:
      return KEY_CNT_LINUX;
    case EV_REL_LINUX:
      return REL_MAX_LINUX + 1;
    case EV_ABS_LINUX:
      return ABS_CNT_LINUX;
    case EV_MSC_LINUX:
      return MSC_MAX_LINUX + 1;
    case EV_SW_LINUX:
      return SW_MAX_LINUX + 1;
    case EV_LED_LINUX:
      return LED_MAX_LINUX + 1;
    case EV_SND_LINUX:
      return SND_MAX_LINUX + 1;
    case EV_FF_LINUX:
      return FF_MAX_LINUX + 1;
    default:
      return 0;
  }
}

/* __evdev_is_filtered() */
static bool IsFiltered(const struct EvdevClient *c, unsigned type,
                       unsigned code) {
  size_t cnt;
  if (type == EV_SYN_LINUX || type >= EV_CNT_LINUX) return false;
  if ((c->masked & 1) && !TestBit(c->masks[0], type)) return true;
  if (!(cnt = MaskCount(type)) || code >= cnt) return false;
  return (c->masked >> type & 1) && !TestBit(c->masks[type], code);
}

/* evdev_pass_values(): a packet to one reader. */
static void PassToClient(struct EvdevClient *c, const struct InputValue *vals,
                         u32 n, struct InputTime t) {
  u32 i;
  i64 ns;
  if (c->revoked) return;
  ns = ClientTime(c, t);
  for (i = 0; i < n; ++i) {
    if (IsFiltered(c, vals[i].type, vals[i].code)) continue;
    if (vals[i].type == EV_SYN_LINUX && vals[i].code == SYN_REPORT_LINUX) {
      if (c->readable == c->count) continue;  // an empty packet
      woke = true;
    }
    PassEvent(c, ns, vals[i].type, vals[i].code, vals[i].value);
  }
}

static void ConsoleEvents(struct InputDevice *, const struct InputValue *,
                          u32);

/* input_pass_values(): the reader holding the grab has the packet alone;
 * otherwise every reader, in the order they opened, and the console. */
static void PassValues(struct InputDevice *dev, const struct InputValue *vals,
                       u32 n, struct InputTime now) {
  struct EvdevClient *c;
  struct InputTime t = Timestamp(dev, now);
  if (dev->grab) {
    PassToClient(dev->grab, vals, n, t);
    return;
  }
  for (c = clients; c; c = c->next) {
    if (c->device == dev) PassToClient(c, vals, n, t);
  }
  ConsoleEvents(dev, vals, n);
}

// ---------------------------------------------------------- the input core

static i32 Defuzz(i32 value, i32 old, i32 fuzz) {
  if (fuzz) {
    if (value > old - fuzz / 2 && value < old + fuzz / 2) return old;
    if (value > old - fuzz && value < old + fuzz) return (old * 3 + value) / 4;
    if (value > old - fuzz * 2 && value < old + fuzz * 2) {
      return (old + value) / 2;
    }
  }
  return value;
}

/* input_get_disposition(), which also keeps the device's state. */
static int Disposition(struct InputDevice *dev, unsigned type, unsigned code,
                       i32 *pvalue) {
  i32 value = *pvalue;
  const struct InputCaps *caps = Caps(dev);
  switch (type) {
    case EV_SYN_LINUX:
      switch (code) {
        case SYN_CONFIG_LINUX:
          return INPUT_PASS_TO_ALL;
        case SYN_REPORT_LINUX:
          return INPUT_PASS_TO_HANDLERS | INPUT_FLUSH;
        case SYN_MT_REPORT_LINUX:
          return INPUT_PASS_TO_HANDLERS;
        default:
          return INPUT_IGNORE_EVENT;
      }
    case EV_KEY_LINUX:
      if (!IsSupported(code, dev->keybit, KEY_MAX_LINUX)) break;
      if (value == 2) return INPUT_PASS_TO_HANDLERS;  // repeats leave the state
      if (TestBit(dev->key, code) == !!value) break;
      ChangeBit(dev->key, code);
      return INPUT_PASS_TO_HANDLERS;
    case EV_SW_LINUX:
      if (!IsSupported(code, &caps->sw, SW_MAX_LINUX) ||
          (bool)(dev->sw >> code & 1) == !!value) {
        break;
      }
      dev->sw ^= (u64)1 << code;
      return INPUT_PASS_TO_HANDLERS;
    case EV_ABS_LINUX:
      if (!IsSupported(code, &caps->abs, ABS_MAX_LINUX)) break;
      if (code == ABS_MT_SLOT_LINUX) break;
      value = Defuzz(value, dev->abs[code].value, dev->abs[code].fuzz);
      if (dev->abs[code].value == value) break;
      dev->abs[code].value = value;
      *pvalue = value;
      return INPUT_PASS_TO_HANDLERS;
    case EV_REL_LINUX:
      if (IsSupported(code, &caps->rel, REL_MAX_LINUX) && value) {
        return INPUT_PASS_TO_HANDLERS;
      }
      break;
    case EV_MSC_LINUX:
      if (IsSupported(code, &caps->msc, MSC_MAX_LINUX)) {
        return INPUT_PASS_TO_ALL;
      }
      break;
    case EV_LED_LINUX:
      if (!IsSupported(code, &caps->led, LED_MAX_LINUX) ||
          (bool)(dev->led >> code & 1) == !!value) {
        break;
      }
      dev->led ^= (u64)1 << code;
      return INPUT_PASS_TO_ALL;
    case EV_SND_LINUX:
      if (!IsSupported(code, &caps->snd, SND_MAX_LINUX)) break;
      if ((bool)(dev->snd >> code & 1) != !!value) dev->snd ^= (u64)1 << code;
      return INPUT_PASS_TO_ALL;
    case EV_REP_LINUX:
      if (code <= REP_MAX_LINUX && value >= 0 && dev->rep[code] != value) {
        dev->rep[code] = value;
        return INPUT_PASS_TO_ALL;
      }
      break;
    case EV_FF_LINUX:
      if (value >= 0) return INPUT_PASS_TO_ALL;
      break;
    case EV_PWR_LINUX:
      return INPUT_PASS_TO_ALL;
    default:
      break;
  }
  return INPUT_IGNORE_EVENT;
}

/* atkbd_set_repeat_rate(): the keyboard takes the nearest rate and delay it
 * has at or above what was asked for. QEMU ignores the command, so repeats
 * stay the host's. */
static void RoundRepeat(struct InputDevice *dev) {
  static const short kPeriods[32] = {
      33,  37,  42,  46,  50,  54,  58,  63,  67,  75,  83,
      92,  100, 109, 116, 125, 133, 149, 167, 182, 200, 217,
      232, 250, 270, 303, 333, 370, 400, 435, 470, 500};
  static const short kDelays[4] = {250, 500, 750, 1000};
  int i = 0, j = 0;
  while (i < ARRAYLEN(kPeriods) - 1 &&
         kPeriods[i] < dev->rep[REP_PERIOD_LINUX]) {
    ++i;
  }
  dev->rep[REP_PERIOD_LINUX] = kPeriods[i];
  while (j < ARRAYLEN(kDelays) - 1 && kDelays[j] < dev->rep[REP_DELAY_LINUX]) {
    ++j;
  }
  dev->rep[REP_DELAY_LINUX] = kDelays[j];
}

/* input_dev.event(): what the device's driver does with an event passed to
 * it. */
static void DriverEvent(struct InputDevice *dev, unsigned type, unsigned code,
                        i32 value) {
  switch (DeviceIndex(dev)) {
    case INPUT_SPEAKER:
      SpeakerInputEvent(g_machine, type, code, value);
      break;
    case INPUT_KEYBOARD:
      if (type == EV_REP_LINUX) RoundRepeat(dev);
      break;
    default:
      break;
  }
}

/* input_handle_event() and input_event_dispose(). */
static void HandleEvent(struct InputDevice *dev, unsigned type, unsigned code,
                        i32 value, struct InputTime now) {
  int disposition;
  u32 max_vals = Identity(dev)->max_vals;
  disposition = Disposition(dev, type, code, &value);
  if (disposition == INPUT_IGNORE_EVENT) return;
  if (disposition & INPUT_PASS_TO_DEVICE) DriverEvent(dev, type, code, value);
  if (disposition & INPUT_PASS_TO_HANDLERS) {
    dev->vals[dev->num_vals++] = (struct InputValue){type, code, value};
  }
  if (disposition & INPUT_FLUSH) {
    if (dev->num_vals >= 2) PassValues(dev, dev->vals, dev->num_vals, now);
    dev->num_vals = 0;
    dev->stamped = false;
  } else if (dev->num_vals >= max_vals - 2) {
    dev->vals[dev->num_vals++] =
        (struct InputValue){EV_SYN_LINUX, SYN_REPORT_LINUX, 0};
    PassValues(dev, dev->vals, dev->num_vals, now);
    dev->num_vals = 0;
  }
}

/* input_event(): an event from the device's own driver. */
static void InputEvent(struct InputDevice *dev, unsigned type, unsigned code,
                       i32 value, struct InputTime now) {
  if (type <= EV_MAX_LINUX && Has(dev, type)) {
    HandleEvent(dev, type, code, value, now);
  }
}

/* input_inject_event(): an event from a handler, which a grab of the device
 * by another handler keeps out. evdev's is the handle a reader grabs with,
 * so only the console's is ever kept out. */
static void InjectEvent(struct InputDevice *dev, unsigned type, unsigned code,
                        i32 value, struct InputTime now, bool console) {
  if (type <= EV_MAX_LINUX && Has(dev, type) && (!console || !dev->grab)) {
    HandleEvent(dev, type, code, value, now);
  }
}

// ------------------------------------------------------- the console's keys

/* kbd_event(): Caps Lock, Num Lock and Scroll Lock going down toggle the
 * console's locks (fn_caps_toggle(), fn_bare_num(), and fn_hold(), whose
 * stop_tty() lights Scroll Lock while tty1's getty holds the tty); every
 * event schedules kbd_bh(). Repeats toggle nothing. */
static void ConsoleEvents(struct InputDevice *dev,
                          const struct InputValue *vals, u32 n) {
  u32 i;
  if (DeviceIndex(dev) != INPUT_KEYBOARD) return;
  for (i = 0; i < n; ++i) {
    if (vals[i].type != EV_KEY_LINUX || vals[i].value != 1) continue;
    switch (vals[i].code) {
      case KEY_CAPSLOCK_LINUX:
        kbd.console_flags ^= 1 << VC_CAPSLOCK;
        break;
      case KEY_NUMLOCK_LINUX:
        kbd.console_flags ^= 1 << VC_NUMLOCK;
        break;
      case KEY_SCROLLLOCK_LINUX:
        kbd.console_flags ^= 1 << VC_SCROLLOCK;
        break;
      default:
        break;
    }
  }
  kbd.console_pending = true;
}

/* kbd_bh(): when the console's locks differ from the LEDs it last set, it
 * sets all three through its own handle, in a packet of their own after the
 * key's; the input core passes on only the ones that change. */
static void ConsoleBottomHalf(struct InputTime now) {
  struct InputDevice *dev = devices + INPUT_KEYBOARD;
  int leds = kbd.console_flags;
  if (!kbd.console_pending) return;
  kbd.console_pending = false;
  if (leds == kbd.console_leds) return;
  kbd.console_leds = leds;
  InjectEvent(dev, EV_LED_LINUX, LED_SCROLLL_LINUX, leds >> VC_SCROLLOCK & 1,
              now, true);
  InjectEvent(dev, EV_LED_LINUX, LED_NUML_LINUX, leds >> VC_NUMLOCK & 1, now,
              true);
  InjectEvent(dev, EV_LED_LINUX, LED_CAPSL_LINUX, leds >> VC_CAPSLOCK & 1, now,
              true);
  InjectEvent(dev, EV_SYN_LINUX, SYN_REPORT_LINUX, 0, now, true);
}

// ---------------------------------------------------------- the keyboard

// atkbd's xl_table: bytes that are keyboard replies unless they release a key
// whose make code was seen.
static const u8 kXlTable[] = {0xaa, 0xff, 0xfa, 0xfe, 0xf1, 0xf2};

static bool NeedXlate(u8 code) {
  int i;
  if (code == 0xe0 || code == 0xe1) return false;
  for (i = 0; i < ARRAYLEN(kXlTable); ++i) {
    if (code == kXlTable[i]) return kbd.xl_bit >> i & 1;
  }
  return true;
}

static void CalculateXlBit(u8 code) {
  int i;
  if (code == 0xe0 || code == 0xe1) return;
  for (i = 0; i < ARRAYLEN(kXlTable); ++i) {
    if (!((code ^ kXlTable[i]) & 0x7f)) {
      if (code & 0x80) {
        kbd.xl_bit &= ~(1u << i);
      } else {
        kbd.xl_bit |= 1u << i;
      }
      break;
    }
  }
}

// Hangeul and Hanja send no release, so atkbd makes one.
static bool ForceRelease(unsigned code) {
  return code == ((0xf1 & 0x7f) | 0x100) || code == ((0xf2 & 0x7f) | 0x100);
}

/* atkbd_receive_byte() for a translated set 2 keyboard: a byte of what the
 * keyboard controller passes on, set 1 codes with E0 and E1 prefixes, into
 * MSC_SCAN, the key and SYN_REPORT. A key already down that comes again is a
 * repeat, value 2, except right after it went down (atkbd's workaround for
 * keyboards that send a make code twice). */
static void AtkbdByte(u8 data, struct InputTime now) {
  int value;
  unsigned code = data, keycode;
  struct InputDevice *dev = devices + INPUT_KEYBOARD;
  if (kbd.emul || NeedXlate(code)) {
    kbd.release = code >> 7;
    code &= 0x7f;
  }
  if (!kbd.emul) CalculateXlBit(data);
  switch (code) {
    case 0xaa:  // the keyboard's self-test: QEMU never sends it here
    case 0xfa:
    case 0xfe:
    case 0xff:
      return;
    case 0xe0:
      kbd.emul = 1;
      return;
    case 0xe1:
      kbd.emul = 2;
      return;
    case 0xf0:
      kbd.release = true;
      return;
    default:
      break;
  }
  code = (code & 0x7f) | ((code & 0x80) << 1);  // atkbd_compat_scancode()
  if (kbd.emul == 1) code |= 0x80;
  if (kbd.emul && --kbd.emul) return;
  keycode = kbd.keymap[code];
  if (!(kbd.release && ForceRelease(code)) && keycode != ATKBD_KEY_NULL) {
    InputEvent(dev, EV_MSC_LINUX, MSC_SCAN_LINUX, code, now);
  }
  switch (keycode) {
    case ATKBD_KEY_NULL:
      break;
    case ATKBD_KEY_UNKNOWN:
      InputEvent(dev, EV_SYN_LINUX, SYN_REPORT_LINUX, 0, now);
      break;
    default:
      if (kbd.release) {
        value = 0;
        kbd.last = 0;
      } else if (keycode <= KEY_MAX_LINUX && TestBit(dev->key, keycode)) {
        value = now.mono < kbd.time && kbd.last == code ? 1 : 2;
      } else {
        value = 1;
        kbd.last = code;
        kbd.time = now.mono + (i64)dev->rep[REP_DELAY_LINUX] * 1000000 / 2;
      }
      InputEvent(dev, EV_KEY_LINUX, keycode, value, now);
      InputEvent(dev, EV_SYN_LINUX, SYN_REPORT_LINUX, 0, now);
      if (value && ForceRelease(code)) {
        InputEvent(dev, EV_MSC_LINUX, MSC_SCAN_LINUX, code, now);
        InputEvent(dev, EV_KEY_LINUX, keycode, 0, now);
        InputEvent(dev, EV_SYN_LINUX, SYN_REPORT_LINUX, 0, now);
      }
      break;
  }
  kbd.release = false;
}

static int CompareKeyScancode(const void *a, const void *b) {
  return (int)((const struct KeyScancode *)a)->key -
         (int)((const struct KeyScancode *)b)->key;
}

/* The scan code QEMU's keyboard sends for a key, as atkbd_compat_scancode()
 * has it (0x80 for an E0 prefix), or 0 for a key it has none for. */
static unsigned ScancodeOf(unsigned key) {
  struct KeyScancode wanted = {key, 0};
  const struct KeyScancode *found =
      bsearch(&wanted, kKeyScancodes, ARRAYLEN(kKeyScancodes),
              sizeof(*kKeyScancodes), CompareKeyScancode);
  return found ? found->scancode : 0;
}

static u8 ModifierOf(unsigned key) {
  switch (key) {
    case KEY_LEFTCTRL_LINUX:
      return MOD_CTRL_L;
    case KEY_RIGHTCTRL_LINUX:
      return MOD_CTRL_R;
    case KEY_LEFTSHIFT_LINUX:
      return MOD_SHIFT_L;
    case KEY_RIGHTSHIFT_LINUX:
      return MOD_SHIFT_R;
    case KEY_LEFTALT_LINUX:
      return MOD_ALT_L;
    case KEY_RIGHTALT_LINUX:
      return MOD_ALT_R;
    default:
      return 0;
  }
}

/* ps2_keyboard_event() in translated set 2: the bytes QEMU's keyboard sends
 * for a host key going down or up, a repeat being another make code. */
static void HostKey(unsigned key, bool down, struct InputTime now) {
  size_t i, n = 0;
  unsigned scancode;
  u8 bytes[8];
  u8 mod = ModifierOf(key);
  if (down) {
    kbd.modifiers |= mod;
  } else {
    kbd.modifiers &= ~mod;
  }
#define BYTES(...)                                             \
  do {                                                         \
    static const u8 kBytes[] = {__VA_ARGS__};                  \
    memcpy(bytes, kBytes, (n = sizeof(kBytes)));               \
  } while (0)
  switch (key) {
    case KEY_PAUSE_LINUX:  // sent whole as it goes down, nothing as it goes up
      if (!down) break;
      if (kbd.modifiers & (MOD_CTRL_L | MOD_CTRL_R)) {
        BYTES(0xe0, 0x46, 0xe0, 0xc6);
      } else {
        BYTES(0xe1, 0x1d, 0x45, 0xe1, 0x9d, 0xc5);
      }
      break;
    case KEY_SYSRQ_LINUX:  // Print Screen, and SysRq under Alt
      if (kbd.modifiers & MOD_ALT_L) {
        if (down) {
          BYTES(0xb8, 0x38, 0x54);
        } else {
          BYTES(0xd4, 0xb8, 0x38);
        }
      } else if (kbd.modifiers & MOD_ALT_R) {
        if (down) {
          BYTES(0xe0, 0xb8, 0xe0, 0x38, 0x54);
        } else {
          BYTES(0xd4, 0xe0, 0xb8, 0xe0, 0x38);
        }
      } else if (kbd.modifiers &
                 (MOD_SHIFT_L | MOD_CTRL_L | MOD_SHIFT_R | MOD_CTRL_R)) {
        if (down) {
          BYTES(0xe0, 0x37);
        } else {
          BYTES(0xe0, 0xb7);
        }
      } else if (down) {
        BYTES(0xe0, 0x2a, 0xe0, 0x37);
      } else {
        BYTES(0xe0, 0xb7, 0xe0, 0xaa);
      }
      break;
    case KEY_HANGEUL_LINUX:  // Lang1 and Lang2 send no release
    case KEY_HANJA_LINUX:
      if (down) bytes[n++] = key == KEY_HANGEUL_LINUX ? 0xf2 : 0xf1;
      break;
    default:
      if (!(scancode = ScancodeOf(key))) return;
      if (scancode & 0x80) bytes[n++] = 0xe0;
      bytes[n++] = (scancode & 0x7f) | (down ? 0 : 0x80);
      break;
  }
#undef BYTES
  for (i = 0; i < n; ++i) AtkbdByte(bytes[i], now);
}

static void HostKeyboardReport(const i32 *events, u32 count,
                               struct InputTime now) {
  u32 i;
  for (i = 0; i < count; ++i) {
    if (events[3 * i] != EV_KEY_LINUX) continue;
    if ((u32)events[3 * i + 1] > KEY_MAX_LINUX) continue;
    HostKey(events[3 * i + 1], events[3 * i + 2] != 0, now);
    ConsoleBottomHalf(now);
  }
}

// ------------------------------------------------------------- the tablet

static i32 Clamp(i32 value, i32 lo, i32 hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/* One HID report of QEMU's tablet through hid-input: the buttons in usage
 * order, each with its usage as MSC_SCAN when it changes, X and Y clamped to
 * their logical range, the wheel (hidinput_handle_scroll(): REL_WHEEL, then
 * REL_WHEEL_HI_RES at 120 a notch), and input_sync(). */
static void TabletHidReport(i32 wheel, struct InputTime now) {
  int i;
  i32 value;
  struct InputDevice *dev = devices + INPUT_TABLET;
  for (i = 0; i < 3; ++i) {
    value = tablet.buttons >> i & 1;
    if (!TestBit(dev->key, BTN_LEFT_LINUX + i) == value) {
      InputEvent(dev, EV_MSC_LINUX, MSC_SCAN_LINUX, 0x90001 + i, now);
    }
    InputEvent(dev, EV_KEY_LINUX, BTN_LEFT_LINUX + i, value, now);
  }
  InputEvent(dev, EV_ABS_LINUX, ABS_X_LINUX, Clamp(tablet.x, 0, 32767), now);
  InputEvent(dev, EV_ABS_LINUX, ABS_Y_LINUX, Clamp(tablet.y, 0, 32767), now);
  if (wheel) {
    InputEvent(dev, EV_REL_LINUX, REL_WHEEL_LINUX, wheel, now);
    InputEvent(dev, EV_REL_LINUX, REL_WHEEL_HI_RES_LINUX, wheel * 120, now);
  }
  InputEvent(dev, EV_SYN_LINUX, SYN_REPORT_LINUX, 0, now);
}

/* The host's pointer as QEMU's tablet reports it: the buttons and the
 * position it now has, and the wheel's notches, at most 127 a report. */
static void HostTabletReport(const i32 *events, u32 count,
                             struct InputTime now) {
  u32 i;
  i32 type, code, value, part;
  i64 wheel = 0;
  for (i = 0; i < count; ++i) {
    type = events[3 * i];
    code = events[3 * i + 1];
    value = events[3 * i + 2];
    if (type == EV_KEY_LINUX && code >= BTN_LEFT_LINUX &&
        code < BTN_LEFT_LINUX + 3) {
      if (value) {
        tablet.buttons |= 1u << (code - BTN_LEFT_LINUX);
      } else {
        tablet.buttons &= ~(1u << (code - BTN_LEFT_LINUX));
      }
    } else if (type == EV_ABS_LINUX && code == ABS_X_LINUX) {
      tablet.x = value;
    } else if (type == EV_ABS_LINUX && code == ABS_Y_LINUX) {
      tablet.y = value;
    } else if (type == EV_REL_LINUX && code == REL_WHEEL_LINUX) {
      wheel += value;
    }
  }
  // QEMU sends what is left over in the reports that follow; a host gives a
  // notch or a few at a time, and anything past eight reports' worth goes
  wheel = wheel < -8 * 127 ? -8 * 127 : wheel > 8 * 127 ? 8 * 127 : wheel;
  do {
    part = wheel < -127 ? -127 : wheel > 127 ? 127 : wheel;
    wheel -= part;
    TabletHidReport(part, now);
  } while (wheel);
}

// ------------------------------------------------------------- the readers

static struct EvdevClient *ClientOfFile(const struct DeviceFile *df) {
  struct EvdevClient *c;
  for (c = clients; c; c = c->next) {
    if (c->file == df) return c;
  }
  return 0;
}

static struct EvdevClient *ClientById(u64 id) {
  struct EvdevClient *c;
  if (!id) return 0;
  for (c = clients; c; c = c->next) {
    if (c->id == id) return c;
  }
  return 0;
}

static struct EvdevClient *ClientOf(int fildes) {
  struct Fd *fd;
  struct DeviceFile *df = 0;
  if (!g_machine) return 0;
  LOCK(&g_machine->system->fds.lock);
  if ((fd = GetFd(&g_machine->system->fds, fildes))) df = fd->device;
  UNLOCK(&g_machine->system->fds.lock);
  return df ? ClientOfFile(df) : 0;
}

/* What the console's KDMKTONE timer did by now reaches the PC Speaker before
 * a reader of it reads, polls, writes or asks (speaker.c keeps the timer
 * lazily). */
static void SettleConsole(const struct EvdevClient *c) {
  if (c && !c->revoked && DeviceIndex(c->device) == INPUT_SPEAKER) {
    SpeakerSettle();
  }
}

/* evdev_open(): a reader of its own, which every event reaches from now on. */
int OpenEvdev(struct DeviceFile *df) {
  struct EvdevClient *c, **last;
  Initialize();
  if (!(c = (struct EvdevClient *)calloc(1, sizeof(*c)))) return enomem();
  c->file = df;
  c->device = devices + df->node->input;
  c->id = ++last_client_id;
  c->clock = CLOCK_REALTIME_ID;
  for (last = &clients; *last; last = &(*last)->next) {
  }
  *last = c;
  return 0;
}

/* evdev_release(): the last close of a reader, which lets go of its grab. */
void ReleaseEvdev(struct DeviceFile *df) {
  struct EvdevClient *c, **link;
  for (link = &clients; (c = *link); link = &c->next) {
    if (c->file != df) continue;
    if (c->device->grab == c) c->device->grab = 0;
    *link = c->next;
    free(c->events);
    free(c);
    return;
  }
}

/* Whether a blocking read of the reader has to wait for a packet. */
bool EvdevReadWaits(struct DeviceFile *df) {
  struct EvdevClient *c = ClientOfFile(df);
  SettleConsole(c);
  return c && !c->revoked && !c->readable;
}

static size_t IovsSize(const struct iovec *iov, int iovcnt) {
  int i;
  size_t size;
  for (size = i = 0; i < iovcnt; ++i) size += iov[i].iov_len;
  return size;
}

/* `n` bytes at `offset` of what the vectors hold together: a buffer of the
 * program's reaches a device as one vector for each of its pages. */
static void CopyFromIovs(const struct iovec *iov, int iovcnt, size_t offset,
                         u8 *out, size_t n) {
  int i;
  size_t part;
  for (i = 0; i < iovcnt && n; ++i) {
    if (offset >= iov[i].iov_len) {
      offset -= iov[i].iov_len;
      continue;
    }
    part = MIN(n, iov[i].iov_len - offset);
    memcpy(out, (const u8 *)iov[i].iov_base + offset, part);
    out += part;
    n -= part;
    offset = 0;
  }
}

static void CopyToIovs(const struct iovec *iov, int iovcnt, const u8 *in,
                       size_t n) {
  int i;
  size_t part;
  for (i = 0; i < iovcnt && n; ++i) {
    part = MIN(n, iov[i].iov_len);
    memcpy(iov[i].iov_base, in, part);
    in += part;
    n -= part;
  }
}

/* evdev_read(): whole events of the packets complete so far, as many as the
 * buffer holds. A blocking read waited in WaitForDeviceRead() for one; an
 * O_NONBLOCK one with nothing answers EAGAIN. What it takes is journaled for
 * Undo to put back. */
ssize_t ReadEvdev(int fildes, const struct iovec *iov, int iovcnt) {
  u8 *record;
  u32 n;
  size_t size;
  struct EvdevClient *c;
  if (!(c = ClientOf(fildes))) return ebadf();
  size = IovsSize(iov, iovcnt);
  if (size && size < INPUT_EVENT_BYTES) return einval();
  if (c->revoked) return enodev();
  SettleConsole(c);
  if (!c->readable) return eagain();
  n = MIN(size / INPUT_EVENT_BYTES, c->readable);
  CopyToIovs(iov, iovcnt, EventAt(c, 0), (size_t)n * INPUT_EVENT_BYTES);
  unassert((record = (u8 *)malloc(12 + (size_t)n * INPUT_EVENT_BYTES)));
  Write64(record, c->id);
  Write32(record + 8, n);
  memcpy(record + 12, EventAt(c, 0), (size_t)n * INPUT_EVENT_BYTES);
  DebugHistoryJournal(JOURNAL_EVDEV_READ, record,
                      12 + n * INPUT_EVENT_BYTES);
  free(record);
  c->first += n;
  c->count -= n;
  c->readable -= n;
  return (ssize_t)n * INPUT_EVENT_BYTES;
}

// What a program's write or EVIOCSREP may change on a device, before and
// after, for Undo.
struct InputState {
  u64 key[KEY_WORDS];
  u64 led, snd, sw;
  i32 rep[2];
  i32 abs[2];
  u32 num_vals;
  struct InputValue vals[VALS_MAX];
  i32 console_flags, console_leds;
};

struct DeliveryRecord {
  u64 id, epoch;
  u32 count_before, readable_before, appended, unused;
};

struct InjectRecord {
  u32 input, deliveries;
  struct InputState before, after;
};

static void TakeState(const struct InputDevice *dev, struct InputState *s) {
  memset(s, 0, sizeof(*s));
  memcpy(s->key, dev->key, sizeof(s->key));
  s->led = dev->led;
  s->snd = dev->snd;
  s->sw = dev->sw;
  s->rep[0] = dev->rep[0];
  s->rep[1] = dev->rep[1];
  s->abs[0] = dev->abs[ABS_X_LINUX].value;
  s->abs[1] = dev->abs[ABS_Y_LINUX].value;
  s->num_vals = dev->num_vals;
  memcpy(s->vals, dev->vals, dev->num_vals * sizeof(*dev->vals));
  if (DeviceIndex(dev) == INPUT_KEYBOARD) {
    s->console_flags = kbd.console_flags;
    s->console_leds = kbd.console_leds;
  }
}

static void BeginInject(struct InputState *before,
                        const struct InputDevice *dev) {
  TakeState(dev, before);
  recording = true;
  delivery_count = 0;
}

/* Journals what a program's injection did: the device's state before and
 * after it, and where each reader it reached had its queue. */
static void EndInject(struct InputDevice *dev, struct InputState *before,
                      struct InputTime now) {
  u8 *p;
  u32 i, size;
  struct InjectRecord header;
  struct DeliveryRecord delivery;
  ConsoleBottomHalf(now);
  recording = false;
  memset(&header, 0, sizeof(header));
  header.input = DeviceIndex(dev);
  header.before = *before;
  TakeState(dev, &header.after);
  if (!delivery_count &&
      !memcmp(&header.before, &header.after, sizeof(header.before))) {
    return;
  }
  header.deliveries = delivery_count;
  size = sizeof(header) + delivery_count * sizeof(delivery);
  unassert((p = (u8 *)malloc(size)));
  memcpy(p, &header, sizeof(header));
  for (i = 0; i < delivery_count; ++i) {
    memset(&delivery, 0, sizeof(delivery));
    delivery.id = deliveries[i].id;
    delivery.epoch = deliveries[i].epoch;
    delivery.count_before = deliveries[i].count_before;
    delivery.readable_before = deliveries[i].readable_before;
    // a queue that overflowed lost what Undo would take out
    delivery.appended =
        deliveries[i].client->epoch == deliveries[i].epoch
            ? deliveries[i].client->count - deliveries[i].count_before
            : 0;
    memcpy(p + sizeof(header) + i * sizeof(delivery), &delivery,
           sizeof(delivery));
  }
  DebugHistoryJournal(JOURNAL_EVDEV_INJECT, p, size);
  free(p);
}

/* evdev_write(): whole events, at most 170 at a time, each injected into the
 * device as the input core takes it from a handler; EINVAL for less than one.
 * The speaker's driver plays what it takes. */
ssize_t WriteEvdev(int fildes, const struct iovec *iov, int iovcnt) {
  u8 ev[INPUT_EVENT_BYTES];
  size_t size, offset;
  struct EvdevClient *c;
  struct InputState before;
  struct InputTime now;
  if (!(c = ClientOf(fildes))) return ebadf();
  size = MIN(IovsSize(iov, iovcnt), EVDEV_WRITE_MAX);
  if (size && size < INPUT_EVENT_BYTES) return einval();
  if (c->revoked) return enodev();
  SettleConsole(c);
  now = ProgramNow();
  BeginInject(&before, c->device);
  for (offset = 0; offset + INPUT_EVENT_BYTES <= size;
       offset += INPUT_EVENT_BYTES) {
    CopyFromIovs(iov, iovcnt, offset, ev, INPUT_EVENT_BYTES);
    InjectEvent(c->device, Read16(ev + 16), Read16(ev + 18),
                (i32)Read32(ev + 20), now, false);
  }
  EndInject(c->device, &before, now);
  return size - size % INPUT_EVENT_BYTES;
}

/* kd_sound_helper(), for the one device with EV_SND the console's keyboard
 * handler is connected to, the PC Speaker: SND_TONE `hz`, and SND_BELL 0
 * after it when `hz` is silence, injected through the handler's handle as
 * Program time `at` has them, so that they reach the speaker's driver
 * (SpeakerInputEvent()) and the device's readers as on Linux: in the packet
 * being built, which only a SYN_REPORT or a full buffer passes on. A reader
 * holding EVIOCGRAB keeps them out; false then. Journaled as a write is. */
bool EvdevConsoleSound(u32 hz, i64 at) {
  struct InputDevice *dev;
  struct InputState before;
  struct InputTime t;
  Initialize();
  dev = devices + INPUT_SPEAKER;
  if (dev->grab) return false;
  t = ProgramNow();
  t.real -= t.mono - at;
  t.mono = at;
  BeginInject(&before, dev);
  InjectEvent(dev, EV_SND_LINUX, SND_TONE_LINUX, hz, t, true);
  if (!hz) InjectEvent(dev, EV_SND_LINUX, SND_BELL_LINUX, 0, t, true);
  EndInject(dev, &before, t);
  return true;
}

/* evdev_poll(): always writable, readable with a whole packet queued, and
 * hung up once revoked. */
int PollEvdev(struct pollfd *fds, nfds_t nfds, int timeout) {
  nfds_t i;
  int ready;
  struct EvdevClient *c;
  for (ready = i = 0; i < nfds; ++i) {
    fds[i].revents = 0;
    if (!(c = ClientOf(fds[i].fd))) {
      fds[i].revents = POLLNVAL;
    } else if (c->revoked) {
      fds[i].revents = POLLHUP | POLLERR;
    } else {
      SettleConsole(c);
      fds[i].revents = fds[i].events & POLLOUT;
      if (c->readable) fds[i].revents |= fds[i].events & POLLIN;
    }
    if (fds[i].revents) ++ready;
  }
  return ready;
}

// ------------------------------------------------------------------ ioctls

static int PutInt(struct Machine *m, i64 addr, i32 value) {
  u8 bytes[4];
  Write32(bytes, value);
  return CopyToUserWrite(m, addr, bytes, 4) == -1 ? efault() : 0;
}

/* bits_to_user(): the bitmap's longs up to `maxbit`, cut to `maxlen` bytes;
 * the length copied. */
static int BitsToUser(struct Machine *m, const u64 *bits, unsigned maxbit,
                      u32 maxlen, i64 addr) {
  u32 i, len;
  u8 bytes[KEY_WORDS * 8];
  len = (maxbit + 63) / 64 * 8;
  if (len > maxlen) len = maxlen;
  for (i = 0; i < (maxbit + 63) / 64; ++i) Write64(bytes + i * 8, bits[i]);
  if (len && CopyToUserWrite(m, addr, bytes, len) == -1) return efault();
  return len;
}

/* A flush of a reader's queue being journaled: where the queue stood, and
 * each event it removed with its place, so that the record holds only what
 * Undo has to put back. */
struct Flush {
  u8 *record;
  u32 removed, allocated;
};

// id, epoch, count and readable before, count after, how many it removed
#define FLUSH_HEADER 32
#define FLUSH_ENTRY  (4 + INPUT_EVENT_BYTES)  // an index and an event

static void BeginFlush(struct Flush *f, struct EvdevClient *c) {
  f->allocated = FLUSH_HEADER + 4 * FLUSH_ENTRY;
  unassert((f->record = (u8 *)malloc(f->allocated)));
  f->removed = 0;
  Write64(f->record, c->id);
  Write64(f->record + 8, c->epoch);
  Write32(f->record + 16, c->count);
  Write32(f->record + 20, c->readable);
}

static void NoteRemoved(struct Flush *f, u32 index, const u8 *ev) {
  u8 *grown;
  u32 at = FLUSH_HEADER + f->removed * FLUSH_ENTRY;
  if (at + FLUSH_ENTRY > f->allocated) {
    f->allocated *= 2;
    unassert((grown = (u8 *)realloc(f->record, f->allocated)));
    f->record = grown;
  }
  Write32(f->record + at, index);
  memcpy(f->record + at + 4, ev, INPUT_EVENT_BYTES);
  ++f->removed;
}

/* Journals the flush, unless it changed nothing: the events it removed,
 * and how many it left at the front, a SYN_DROPPED it queued included. */
static void EndFlush(struct Flush *f, struct EvdevClient *c) {
  if (f->removed || Read32(f->record + 16) != c->count ||
      Read32(f->record + 20) != c->readable) {
    Write32(f->record + 24, c->count);
    Write32(f->record + 28, f->removed);
    DebugHistoryJournal(JOURNAL_EVDEV_FLUSH, f->record,
                        FLUSH_HEADER + f->removed * FLUSH_ENTRY);
  }
  free(f->record);
}

/* __evdev_flush_queue(): drops the queued events of `type` and the reports
 * left empty, keeping a leading one. */
static void FlushQueue(struct EvdevClient *c, unsigned type, struct Flush *f) {
  u8 *ev;
  bool report;
  u32 i, head = 0, num = 1, readable = 0;
  for (i = 0; i < c->count; ++i) {
    ev = EventAt(c, i);
    report = Read16(ev + 16) == EV_SYN_LINUX &&
             Read16(ev + 18) == SYN_REPORT_LINUX;
    if (Read16(ev + 16) == type || (report && !num)) {
      NoteRemoved(f, i, ev);
      continue;
    }
    if (head != i) memcpy(EventAt(c, head), ev, INPUT_EVENT_BYTES);
    ++num;
    ++head;
    if (report) {
      num = 0;
      readable = head;
    }
  }
  c->count = head;
  c->readable = readable;
}

/* evdev_handle_get_val(): the state now, and the reader's queued events of
 * that type thrown away, so that it does not see them twice; a SYN_DROPPED
 * when the state could not be copied. */
static int GetValues(struct Machine *m, struct EvdevClient *c, unsigned type,
                     const u64 *bits, unsigned maxbit, u32 maxlen, i64 addr) {
  int rc;
  struct Flush flush;
  u64 copy[KEY_WORDS];
  memcpy(copy, bits, (maxbit + 63) / 64 * 8);
  BeginFlush(&flush, c);
  FlushQueue(c, type, &flush);
  if ((rc = BitsToUser(m, copy, maxbit, maxlen, addr)) < 0) {
    QueueSynDropped(c, ProgramNow());
  }
  EndFlush(&flush, c);
  return rc;
}

/* evdev_set_clk_type(): a reader's events are timed on another clock from
 * now on, and those it had queued go, for a SYN_DROPPED. */
static int SetClock(struct Machine *m, struct EvdevClient *c, i64 addr) {
  u8 id[4], record[16];
  u32 i;
  int clock;
  struct Flush flush;
  if (CopyFromUserRead(m, id, addr, 4) == -1) return efault();
  switch (Read32(id)) {
    case CLOCK_REALTIME_ID:
    case CLOCK_MONOTONIC_ID:
    case CLOCK_BOOTTIME_ID:
      clock = Read32(id);
      break;
    default:
      return einval();
  }
  if (c->clock == clock) return 0;
  Write64(record, c->id);
  Write32(record + 8, c->clock);
  Write32(record + 12, clock);
  DebugHistoryJournal(JOURNAL_EVDEV_CLOCK, record, sizeof(record));
  c->clock = clock;
  if (c->count) {
    BeginFlush(&flush, c);
    for (i = 0; i < c->count; ++i) NoteRemoved(&flush, i, EventAt(c, i));
    c->count = 0;
    c->readable = 0;
    QueueSynDropped(c, ProgramNow());
    EndFlush(&flush, c);
  }
  return 0;
}

static void JournalGrab(struct InputDevice *dev, u64 before, u64 after) {
  u8 record[24];
  Write64(record, DeviceIndex(dev));
  Write64(record + 8, before);
  Write64(record + 16, after);
  DebugHistoryJournal(JOURNAL_EVDEV_GRAB, record, sizeof(record));
}

/* evdev_grab() and evdev_ungrab(): one reader has the device's events to
 * itself, and the console none. */
static int Grab(struct EvdevClient *c, bool grab) {
  struct InputDevice *dev = c->device;
  if (grab) {
    if (dev->grab) {
      errno = EBUSY;
      return -1;
    }
    JournalGrab(dev, 0, c->id);
    dev->grab = c;
  } else {
    if (dev->grab != c) return einval();
    JournalGrab(dev, c->id, 0);
    dev->grab = 0;
  }
  return 0;
}

static int GetMask(struct Machine *m, struct EvdevClient *c, i64 addr) {
  u8 mask[16], ones[KEY_WORDS * 8], zeros[256];
  u32 type, codes_size, xfer, n;
  size_t cnt;
  i64 codes;
  if (CopyFromUserRead(m, mask, addr, sizeof(mask)) == -1) return efault();
  type = Read32(mask);
  codes_size = Read32(mask + 4);
  codes = Read64(mask + 8);
  cnt = MaskCount(type);
  xfer = MIN(codes_size, (cnt + 63) / 64 * 8);
  if (cnt) {
    if (c->masked >> type & 1) {
      if (BitsToUser(m, c->masks[type], cnt - 1, xfer, codes) < 0) return -1;
    } else {
      memset(ones, 0xff, sizeof(ones));
      if (xfer && CopyToUserWrite(m, codes, ones, xfer) == -1) return efault();
    }
  }
  memset(zeros, 0, sizeof(zeros));
  for (; xfer < codes_size; xfer += n) {
    n = MIN(codes_size - xfer, sizeof(zeros));
    if (CopyToUserWrite(m, codes + xfer, zeros, n) == -1) return efault();
  }
  return 0;
}

static int SetMask(struct Machine *m, struct EvdevClient *c, i64 addr) {
  u8 mask[16], bytes[KEY_WORDS * 8], record[16 + KEY_WORDS * 8];
  u32 type, codes_size, len, i;
  size_t cnt;
  i64 codes;
  u64 words[KEY_WORDS];
  if (CopyFromUserRead(m, mask, addr, sizeof(mask)) == -1) return efault();
  type = Read32(mask);
  codes_size = Read32(mask + 4);
  codes = Read64(mask + 8);
  if (!(cnt = MaskCount(type))) return 0;  // unknown types, for what comes
  if (codes_size % 8) return einval();
  len = MIN((cnt - 1 + 63) / 64 * 8, codes_size);
  memset(bytes, 0, sizeof(bytes));
  if (len && CopyFromUserRead(m, bytes, codes, len) == -1) return efault();
  for (i = 0; i < KEY_WORDS; ++i) words[i] = Read64(bytes + i * 8);
  Write64(record, c->id);
  Write32(record + 8, type);
  Write32(record + 12, c->masked >> type & 1);
  for (i = 0; i < KEY_WORDS; ++i) {
    Write64(record + 16 + i * 8, c->masks[type][i]);
  }
  DebugHistoryJournal(JOURNAL_EVDEV_MASK, record, sizeof(record));
  memcpy(c->masks[type], words, sizeof(words));
  c->masked |= 1u << type;
  return 0;
}

static void EncodeAbsinfo(u8 *p, const struct Absinfo *a) {
  Write32(p, a->value);
  Write32(p + 4, a->minimum);
  Write32(p + 8, a->maximum);
  Write32(p + 12, a->fuzz);
  Write32(p + 16, a->flat);
  Write32(p + 20, a->resolution);
}

static void DecodeAbsinfo(struct Absinfo *a, const u8 *p) {
  a->value = Read32(p);
  a->minimum = Read32(p + 4);
  a->maximum = Read32(p + 8);
  a->fuzz = Read32(p + 12);
  a->flat = Read32(p + 16);
  a->resolution = Read32(p + 20);
}

static int GetAbs(struct Machine *m, struct InputDevice *dev, unsigned axis,
                  u32 size, i64 addr) {
  u8 bytes[24];
  if (!Identity(dev)->absinfo) return einval();
  EncodeAbsinfo(bytes, dev->abs + axis);
  if (CopyToUserWrite(m, addr, bytes, MIN(size, sizeof(bytes))) == -1) {
    return efault();
  }
  return 0;
}

static int SetAbs(struct Machine *m, struct InputDevice *dev, unsigned axis,
                  u32 size, i64 addr) {
  u8 bytes[24], record[56];
  struct Absinfo abs;
  if (!Identity(dev)->absinfo) return einval();
  memset(bytes, 0, sizeof(bytes));
  if (CopyFromUserRead(m, bytes, addr, MIN(size, sizeof(bytes))) == -1) {
    return efault();
  }
  DecodeAbsinfo(&abs, bytes);
  if (size < sizeof(bytes)) abs.resolution = 0;
  if (axis == ABS_MT_SLOT_LINUX) return einval();
  Write32(record, DeviceIndex(dev));
  Write32(record + 4, axis);
  EncodeAbsinfo(record + 8, dev->abs + axis);
  EncodeAbsinfo(record + 32, &abs);
  DebugHistoryJournal(JOURNAL_EVDEV_ABS, record, sizeof(record));
  dev->abs[axis] = abs;
  return 0;
}

/* EVIOCSREP: two EV_REP events injected, which atkbd rounds and the next
 * packet carries to the readers. */
static int SetRepeat(struct Machine *m, struct EvdevClient *c, i64 addr) {
  u8 rep[8];
  struct InputState before;
  struct InputTime now;
  if (!Has(c->device, EV_REP_LINUX)) return enosys();
  if (CopyFromUserRead(m, rep, addr, 8) == -1) return efault();
  now = ProgramNow();
  BeginInject(&before, c->device);
  InjectEvent(c->device, EV_REP_LINUX, REP_DELAY_LINUX, (i32)Read32(rep), now,
              false);
  InjectEvent(c->device, EV_REP_LINUX, REP_PERIOD_LINUX, (i32)Read32(rep + 4),
              now, false);
  EndInject(c->device, &before, now);
  return 0;
}

/* input_scancode_to_scalar() */
static int ScancodeIndex(const u8 *entry, u32 *index) {
  switch (entry[1]) {
    case 1:
      *index = entry[8];
      return 0;
    case 2:
      *index = Read16(entry + 8);
      return 0;
    case 4:
      *index = Read32(entry + 8);
      return 0;
    default:
      return einval();
  }
}

/* input_default_getkeycode() on atkbd's table. */
static int GetKeycode(struct Machine *m, struct EvdevClient *c, i64 addr,
                      bool v2) {
  u8 entry[KEYMAP_ENTRY_SIZE];
  u32 index;
  if (DeviceIndex(c->device) != INPUT_KEYBOARD) return einval();
  memset(entry, 0, sizeof(entry));
  if (v2) {
    if (CopyFromUserRead(m, entry, addr, sizeof(entry)) == -1) return efault();
  } else {
    if (CopyFromUserRead(m, entry + 8, addr, 4) == -1) return efault();
    entry[1] = 4;
  }
  if (entry[0] & INPUT_KEYMAP_BY_INDEX) {
    index = Read16(entry + 2);
  } else if (ScancodeIndex(entry, &index) == -1) {
    return -1;
  }
  if (index >= ATKBD_KEYMAP_SIZE) return einval();
  if (!v2) return PutInt(m, addr + 4, kbd.keymap[index]);
  Write32(entry + 4, kbd.keymap[index]);
  Write16(entry + 2, index);
  entry[1] = 4;
  Write32(entry + 8, index);
  return CopyToUserWrite(m, addr, entry, sizeof(entry)) == -1 ? efault() : 0;
}

/* input_set_keycode() with input_default_setkeycode(): a scan code of the
 * keyboard reports another key from now on, which updates the keys it has
 * and releases the old key if it no longer has it. Not journaled: an Undo
 * barrier. */
static int SetKeycode(struct Machine *m, struct EvdevClient *c, i64 addr,
                      bool v2) {
  u8 entry[KEYMAP_ENTRY_SIZE];
  u32 index, keycode, old;
  int i;
  struct InputDevice *dev = c->device;
  struct InputTime now;
  if (DeviceIndex(dev) != INPUT_KEYBOARD) return einval();
  memset(entry, 0, sizeof(entry));
  if (v2) {
    if (CopyFromUserRead(m, entry, addr, sizeof(entry)) == -1) return efault();
    if (entry[1] > 32) return einval();
  } else {
    if (CopyFromUserRead(m, entry + 8, addr, 4) == -1) return efault();
    if (CopyFromUserRead(m, entry + 4, addr + 4, 4) == -1) return efault();
    entry[1] = 4;
  }
  keycode = Read32(entry + 4);
  if (keycode > KEY_MAX_LINUX) return einval();
  if (entry[0] & INPUT_KEYMAP_BY_INDEX) {
    index = Read16(entry + 2);
  } else if (ScancodeIndex(entry, &index) == -1) {
    return -1;
  }
  if (index >= ATKBD_KEYMAP_SIZE) return einval();
  DebugHistoryMarkIrreversible();
  old = kbd.keymap[index];
  kbd.keymap[index] = keycode;
  if (old <= KEY_MAX_LINUX) {
    ClearBit(dev->keybit, old);
    for (i = 0; i < ATKBD_KEYMAP_SIZE; ++i) {
      if (kbd.keymap[i] == old) {
        SetBit(dev->keybit, old);
        break;
      }
    }
  }
  SetBit(dev->keybit, keycode);
  ClearBit(dev->keybit, KEY_RESERVED_LINUX);
  if (old <= KEY_MAX_LINUX && !TestBit(dev->keybit, old) &&
      TestBit(dev->key, old)) {
    ClearBit(dev->key, old);
    now = ProgramNow();
    dev->vals[dev->num_vals++] = (struct InputValue){EV_KEY_LINUX, old, 0};
    dev->vals[dev->num_vals++] =
        (struct InputValue){EV_SYN_LINUX, SYN_REPORT_LINUX, 1};
    PassValues(dev, dev->vals, dev->num_vals, now);
    dev->num_vals = 0;
    dev->stamped = false;
  }
  return 0;
}

/* evdev_revoke(): the reader gets nothing more and every call on it answers
 * ENODEV. Not journaled: an Undo barrier. */
static int Revoke(struct EvdevClient *c) {
  DebugHistoryMarkIrreversible();
  c->revoked = true;
  if (c->device->grab == c) c->device->grab = 0;
  return 0;
}

/* EVIOCGBIT(type, len) */
static int GetBits(struct Machine *m, struct InputDevice *dev, unsigned type,
                   u32 size, i64 addr) {
  const struct InputCaps *caps = Caps(dev);
  switch (type) {
    case 0:
      return BitsToUser(m, &caps->ev, EV_MAX_LINUX, size, addr);
    case EV_KEY_LINUX:
      return BitsToUser(m, dev->keybit, KEY_MAX_LINUX, size, addr);
    case EV_REL_LINUX:
      return BitsToUser(m, &caps->rel, REL_MAX_LINUX, size, addr);
    case EV_ABS_LINUX:
      return BitsToUser(m, &caps->abs, ABS_MAX_LINUX, size, addr);
    case EV_MSC_LINUX:
      return BitsToUser(m, &caps->msc, MSC_MAX_LINUX, size, addr);
    case EV_LED_LINUX:
      return BitsToUser(m, &caps->led, LED_MAX_LINUX, size, addr);
    case EV_SND_LINUX:
      return BitsToUser(m, &caps->snd, SND_MAX_LINUX, size, addr);
    case EV_FF_LINUX:
      return BitsToUser(m, caps->ff, FF_MAX_LINUX, size, addr);
    case EV_SW_LINUX:
      return BitsToUser(m, &caps->sw, SW_MAX_LINUX, size, addr);
    default:
      return einval();
  }
}

/* evdev_do_ioctl(): EINVAL for anything it does not know, whatever its
 * type. */
int IoctlEvdev(struct Machine *m, int fildes, u64 request, i64 addr) {
  u8 bytes[8];
  u32 cmd = request, size, nr;
  struct EvdevClient *c;
  struct InputDevice *dev;
  const struct InputIdentity *identity;
  if (!(c = ClientOf(fildes))) return ebadf();
  if (c->revoked) return enodev();
  SettleConsole(c);
  dev = c->device;
  identity = Identity(dev);
  switch (cmd) {
    case EVIOCGVERSION:
      return PutInt(m, addr, EV_VERSION_LINUX);
    case EVIOCGID:
      Write16(bytes + 0, identity->bustype);
      Write16(bytes + 2, identity->vendor);
      Write16(bytes + 4, identity->product);
      Write16(bytes + 6, identity->version);
      return CopyToUserWrite(m, addr, bytes, 8) == -1 ? efault() : 0;
    case EVIOCGREP:
      if (!Has(dev, EV_REP_LINUX)) return enosys();
      Write32(bytes, dev->rep[REP_DELAY_LINUX]);
      Write32(bytes + 4, dev->rep[REP_PERIOD_LINUX]);
      return CopyToUserWrite(m, addr, bytes, 8) == -1 ? efault() : 0;
    case EVIOCSREP:
      return SetRepeat(m, c, addr);
    case EVIOCRMFF:
      return enosys();  // input_ff_erase(): no device has force feedback
    case EVIOCGEFFECTS:
      return PutInt(m, addr, 0);
    case EVIOCGRAB:
      return Grab(c, addr != 0);
    case EVIOCREVOKE:
      return addr ? einval() : Revoke(c);
    case EVIOCGMASK:
      return GetMask(m, c, addr);
    case EVIOCSMASK:
      return SetMask(m, c, addr);
    case EVIOCSCLOCKID:
      return SetClock(m, c, addr);
    case EVIOCGKEYCODE:
      return GetKeycode(m, c, addr, false);
    case EVIOCSKEYCODE:
      return SetKeycode(m, c, addr, false);
    case EVIOCGKEYCODE_V2:
      return GetKeycode(m, c, addr, true);
    case EVIOCSKEYCODE_V2:
      return SetKeycode(m, c, addr, true);
    default:
      break;
  }
  size = IOC_SIZE(cmd);
  switch (cmd & ~(0x3fffu << 16)) {
    case EVIOCGPROP_0:
      return BitsToUser(m, &identity->caps.prop, INPUT_PROP_MAX_LINUX, size,
                        addr);
    case EVIOCGMTSLOTS_0:
      if (CopyFromUserRead(m, bytes, addr, 4) == -1) return efault();
      return einval();  // no device has multi-touch slots
    case EVIOCGKEY_0:
      return GetValues(m, c, EV_KEY_LINUX, dev->key, KEY_MAX_LINUX, size, addr);
    case EVIOCGLED_0:
      return GetValues(m, c, EV_LED_LINUX, &dev->led, LED_MAX_LINUX, size,
                       addr);
    case EVIOCGSND_0:
      return GetValues(m, c, EV_SND_LINUX, &dev->snd, SND_MAX_LINUX, size,
                       addr);
    case EVIOCGSW_0:
      return GetValues(m, c, EV_SW_LINUX, &dev->sw, SW_MAX_LINUX, size, addr);
    case EVIOCGNAME_0:
      return IoctlString(m, identity->name, cmd, addr);
    case EVIOCGPHYS_0:
      return IoctlString(m, identity->phys, cmd, addr);
    case EVIOCGUNIQ_0:
      return IoctlString(m, identity->uniq, cmd, addr);
    case EVIOCSFF_0:
      // input_ff_effect_from_user() fails as EFAULT, then input_ff_upload()
      if (size != FF_EFFECT_SIZE) return efault();
      {
        u8 effect[FF_EFFECT_SIZE];
        if (CopyFromUserRead(m, effect, addr, size) == -1) return efault();
      }
      return enosys();
    default:
      break;
  }
  if ((cmd >> 8 & 0xff) != 'E') return einval();
  nr = cmd & 0xff;
  if (IOC_DIR(cmd) == IOC_READ_LINUX) {
    if ((nr & ~EV_MAX_LINUX) == 0x20) {
      return GetBits(m, dev, nr & EV_MAX_LINUX, size, addr);
    }
    if ((nr & ~ABS_MAX_LINUX) == 0x40) {
      return GetAbs(m, dev, nr & ABS_MAX_LINUX, size, addr);
    }
  }
  if (IOC_DIR(cmd) == IOC_WRITE_LINUX && (nr & ~ABS_MAX_LINUX) == 0xc0) {
    return SetAbs(m, dev, nr & ABS_MAX_LINUX, size, addr);
  }
  return einval();
}

// --------------------------------------------------------------------- Undo

static void RestoreBits(u64 *now, const u64 *before, const u64 *after,
                        int words) {
  int i;
  u64 mask;
  for (i = 0; i < words; ++i) {
    mask = (before[i] ^ after[i]) & ~(now[i] ^ after[i]);
    now[i] = (now[i] & ~mask) | (before[i] & mask);
  }
}

static void RestoreInt(i32 *now, i32 before, i32 after) {
  if (*now == after) *now = before;
}

/* What a program's write changed on the device goes back where nothing has
 * changed it since: the state the host's reports keep is live. */
static void RestoreState(struct InputDevice *dev, const struct InputState *b,
                         const struct InputState *a) {
  RestoreBits(dev->key, b->key, a->key, KEY_WORDS);
  RestoreBits(&dev->led, &b->led, &a->led, 1);
  RestoreBits(&dev->snd, &b->snd, &a->snd, 1);
  RestoreBits(&dev->sw, &b->sw, &a->sw, 1);
  RestoreInt(dev->rep + 0, b->rep[0], a->rep[0]);
  RestoreInt(dev->rep + 1, b->rep[1], a->rep[1]);
  RestoreInt(&dev->abs[ABS_X_LINUX].value, b->abs[0], a->abs[0]);
  RestoreInt(&dev->abs[ABS_Y_LINUX].value, b->abs[1], a->abs[1]);
  if (dev->num_vals == a->num_vals &&
      !memcmp(dev->vals, a->vals, a->num_vals * sizeof(*a->vals))) {
    dev->num_vals = b->num_vals;
    memcpy(dev->vals, b->vals, b->num_vals * sizeof(*b->vals));
  }
  if (DeviceIndex(dev) == INPUT_KEYBOARD) {
    RestoreInt(&kbd.console_flags, b->console_flags, a->console_flags);
    RestoreInt(&kbd.console_leds, b->console_leds, a->console_leds);
  }
}

/* Takes back what an evdev journal record says an undone instruction did.
 * The records of one instruction are taken back newest first, so a reader's
 * queue has, at its front, what that instruction left it, and behind it
 * only what the host's reports added since. */
void UndoEvdevJournal(u32 kind, const u8 *p, u32 size) {
  const u8 *entry;
  u8 *events;
  u32 i, n, removed, kept, count_before, count_after, readable_before, appended;
  struct EvdevClient *c;
  struct InputDevice *dev;
  struct InjectRecord header;
  struct DeliveryRecord delivery;
  struct Absinfo before, after, *abs;
  switch (kind) {
    case JOURNAL_EVDEV_READ:
      // the events go back at the front: no read of a device asks again
      if (!(c = ClientById(Read64(p)))) break;
      n = Read32(p + 8);
      Prepend(c, p + 12, n);
      c->readable += n;
      break;
    case JOURNAL_EVDEV_FLUSH:
      // the queue's front is what the flush left, the events it kept first
      if (!(c = ClientById(Read64(p))) || c->epoch != Read64(p + 8)) break;
      count_before = Read32(p + 16);
      readable_before = Read32(p + 20);
      count_after = Read32(p + 24);
      n = Read32(p + 28);
      if (c->count < count_after || count_before - n > count_after) break;
      unassert((events = (u8 *)malloc((size_t)count_before *
                                      INPUT_EVENT_BYTES)));
      for (removed = kept = i = 0; i < count_before; ++i) {
        entry = p + FLUSH_HEADER + removed * FLUSH_ENTRY;
        if (removed < n && Read32(entry) == i) {
          memcpy(events + (size_t)i * INPUT_EVENT_BYTES, entry + 4,
                 INPUT_EVENT_BYTES);
          ++removed;
        } else {
          memcpy(events + (size_t)i * INPUT_EVENT_BYTES, EventAt(c, kept++),
                 INPUT_EVENT_BYTES);
        }
      }
      Remove(c, 0, count_after);
      Prepend(c, events, count_before);
      free(events);
      if (c->readable <= count_after) {
        c->readable = readable_before;
      } else {
        c->readable = c->readable - count_after + count_before;
      }
      break;
    case JOURNAL_EVDEV_CLOCK:
      if ((c = ClientById(Read64(p))) && c->clock == (int)Read32(p + 12)) {
        c->clock = Read32(p + 8);
      }
      break;
    case JOURNAL_EVDEV_INJECT:
      memcpy(&header, p, sizeof(header));
      dev = devices + header.input;
      for (i = 0; i < header.deliveries; ++i) {
        memcpy(&delivery, p + sizeof(header) + i * sizeof(delivery),
               sizeof(delivery));
        if (!(c = ClientById(delivery.id)) || c->epoch != delivery.epoch ||
            !(appended = delivery.appended) ||
            c->count < delivery.count_before + appended) {
          continue;
        }
        Remove(c, delivery.count_before, appended);
        if (c->readable == delivery.count_before + appended) {
          c->readable = delivery.readable_before;
        } else if (c->readable > delivery.count_before + appended) {
          c->readable -= appended;
        }
      }
      RestoreState(dev, &header.before, &header.after);
      break;
    case JOURNAL_EVDEV_GRAB:
      dev = devices + Read64(p);
      if ((dev->grab ? dev->grab->id : 0) == Read64(p + 16)) {
        dev->grab = ClientById(Read64(p + 8));
      }
      break;
    case JOURNAL_EVDEV_MASK:
      if (!(c = ClientById(Read64(p)))) break;
      n = Read32(p + 8);
      if (Read32(p + 12)) {
        c->masked |= 1u << n;
      } else {
        c->masked &= ~(1u << n);
      }
      for (i = 0; i < KEY_WORDS; ++i) c->masks[n][i] = Read64(p + 16 + i * 8);
      break;
    case JOURNAL_EVDEV_ABS:
      dev = devices + Read32(p);
      abs = dev->abs + Read32(p + 4);
      DecodeAbsinfo(&before, p + 8);
      DecodeAbsinfo(&after, p + 32);
      RestoreInt(&abs->value, before.value, after.value);
      RestoreInt(&abs->minimum, before.minimum, after.minimum);
      RestoreInt(&abs->maximum, before.maximum, after.maximum);
      RestoreInt(&abs->fuzz, before.fuzz, after.fuzz);
      RestoreInt(&abs->flat, before.flat, after.flat);
      RestoreInt(&abs->resolution, before.resolution, after.resolution);
      break;
    default:
      break;
  }
}

// ------------------------------------------------- exports for the wrapper

/* Where the host writes a report's events, as type, code and value. */
EMSCRIPTEN_KEEPALIVE
i32 *blinkenlib_input_report_buffer(void) {
  return report_buffer;
}

EMSCRIPTEN_KEEPALIVE
u32 blinkenlib_input_report_capacity(void) {
  return INPUT_REPORT_MAX;
}

/* One report of the host's to the keyboard (INPUT_KEYBOARD) or the tablet
 * (INPUT_TABLET), the `count` events in the buffer, at the Program time given
 * on the wall clock and the monotonic one: it reaches the device as its
 * hardware would deliver it. True when a reader got a whole packet, which may
 * end a wait on the device. Nothing happens without a running program. */
EMSCRIPTEN_KEEPALIVE
bool blinkenlib_input_report(u32 input, u32 count, double realtime_ms,
                             double monotonic_ms) {
  struct InputTime now;
  if (!g_machine || g_machine->system->exited || count > INPUT_REPORT_MAX) {
    return false;
  }
  Initialize();
  now.real = MillisecondsToNanoseconds(realtime_ms);
  now.mono = MillisecondsToNanoseconds(monotonic_ms);
  woke = false;
  switch (input) {
    case INPUT_KEYBOARD:
      HostKeyboardReport(report_buffer, count, now);
      break;
    case INPUT_TABLET:
      HostTabletReport(report_buffer, count, now);
      break;
    default:
      return false;
  }
  return woke;
}

static int PrintBitmap(char *out, size_t room, const char *name,
                       const u64 *bits, unsigned max) {
  int i, n;
  bool skip = true;
  n = snprintf(out, room, "B: %s=", name);
  for (i = (max + 63) / 64 - 1; i >= 0; --i) {
    if (skip && !bits[i]) continue;
    skip = false;
    n += snprintf(out + n, room - n, "%llx%s", (unsigned long long)bits[i],
                  i > 0 ? " " : "");
  }
  n += snprintf(out + n, room - n, "%s\n", skip ? "0" : "");
  return n;
}

/* /proc/bus/input/devices: each input device as input_devices_seq_show()
 * prints it, in /dev/input's order. */
EMSCRIPTEN_KEEPALIVE
const char *blinkenlib_input_devices_text(void) {
  int i;
  size_t used;
  static char text[8192];
  const struct InputIdentity *d;
  const struct InputCaps *caps;
  const struct InputDevice *dev;
  Initialize();
  for (used = i = 0; i < INPUT_DEVICES; ++i) {
    d = kInputIdentities + i;
    caps = &d->caps;
    dev = devices + i;
    used += snprintf(text + used, sizeof(text) - used,
                     "I: Bus=%04x Vendor=%04x Product=%04x Version=%04x\n"
                     "N: Name=\"%s\"\n"
                     "P: Phys=%s\n"
                     "S: Sysfs=%s\n"
                     "U: Uniq=%s\n"
                     "H: Handlers=%s \n",
                     d->bustype, d->vendor, d->product, d->version, d->name,
                     d->phys ? d->phys : "", d->sysfs, d->uniq ? d->uniq : "",
                     d->handlers);
    used += PrintBitmap(text + used, sizeof(text) - used, "PROP", &caps->prop,
                        INPUT_PROP_MAX_LINUX);
    used += PrintBitmap(text + used, sizeof(text) - used, "EV", &caps->ev,
                        EV_MAX_LINUX);
#define BITMAP(TYPE, NAME, BITS, MAX)                                   \
  if (caps->ev >> TYPE & 1) {                                           \
    used += PrintBitmap(text + used, sizeof(text) - used, NAME, BITS, MAX); \
  }
    BITMAP(EV_KEY_LINUX, "KEY", dev->keybit, KEY_MAX_LINUX);
    BITMAP(EV_REL_LINUX, "REL", &caps->rel, REL_MAX_LINUX);
    BITMAP(EV_ABS_LINUX, "ABS", &caps->abs, ABS_MAX_LINUX);
    BITMAP(EV_MSC_LINUX, "MSC", &caps->msc, MSC_MAX_LINUX);
    BITMAP(EV_LED_LINUX, "LED", &caps->led, LED_MAX_LINUX);
    BITMAP(EV_SND_LINUX, "SND", &caps->snd, SND_MAX_LINUX);
    BITMAP(EV_FF_LINUX, "FF", caps->ff, FF_MAX_LINUX);
    BITMAP(EV_SW_LINUX, "SW", &caps->sw, SW_MAX_LINUX);
#undef BITMAP
    used += snprintf(text + used, sizeof(text) - used, "\n");
    unassert(used < sizeof(text));
  }
  return text;
}
