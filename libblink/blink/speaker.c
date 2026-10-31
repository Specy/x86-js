/* The PC speaker: Linux's pcspkr input device, which a program sounds by
 * writing EV_SND events to /dev/input/event4, and the virtual console's
 * KIOCSOUND and KDMKTONE on /dev/tty0, which reach the same speaker through
 * the keyboard handler and the input core, so that the device's readers see
 * them too (x86-devices.md, "The PC speaker"; evdev.c).
 *
 * The speaker is one tone: channel 2 of the PIT at 1193182 ÷ count Hz, or
 * silence. It follows the Synth's rules under Undo, as a chip with one
 * register: Undo puts the tone back as it was and sounds it again if need
 * be. KDMKTONE's timer is kept lazily: the end of the tone is on the host's
 * timeline from the start, and the silence it injects reaches the input
 * device the next time anything asks (SpeakerSettle()). */
#include <errno.h>
#include <string.h>

#include "blink/debughistory.h"
#include "blink/endian.h"
#include "blink/errno.h"
#include "blink/evdev.h"
#include "blink/linux.h"
#include "blink/machine.h"
#include "blink/sound.h"
#include "blink/speaker.h"

#define PIT_TICK_RATE 1193182
#define EV_SND        0x12
#define SND_BELL      0x01
#define SND_TONE      0x02
#define KIOCSOUND     0x4b2f
#define KDMKTONE      0x4b30
// Debian's kernel ticks at 250 Hz: KDMKTONE's duration is whole jiffies
#define JIFFY_NS 4000000

struct Tone {
  u32 count;  // the PIT divisor sounding, 0 for silence
  u8 timer;   // a KDMKTONE that ends the tone at `stop` is pending
  u8 ending;  // and the host has its end, the silence at `stop`, already
  i64 stop;
};

static struct Tone tone;
static struct termios_linux console_termios;
static bool console_termios_known;

// The console is sounding the speaker through the input core, at `console_at`
// in Program time, and has journaled the tone already.
static bool console;
static i64 console_at;

static double ToneHz(u32 count) {
  return count ? (double)PIT_TICK_RATE / count : 0;
}

static bool Expired(i64 now) {
  return tone.timer && now >= tone.stop;
}

static void Journal(void) {
  u8 record[14];
  Write32(record, tone.count);
  record[4] = tone.timer;
  Write64(record + 5, tone.stop);
  record[13] = tone.ending;
  DebugHistoryJournal(JOURNAL_TONE, record, sizeof(record));
}

/* pcspkr_event(): SND_BELL with any value but 0 is 1000 Hz, SND_TONE its
 * value in Hz, between 20 and 32767 exclusive, at the frequency the PIT can
 * make; anything else silences it. */
static void Sound(u16 code, i32 value, i64 now) {
  u32 count = 0;
  if (code == SND_BELL && value) value = 1000;
  if (value > 20 && value < 32767) count = PIT_TICK_RATE / value;
  if (count == tone.count) return;
  tone.count = count;
  SoundEmitTone(now, ToneHz(count));
}

/* The console's tone through the input core (evdev.c): to the driver, and to
 * the speaker device's readers. A reader's grab keeps it out. */
static bool ConsoleSound(u32 hz, i64 at) {
  bool reached;
  console = true;
  console_at = at;
  reached = EvdevConsoleSound(hz, at);
  console = false;
  return reached;
}

/* kd_nosound(): KDMKTONE's timer went off at `stop`, by `now`, and injects
 * silence. The host already has the silence when the start reached the
 * speaker; it gets it now when the start was kept out by a grab. */
static void Expire(i64 now) {
  i64 stop;
  if (!Expired(now)) return;
  Journal();
  stop = tone.stop;
  if (tone.ending) tone.count = 0;
  tone.timer = 0;
  tone.ending = 0;
  ConsoleSound(0, stop);
}

/* What KDMKTONE's timer did by now reaches the speaker and its input device:
 * evdev.c asks before anything it does with the speaker's readers. */
void SpeakerSettle(void) {
  Expire(SoundNow());
}

int SpeakerInputEvent(struct Machine *m, u16 type, u16 code, i32 value) {
  i64 now;
  // the input core passes the device only the sound codes it has
  if (type != EV_SND || (code != SND_BELL && code != SND_TONE)) return 0;
  if (console) {
    now = console_at;
  } else {
    // a write to /dev/input/event4, which settled the timer first
    now = SoundNow();
    Journal();
    if (Expired(now)) {
      if (tone.ending) tone.count = 0;
      tone.timer = 0;
      tone.ending = 0;
    }
  }
  Sound(code, value, now);
  return 0;
}

/* kd_mksound(): any call cancels a KDMKTONE still running, then the tone
 * reaches the speaker as SND_TONE, and silence as SND_BELL 0 too, through the
 * input core; a duration ends it that many jiffies later. */
static void MakeSound(u32 hz, u32 ticks) {
  bool reached;
  i64 now = SoundNow();
  Expire(now);
  Journal();
  if (tone.timer) {
    // the end it scheduled is no longer coming
    if (tone.ending) SoundEmitCut(now, SOUND_SPEAKER);
    tone.timer = 0;
    tone.ending = 0;
  }
  reached = ConsoleSound(hz, now);
  if (hz && ticks) {
    tone.timer = 1;
    tone.stop = now + (i64)ticks * JIFFY_NS;
    // the end, when the start sounded; one kept out comes when it expires
    if ((tone.ending = reached)) SoundEmitTone(tone.stop, 0);
  }
}

static void DefaultConsoleTermios(struct termios_linux *tio) {
  // tty_std_termios with IUTF8, as the virtual console's driver has it
  memset(tio, 0, sizeof(*tio));
  Write32(tio->iflag, ICRNL_LINUX | IXON_LINUX | IUTF8_LINUX);
  Write32(tio->oflag, OPOST_LINUX | ONLCR_LINUX);
  Write32(tio->cflag, B38400_LINUX | CS8_LINUX | CREAD_LINUX | HUPCL_LINUX);
  Write32(tio->lflag, ISIG_LINUX | ICANON_LINUX | ECHO_LINUX | ECHOE_LINUX |
                          ECHOK_LINUX | ECHOCTL_LINUX | ECHOKE_LINUX |
                          IEXTEN_LINUX);
  tio->cc[VINTR_LINUX] = 'C' - '@';
  tio->cc[VQUIT_LINUX] = '\\' - '@';
  tio->cc[VERASE_LINUX] = 0177;
  tio->cc[VKILL_LINUX] = 'U' - '@';
  tio->cc[VEOF_LINUX] = 'D' - '@';
  tio->cc[VMIN_LINUX] = 1;
  tio->cc[VSTART_LINUX] = 'Q' - '@';
  tio->cc[VSTOP_LINUX] = 'S' - '@';
  tio->cc[VSUSP_LINUX] = 'Z' - '@';
  tio->cc[VREPRINT_LINUX] = 'R' - '@';
  tio->cc[VDISCARD_LINUX] = 'O' - '@';
  tio->cc[VWERASE_LINUX] = 'W' - '@';
  tio->cc[VLNEXT_LINUX] = 'V' - '@';
}

static struct termios_linux *ConsoleTermios(void) {
  if (!console_termios_known) {
    DefaultConsoleTermios(&console_termios);
    console_termios_known = true;
  }
  return &console_termios;
}

/* /dev/tty0, the virtual console: a tty, so isatty() holds and its termios
 * reads back, and the console's tone ioctls, which take an argument rather
 * than a pointer. vt_ioctl() lets them through for CAP_SYS_TTY_CONFIG, which
 * root holds, since tty0 is not the program's controlling terminal. The
 * console's other requests (KDSETMODE and the rest) are not covered. */
int ConsoleIoctl(struct Machine *m, int fildes, u64 request, i64 addr) {
  u8 change[2 * sizeof(struct termios_linux)];
  u32 ms, ticks, count;
  struct termios2_linux tio2;
  struct termios_linux *tio = ConsoleTermios();
  switch ((u32)request) {
    case KIOCSOUND:
      if (m->system->uid[1]) return eperm();
      // the argument is the PIT's divisor
      MakeSound(addr ? PIT_TICK_RATE / (u64)addr : 0, 0);
      return 0;
    case KDMKTONE:
      if (m->system->uid[1]) return eperm();
      // the divisor in the low 16 bits, the duration in milliseconds above
      ms = ((u64)addr >> 16) & 0xffff;
      ticks = (ms + JIFFY_NS / 1000000 - 1) / (JIFFY_NS / 1000000);
      count = ticks ? (u64)addr & 0xffff : 0;
      MakeSound(count ? PIT_TICK_RATE / count : 0, ticks);
      return 0;
    case TCGETS_LINUX:
      return CopyToUserWrite(m, addr, tio, sizeof(*tio)) == -1 ? efault() : 0;
    case TCGETS2_LINUX:
      memset(&tio2, 0, sizeof(tio2));
      tio2.termios = *tio;
      Write32(tio2.ispeed, 38400);
      Write32(tio2.ospeed, 38400);
      return CopyToUserWrite(m, addr, &tio2, sizeof(tio2)) == -1 ? efault() : 0;
    case TCSETS_LINUX:
    case TCSETSW_LINUX:
    case TCSETSF_LINUX:
    case TCSETS2_LINUX:
    case TCSETSW2_LINUX:
    case TCSETSF2_LINUX:
      // what the console is typed has no keyboard here, so only the settings
      // are kept
      if (CopyFromUserRead(m, &tio2, addr, sizeof(tio2.termios)) == -1) {
        return efault();
      }
      if (memcmp(tio, &tio2.termios, sizeof(*tio))) {
        memcpy(change, tio, sizeof(*tio));
        DebugHistoryJournal(JOURNAL_CONSOLE_TERMIOS, change, sizeof(*tio));
        *tio = tio2.termios;
      }
      return 0;
    default:
      return enotty();
  }
}

void ResetSpeaker(void) {
  memset(&tone, 0, sizeof(tone));
  console_termios_known = false;
}

void UndoSpeakerJournal(u32 kind, const u8 *data, u32 size) {
  i64 now;
  switch (kind) {
    case JOURNAL_TONE:
      now = SoundNow();
      tone.count = Read32(data);
      tone.timer = data[4];
      tone.stop = Read64(data + 5);
      tone.ending = data[13];
      // the tone as it was, and its end if one is still coming; a KDMKTONE
      // that ran out meanwhile is silent, and its timer reaches the input
      // device the next time anything asks
      SoundEmitCut(now, SOUND_SPEAKER);
      SoundEmitTone(now, Expired(now) && tone.ending ? 0 : ToneHz(tone.count));
      if (tone.timer && tone.ending && !Expired(now)) {
        SoundEmitTone(tone.stop, 0);
      }
      break;
    case JOURNAL_CONSOLE_TERMIOS:
      memcpy(ConsoleTermios(), data, sizeof(struct termios_linux));
      break;
    default:
      break;
  }
}
