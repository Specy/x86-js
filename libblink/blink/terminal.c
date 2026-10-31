/* The terminal a program's standard streams refer to, as a Linux process
 * started on the machine's serial console has them (ADR 0068): descriptors
 * 0, 1 and 2 are one terminal, open for reading and writing, which isatty()
 * recognises because it answers TCGETS and TIOCGWINSZ. Nothing goes through
 * Emscripten's file system. Each descriptor keeps a host descriptor of the
 * same number only so that the host hands out the numbers Linux would: 3 for
 * the first open(), 1 for an open() after close(1).
 *
 * Its termios is the program's: TCSETS and the rest store what they are
 * given, TCGETS reads it back, and every program starts with the canonical
 * settings below. The host's line discipline (the editor's Terminal) edits
 * lines and echoes; Blink reads them as the settings say.
 *
 * Input. The host gives the terminal bytes, whether or not a read waits for
 * them: a line ended with Enter in canonical mode, each key as it is typed
 * otherwise, and End of input for Ctrl+D on an empty line. They queue here,
 * in the order they came, after ICRNL and its relatives have turned carriage
 * returns into line feeds (when the host asks for that, see
 * blinkenlib_set_terminal_processing()). A canonical read takes at most the
 * bytes it asked for and never past the end of a line, so the rest waits for
 * the next read. A non-canonical read takes what is queued, and waits as
 * VMIN and VTIME say, VTIME's tenths of a second on Program time. A read that
 * finds an End of input token first returns 0 and takes the token, so each
 * token ends one read. A read that has to wait halts the machine before it
 * has set anything up or recorded anything, the host provides input or the
 * time passes, and the system call starts over.
 *
 * Undo (ADR 0069, ADR 0057). What each read takes is journaled in the
 * history, so a read is not an Undo barrier. Undo of a read that waited for
 * its input asks again: what it took is not put back, and neither is the
 * rest of what arrived while it waited, a line it read only part of. What a
 * read found already queued, type-ahead, goes back at the front of the queue.
 * A flush of the input is journaled the same way, and so is every change of
 * the termios.
 *
 * Output. Every write reaches the host as one call of its own, with the bytes
 * it wrote, on the channel of the descriptor it went through, so the host
 * sees standard output and standard error in the order the program wrote
 * them. Under OPOST, ONLCR sends a line feed as a carriage return and a line
 * feed and OCRNL a carriage return as a line feed, as Linux's n_tty does, when
 * the host asks for that. */
#include "blink/terminal.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <termios.h>
#include <unistd.h>

#include "blink/assert.h"
#include "blink/blinkenlib.h"
#include "blink/debughistory.h"
#include "blink/devices.h"
#include "blink/endian.h"
#include "blink/environment.h"
#include "blink/errno.h"
#include "blink/linux.h"
#include "blink/macros.h"
#include "blink/random.h"
#include "blink/signal.h"
#include "blink/timespec.h"
#include "blink/vfs.h"
#include "blink/xlat.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// A listener that throws must not unwind through the system call that
// changed the mode.
EM_JS(void, NotifyTerminalModeHost, (int mode), {
  try {
    if (Module.blinkTerminalMode) Module.blinkTerminalMode(mode);
  } catch (error) {
    setTimeout(() => { throw error; }, 0);
  }
});
#endif

void (*terminal_output_callback)(int, const u8 *, u32) = 0;

/* The bytes no read has taken yet are input[head..tail). `position` counts
 * the bytes taken before input[head] since the input was last cleared, so
 * position + i is the index of input[head + i] in everything the terminal
 * was ever given, and each End of input token is kept as the index it comes
 * at. */
static u8 *input;
static size_t head, tail, allocated;
static u64 position;
static u64 *ends;
static size_t end_count, end_allocated;
/* The size of the read that last waited for input. */
static u64 wait_size;

/* The terminal's termios, Linux's own structure, and whether the host wants
 * input and output processed as it says. */
static struct termios_linux termios;
static bool termios_known;
static bool process_input, process_output;
static int reported_mode = -1;

/* What the read the instruction `read_identity` runs knows across the times
 * it starts over: whether it halted for input, and where the queue ended
 * when it first did, so that what it then takes is told apart from what it
 * found queued; when it began, for VTIME without VMIN; how many bytes it last
 * found and when, for VTIME's timer between bytes. */
static u64 read_identity;
static bool read_waited;
static u64 read_wait_tail;
static bool read_began;
static i64 read_began_at;
static u64 read_seen;
static i64 read_seen_at;
/* An empty non-canonical read whose VMIN and VTIME let it return 0, rather
 * than fail with EAGAIN. Set by WaitForTerminalInput() for the read that
 * follows it. */
static bool read_returns_zero;

/* The device numbers of /dev/tty, /dev/stdin, /dev/stdout and /dev/stderr,
 * learned before any program could remove them. */
static dev_t devices[6];
static bool devices_known;

// ----------------------------------------------------------------- the queue

static u64 TailIndex(void) {
  return position + (tail - head);
}

/* The bytes a read can take before the first End of input token. */
static size_t AvailableTerminalInput(void) {
  if (end_count) return MIN(tail - head, ends[0] - position);
  return tail - head;
}

static void Reserve(size_t size) {
  size_t want;
  u8 *grown;
  if (size <= allocated - tail) return;
  if (head) {
    memmove(input, input + head, tail - head);
    tail -= head;
    head = 0;
  }
  if (size > allocated - tail) {
    unassert(size <= (size_t)-1 / 2 - tail);
    want = MAX(MAX(allocated * 2, tail + size), 256);
    unassert((grown = (u8 *)realloc(input, want)));
    input = grown;
    allocated = want;
  }
}

static void Append(const u8 *bytes, size_t size) {
  Reserve(size);
  memcpy(input + tail, bytes, size);
  tail += size;
}

/* Puts bytes back at the front of the queue, for Undo. */
static void Prepend(const u8 *bytes, size_t size) {
  if (!size) return;
  if (head < size) {
    Reserve(size);
    memmove(input + size, input + head, tail - head);
    tail = tail - head + size;
    head = size;
  }
  head -= size;
  memcpy(input + head, bytes, size);
  position -= size;
}

static void AddToken(u64 index, bool front) {
  u64 *grown;
  if (end_count == end_allocated) {
    end_allocated = MAX(end_allocated * 2, 4);
    unassert((grown = (u64 *)realloc(ends, end_allocated * sizeof(*ends))));
    ends = grown;
  }
  if (front) {
    memmove(ends + 1, ends, end_count * sizeof(*ends));
    ends[0] = index;
  } else {
    ends[end_count] = index;
  }
  ++end_count;
}

/* ICRNL, INLCR and IGNCR, applied as bytes arrive, as n_tty applies them. */
static size_t ProcessInput(u8 *bytes, size_t size) {
  size_t i, n;
  u32 iflag = Read32(termios.iflag);
  if (!process_input || !(iflag & (ICRNL_LINUX | INLCR_LINUX | IGNCR_LINUX))) {
    return size;
  }
  for (n = i = 0; i < size; ++i) {
    if (bytes[i] == '\r') {
      if (iflag & IGNCR_LINUX) continue;
      if (iflag & ICRNL_LINUX) bytes[i] = '\n';
    } else if (bytes[i] == '\n' && (iflag & INLCR_LINUX)) {
      bytes[i] = '\r';
    }
    bytes[n++] = bytes[i];
  }
  return n;
}

void ProvideTerminalInput(const u8 *bytes, size_t size) {
  u8 *copy;
  if (!size) return;
  if (!process_input) {
    Append(bytes, size);
    return;
  }
  unassert((copy = (u8 *)malloc(size)));
  memcpy(copy, bytes, size);
  Append(copy, ProcessInput(copy, size));
  free(copy);
}

void ProvideTerminalEndOfInput(void) {
  AddToken(TailIndex(), false);
}

/* Forgets what no read took: a program that starts finds nothing typed for
 * the one before it. */
void ClearTerminalInput(void) {
  head = tail = 0;
  position = 0;
  end_count = 0;
  read_identity = 0;
  if (allocated > 65536) {
    free(input);
    input = 0;
    allocated = 0;
  }
}

/* The bytes a read could take, End of input tokens aside: what FIONREAD
 * reports. */
size_t CountTerminalInput(void) {
  return tail - head;
}

bool HasTerminalInput(void) {
  return head < tail || end_count;
}

u64 GetTerminalWaitSize(void) {
  return wait_size;
}

// --------------------------------------------------------------- the termios

/* What the program finds on the pinned guest's serial console, as agetty
 * leaves ttyS0 for root's shell (docs/research/x86-reference-guest.md):
 * canonical, echoing, Enter read as a line feed, Backspace erasing a whole
 * UTF-8 character (IUTF8), control characters echoed as themselves (no
 * ECHOCTL) and no IEXTEN; 9600 baud with HUPCL and CLOCAL, a speed reported
 * and never paced (ADR 0010 has no clock pacing), and Linux's control
 * characters. */
static void DefaultTermios(struct termios_linux *tio) {
  memset(tio, 0, sizeof(*tio));
  Write32(tio->iflag,
          ICRNL_LINUX | IXON_LINUX | IXOFF_LINUX | IMAXBEL_LINUX | IUTF8_LINUX);
  Write32(tio->oflag, OPOST_LINUX | ONLCR_LINUX);
  Write32(tio->cflag,
          B9600_LINUX | CS8_LINUX | CREAD_LINUX | HUPCL_LINUX | CLOCAL_LINUX);
  Write32(tio->lflag, ISIG_LINUX | ICANON_LINUX | ECHO_LINUX | ECHOE_LINUX |
                          ECHOK_LINUX | ECHOKE_LINUX);
  tio->cc[VINTR_LINUX] = 'C' - '@';
  tio->cc[VQUIT_LINUX] = '\\' - '@';
  tio->cc[VERASE_LINUX] = 0177;
  tio->cc[VKILL_LINUX] = 'U' - '@';
  tio->cc[VEOF_LINUX] = 'D' - '@';
  tio->cc[VTIME_LINUX] = 0;
  tio->cc[VMIN_LINUX] = 1;
  tio->cc[VSTART_LINUX] = 'Q' - '@';
  tio->cc[VSTOP_LINUX] = 'S' - '@';
  tio->cc[VSUSP_LINUX] = 'Z' - '@';
  tio->cc[VREPRINT_LINUX] = 'R' - '@';
  tio->cc[VDISCARD_LINUX] = 'O' - '@';
  tio->cc[VWERASE_LINUX] = 'W' - '@';
  tio->cc[VLNEXT_LINUX] = 'V' - '@';
}

static void KnowTermios(void) {
  if (!termios_known) {
    DefaultTermios(&termios);
    termios_known = true;
  }
}

/* The settings the host's line discipline follows, as TERMINAL_MODE_* bits. */
int GetTerminalMode(void) {
  int mode = 0;
  u32 iflag, oflag, lflag;
  KnowTermios();
  iflag = Read32(termios.iflag);
  oflag = Read32(termios.oflag);
  lflag = Read32(termios.lflag);
  if (lflag & ICANON_LINUX) mode |= TERMINAL_MODE_CANONICAL;
  if (lflag & ECHO_LINUX) mode |= TERMINAL_MODE_ECHO;
  if (lflag & ECHOCTL_LINUX) mode |= TERMINAL_MODE_ECHO_CONTROL;
  if (lflag & ISIG_LINUX) mode |= TERMINAL_MODE_SIGNALS;
  if (iflag & ICRNL_LINUX) mode |= TERMINAL_MODE_CR_TO_NL;
  if (oflag & OPOST_LINUX) mode |= TERMINAL_MODE_OUTPUT_PROCESSING;
  if (oflag & ONLCR_LINUX) mode |= TERMINAL_MODE_NL_TO_CR_NL;
  return mode;
}

/* Tells the host the mode, when it is not what the host last heard. */
static void ReportTerminalMode(void) {
  int mode = GetTerminalMode();
  if (mode == reported_mode) return;
  reported_mode = mode;
#ifdef __EMSCRIPTEN__
  NotifyTerminalModeHost(mode);
#endif
}

void GetTerminalTermios(struct termios_linux *tio) {
  KnowTermios();
  *tio = termios;
}

/* Stores what TCSETS was given, as Linux's tty does, and journals the change
 * for Undo, which puts the settings back. */
void SetTerminalTermios(const struct termios_linux *tio) {
  u8 change[2 * sizeof(termios)];
  KnowTermios();
  if (!memcmp(&termios, tio, sizeof(termios))) return;
  memcpy(change, &termios, sizeof(termios));
  memcpy(change + sizeof(termios), tio, sizeof(termios));
  DebugHistoryJournal(JOURNAL_TERMINAL_MODE, change, sizeof(change));
  termios = *tio;
  ReportTerminalMode();
}

/* Every program starts in canonical mode: raw mode ends with the program. */
void ResetTerminal(void) {
  DefaultTermios(&termios);
  termios_known = true;
  read_identity = 0;
  reported_mode = -1;  // the host hears it at every start
  ReportTerminalMode();
}

void SetTerminalProcessing(bool input, bool output) {
  process_input = input;
  process_output = output;
}

// ------------------------------------------------------------------- reading

static i64 TenthsAfter(i64 start, u8 tenths) {
  return start + (i64)tenths * 100000000;
}

/* The read state of the instruction running now, started afresh for one
 * that has not read before. */
static void BeginReadState(void) {
  u64 identity = blinkenlib_active_instruction();
  if (identity && identity == read_identity) return;
  read_identity = identity;
  read_waited = false;
  read_wait_tail = 0;
  read_began = false;
  read_seen = 0;
  read_seen_at = 0;
}

/* Halts for input: until the host gives the terminal some, with no
 * deadline, or until `deadline` in Program time as well. */
static bool HaltForInput(struct Machine *m, u64 size, bool timed,
                         i64 deadline) {
  if (GuestWaitInterruptedRestartable(m)) return true;
  if (!read_waited) {
    read_waited = true;
    read_wait_tail = TailIndex();
  }
  wait_size = size;
  if (timed) GuestWaitHaltTerminalRead(m, DeviceTimespec(deadline));
  HaltMachine(m, kMachineFakeTTYtrap);
}

/* Halts the machine, when the read of `size` bytes has to wait, so that the
 * host can provide input; the read starts over when it resumes. A read calls
 * this before it sets anything up, so the read that waited is still one
 * instruction to the history, finished when the input comes. Returns true
 * when the wait was interrupted, and the read fails with EINTR, and false
 * when the read goes on to take what is queued, which may be nothing. */
bool WaitForTerminalInput(struct Machine *m, u64 size, int oflags) {
  u64 available, need;
  u8 vmin, vtime;
  i64 now, deadline;
  read_returns_zero = false;
  if (!size || !m->fakettycanhalt) return false;
  KnowTermios();
  BeginReadState();
  // a token ends the read at once, with the bytes before it, or 0
  if (end_count) return false;
  available = tail - head;
  if (Read32(termios.lflag) & ICANON_LINUX) {
    if (available || (oflags & O_NONBLOCK)) return false;
    return HaltForInput(m, size, false, 0);
  }
  vmin = termios.cc[VMIN_LINUX];
  vtime = termios.cc[VTIME_LINUX];
  // n_tty_read(): with neither, a read is a poll that returns 0 on nothing,
  // O_NONBLOCK or not; with either, O_NONBLOCK answers EAGAIN on nothing
  if (!vmin && !vtime) {
    read_returns_zero = true;
    return false;
  }
  if (oflags & O_NONBLOCK) return false;
  if (!vmin) {
    // the first byte, or 0 once VTIME has passed since the read began
    if (available) return false;
    now = DeviceNow();
    if (!read_began) {
      read_began = true;
      read_began_at = now;
    }
    deadline = TenthsAfter(read_began_at, vtime);
    if (now >= deadline) {
      read_returns_zero = true;
      return false;
    }
    return HaltForInput(m, size, true, deadline);
  }
  need = MIN(vmin, size);
  if (available >= need) return false;
  // the first byte is waited for whatever VTIME says
  if (!available || !vtime) return HaltForInput(m, size, false, 0);
  // then VTIME runs from the last byte that came
  now = DeviceNow();
  if (available != read_seen) {
    read_seen = available;
    read_seen_at = now;
  }
  deadline = TenthsAfter(read_seen_at, vtime);
  if (now >= deadline) return false;
  return HaltForInput(m, size, true, deadline);
}

/* The one place a program consumes the terminal's input: `size` bytes, or
 * the End of input token at the head for a size of 0. The journal says what
 * Undo puts back: what the read found queued before it waited, when it did,
 * and all of it when it did not; and how much of what arrived while it
 * waited it left queued, which Undo takes away. */
static void TakeTerminalInput(size_t size) {
  u8 *record;
  bool waited;
  size_t putback;
  u64 start, end, rest_from, drop;
  BeginReadState();
  waited = read_waited;
  start = position;
  end = position + size;
  if (waited) {
    putback = read_wait_tail > start ? MIN(read_wait_tail - start, size) : 0;
    rest_from = MAX(end, read_wait_tail);
    drop = TailIndex() > rest_from ? TailIndex() - rest_from : 0;
  } else {
    putback = size;
    drop = 0;
  }
  unassert((record = (u8 *)malloc(16 + putback)));
  Write32(record + 0, (!size ? TERMINAL_READ_END_OF_INPUT : 0) |
                          (waited ? TERMINAL_READ_WAITED : 0));
  Write32(record + 4, size);
  Write32(record + 8, drop);
  Write32(record + 12, putback);
  memcpy(record + 16, input + head, putback);
  DebugHistoryJournal(JOURNAL_TERMINAL_READ, record, 16 + putback);
  free(record);
  if (!size) {
    memmove(ends, ends + 1, --end_count * sizeof(*ends));
    return;
  }
  head += size;
  position += size;
  if (head == tail) head = tail = 0;
}

static ssize_t ReadTerminal(int fildes, const struct iovec *iov, int iovcnt) {
  int i;
  bool canonical;
  u8 *newline;
  size_t size, limit, copied;
  KnowTermios();
  if (end_count && ends[0] == position) {
    TakeTerminalInput(0);
    return 0;
  }
  if (head == tail) {
    if (read_returns_zero) {
      read_returns_zero = false;
      return 0;
    }
    return eagain();
  }
  read_returns_zero = false;
  canonical = Read32(termios.lflag) & ICANON_LINUX;
  limit = AvailableTerminalInput();
  for (copied = i = 0; i < iovcnt && copied < limit; ++i) {
    size = MIN(iov[i].iov_len, limit - copied);
    newline = 0;
    if (canonical &&
        (newline = (u8 *)memchr(input + head + copied, '\n', size))) {
      size = newline - (input + head + copied) + 1;
    }
    memcpy(iov[i].iov_base, input + head + copied, size);
    copied += size;
    if (newline) break;
  }
  if (copied) TakeTerminalInput(copied);
  return copied;
}

/* Discards the input no read took, as TCFLSH and TCSETSF do, and journals
 * it, End of input tokens included, for Undo to put back. */
void FlushTerminalInput(void) {
  u8 *record;
  size_t i, bytes;
  if (!HasTerminalInput()) return;
  bytes = tail - head;
  unassert((record = (u8 *)malloc(8 + bytes + 4 * end_count)));
  Write32(record + 0, bytes);
  Write32(record + 4, end_count);
  memcpy(record + 8, input + head, bytes);
  for (i = 0; i < end_count; ++i) {
    Write32(record + 8 + bytes + 4 * i, ends[i] - position);
  }
  DebugHistoryJournal(JOURNAL_TERMINAL_FLUSH, record, 8 + bytes + 4 * end_count);
  free(record);
  position += bytes;
  head = tail = 0;
  end_count = 0;
}

/* Takes back what a journal record of this file says an undone instruction
 * did to the terminal. */
void UndoTerminalJournal(u32 kind, const u8 *p, u32 size) {
  u32 i, n, flags, drop, putback, bytes, tokens;
  switch (kind) {
    case JOURNAL_TERMINAL_READ:
      flags = Read32(p);
      drop = Read32(p + 8);
      putback = Read32(p + 12);
      // the rest of what the read waited for goes with it
      n = MIN(drop, AvailableTerminalInput());
      head += n;
      position += n;
      if (head == tail) head = tail = 0;
      Prepend(p + 16, putback);
      if ((flags & TERMINAL_READ_END_OF_INPUT) &&
          !(flags & TERMINAL_READ_WAITED)) {
        AddToken(position, true);
      }
      break;
    case JOURNAL_TERMINAL_FLUSH:
      bytes = Read32(p);
      tokens = Read32(p + 4);
      Prepend(p + 8, bytes);
      for (i = tokens; i > 0; --i) {
        AddToken(position + Read32(p + 8 + bytes + 4 * (i - 1)), true);
      }
      break;
    case JOURNAL_TERMINAL_MODE:
      memcpy(&termios, p, sizeof(termios));
      termios_known = true;
      ReportTerminalMode();
      break;
    default:
      break;
  }
}

/* A signal the host's line discipline raised under ISIG: Ctrl+C or Ctrl+\
 * typed in the Terminal. As n_tty's isig() does, it discards the input no
 * read took, unless NOFLSH; neither is journaled, since a signal from outside
 * is an Undo barrier anyway (see EnqueueSignal()). */
void SendTerminalSignal(struct Machine *m, int sig) {
  KnowTermios();
  if (!(Read32(termios.lflag) & NOFLSH_LINUX)) {
    if (HasTerminalInput()) position += tail - head;
    head = tail = 0;
    end_count = 0;
  }
  EnqueueSignal(m, sig);
}

// ------------------------------------------------------------------- writing

/* OPOST's ONLCR and OCRNL, when the host processes output: a new buffer the
 * caller frees, or null when nothing changes. */
static u8 *ProcessOutput(const u8 *bytes, size_t size, size_t *processed) {
  u8 *out;
  size_t i, n, lines;
  u32 oflag = Read32(termios.oflag);
  if (!process_output || !(oflag & OPOST_LINUX) ||
      !(oflag & (ONLCR_LINUX | OCRNL_LINUX))) {
    return 0;
  }
  for (lines = i = 0; i < size; ++i) {
    if (bytes[i] == '\n' || bytes[i] == '\r') ++lines;
  }
  if (!lines) return 0;
  unassert((out = (u8 *)malloc(size + lines)));
  for (n = i = 0; i < size; ++i) {
    if (bytes[i] == '\n' && (oflag & ONLCR_LINUX)) {
      out[n++] = '\r';
      out[n++] = '\n';
    } else if (bytes[i] == '\r' && (oflag & OCRNL_LINUX)) {
      out[n++] = '\n';
    } else {
      out[n++] = bytes[i];
    }
  }
  *processed = n;
  return out;
}

static ssize_t WriteTerminal(int channel, const struct iovec *iov, int iovcnt) {
  int i, parts;
  u8 *gathered, *processed;
  size_t size, offset, processed_size;
  const u8 *bytes = 0;
  for (size = parts = i = 0; i < iovcnt; ++i) {
    if (!iov[i].iov_len) continue;
    if (iov[i].iov_len > SSIZE_MAX - size) return einval();
    bytes = (const u8 *)iov[i].iov_base;
    size += iov[i].iov_len;
    ++parts;
  }
  if (!size || !terminal_output_callback) return size;
  KnowTermios();
  gathered = 0;
  if (parts > 1) {
    if (!(gathered = (u8 *)malloc(size))) return enomem();
    for (offset = i = 0; i < iovcnt; ++i) {
      if (!iov[i].iov_len) continue;
      memcpy(gathered + offset, iov[i].iov_base, iov[i].iov_len);
      offset += iov[i].iov_len;
    }
    bytes = gathered;
  }
  if ((processed = ProcessOutput(bytes, size, &processed_size))) {
    terminal_output_callback(channel, processed, processed_size);
    free(processed);
  } else {
    terminal_output_callback(channel, bytes, size);
  }
  free(gathered);
  return size;
}

static ssize_t WriteTerminalOutput(int fildes, const struct iovec *iov,
                                   int iovcnt) {
  return WriteTerminal(TERMINAL_STDOUT, iov, iovcnt);
}

static ssize_t WriteTerminalError(int fildes, const struct iovec *iov,
                                  int iovcnt) {
  return WriteTerminal(TERMINAL_STDERR, iov, iovcnt);
}

/* Output is ready immediately. Input is ready when a read can take queued
 * bytes or an End of input token: in non-canonical mode with VMIN and no
 * VTIME, when VMIN bytes are queued, as n_tty's poll asks. An empty poll
 * waits for the host. */
static int PollTerminal(struct pollfd *fds, nfds_t nfds, int timeout) {
  int ready;
  nfds_t i;
  bool readable;
  size_t need = 1;
  KnowTermios();
  if (!(Read32(termios.lflag) & ICANON_LINUX) && !termios.cc[VTIME_LINUX] &&
      termios.cc[VMIN_LINUX]) {
    need = termios.cc[VMIN_LINUX];
  }
  readable = end_count || tail - head >= need;
  for (ready = i = 0; i < nfds; ++i) {
    fds[i].revents = (fds[i].events & POLLOUT) |
                     (readable ? (fds[i].events & POLLIN) : 0);
    if (fds[i].revents) ++ready;
  }
  return ready;
}

static int CloseTerminal(int fildes) {
  return VfsClose(fildes);
}

/* The termios, through the host's structure; SysIoctl() reads and writes the
 * terminal's in Linux's own (see GetTerminalTermios()). */
static int GetTerminalAttributes(int fildes, struct termios *tio) {
  KnowTermios();
  XlatLinuxToTermios(tio, &termios);
  return 0;
}

static int SetTerminalAttributes(int fildes, int action,
                                 const struct termios *tio) {
  struct termios_linux gtio;
  XlatTermiosToLinux(&gtio, tio);
  SetTerminalTermios(&gtio);
  return 0;
}

/* The classic 80 by 24: the host's terminal has no fixed grid. */
static int GetTerminalSize(int fildes, struct winsize *ws) {
  memset(ws, 0, sizeof(*ws));
  ws->ws_row = 24;
  ws->ws_col = 80;
  return 0;
}

static int SetTerminalSize(int fildes, const struct winsize *ws) {
  return 0;
}

const struct FdCb kFdCbTerminal = {
    .close = CloseTerminal,
    .readv = ReadTerminal,
    .writev = WriteTerminalOutput,
    .poll = PollTerminal,
    .tcgetattr = GetTerminalAttributes,
    .tcsetattr = SetTerminalAttributes,
    .tcgetwinsize = GetTerminalSize,
    .tcsetwinsize = SetTerminalSize,
};

const struct FdCb kFdCbTerminalError = {
    .close = CloseTerminal,
    .readv = ReadTerminal,
    .writev = WriteTerminalError,
    .poll = PollTerminal,
    .tcgetattr = GetTerminalAttributes,
    .tcsetattr = SetTerminalAttributes,
    .tcgetwinsize = GetTerminalSize,
    .tcsetwinsize = SetTerminalSize,
};

bool IsTerminalFd(const struct Fd *fd) {
  return fd->cb == &kFdCbTerminal || fd->cb == &kFdCbTerminalError;
}

static void LearnTerminalDevices(void) {
  int i;
  struct stat st;
  static const char *const kDevices[] = {"/dev/tty", "/dev/stdin",
                                         "/dev/stdout", "/dev/stderr", "/dev/urandom", "/dev/random"};
  for (i = 0; i < ARRAYLEN(kDevices); ++i) {
    if (!VfsStat(AT_FDCWD, kDevices[i], &st, 0) && S_ISCHR(st.st_mode)) {
      devices[i] = st.st_rdev;
    } else {
      devices[i] = (dev_t)-1;
    }
  }
  devices_known = true;
}

/* The callbacks for a host descriptor a program opened by path, when it is a
 * device the terminal stands for: /dev/tty, the controlling terminal, and
 * /dev/stdin, /dev/stdout and /dev/stderr, which Linux leads to the terminal
 * through /proc/self/fd. Null for anything else. */
const struct FdCb *GetTerminalDeviceCb(int hostfd) {
  int i;
  struct stat st;
  if (!devices_known || VfsFstat(hostfd, &st) == -1 || !S_ISCHR(st.st_mode)) {
    return 0;
  }
  if (st.st_rdev == devices[4] || st.st_rdev == devices[5]) return &kFdCbRandom;
  if (st.st_rdev == devices[3]) return &kFdCbTerminalError;
  for (i = 0; i < 3; ++i) {
    if (st.st_rdev == devices[i]) return &kFdCbTerminal;
  }
  return 0;
}

/* Whether the host descriptor is one of /dev/ttyS0, which the program's
 * standard streams are on the guest, so that fstat() and ttyname() find that
 * node for them. */
static bool IsSerialHostFd(int hostfd, dev_t serial) {
  struct stat st;
  return serial != (dev_t)-1 && !VfsFstat(hostfd, &st) &&
         S_ISCHR(st.st_mode) && st.st_rdev == serial;
}

/* Gives descriptors 0 to 2 a host descriptor each again where the last
 * program closed one, before the next program loads and opens anything: one
 * of /dev/ttyS0, the serial line root's shell left them on, or, without
 * that node, of the host's own standard streams. */
void OpenTerminalHostFds(void) {
  int fildes, hostfd;
  dev_t serial;
  struct stat st;
  static const char *const kPlaceholders[] = {"/dev/stdin", "/dev/stdout",
                                              "/dev/stderr"};
  if (!devices_known) LearnTerminalDevices();
  serial = !VfsStat(AT_FDCWD, "/dev/ttyS0", &st, 0) && S_ISCHR(st.st_mode)
               ? st.st_rdev
               : (dev_t)-1;
  for (fildes = 0; fildes < 3; ++fildes) {
    if (VfsFcntl(fildes, F_GETFD) != -1) {
      if (serial == (dev_t)-1 || IsSerialHostFd(fildes, serial)) continue;
      // the host's own stream, as the module started: the serial line's
      unassert(!VfsClose(fildes));
    }
    if ((serial == (dev_t)-1 ||
         (hostfd = VfsOpen(AT_FDCWD, "/dev/ttyS0", O_RDWR, 0)) == -1) &&
        (hostfd = VfsOpen(AT_FDCWD, kPlaceholders[fildes],
                          fildes ? O_WRONLY : O_RDONLY, 0)) == -1 &&
        (hostfd = VfsOpen(AT_FDCWD, "/dev/null", O_RDWR, 0)) == -1) {
      unassert((hostfd = VfsOpen(AT_FDCWD, "/", O_RDONLY | O_DIRECTORY, 0)) !=
               -1);
    }
    if (hostfd != fildes) {
      unassert(VfsDup2(hostfd, fildes) == fildes);
      unassert(!VfsClose(hostfd));
    }
  }
}

/* The program's descriptors 0 to 2, the terminal open for reading and
 * writing, over the host descriptors OpenTerminalHostFds() made sure of. */
void AddTerminalFds(struct Fds *fds) {
  int fildes;
  struct Fd *fd;
  for (fildes = 0; fildes < 3; ++fildes) {
    unassert((fd = AddFd(fds, fildes, O_RDWR)));
    fd->cb = fildes == 2 ? &kFdCbTerminalError : &kFdCbTerminal;
  }
}

static ssize_t ReadRandom(int fd, const struct iovec *iov, int n) {
  ssize_t total = 0, rc;
  for (int i = 0; i < n; ++i) {
    rc = GetRandom(iov[i].iov_base, iov[i].iov_len, 0);
    if (rc < 0) return total ? total : rc;
    total += rc;
    if (rc != iov[i].iov_len) break;
  }
  return total;
}
static int PollRandom(struct pollfd *fds, nfds_t count, int timeout) {
  int ready = 0;
  for (nfds_t i = 0; i < count; ++i) {
    fds[i].revents = fds[i].events & (POLLIN | POLLOUT);
    if (fds[i].revents) ++ready;
  }
  return ready;
}
static ssize_t WriteRandom(int fd, const struct iovec *iov, int n) {
  ssize_t size = 0;
  for (int i = 0; i < n; ++i) size += iov[i].iov_len;
  return size;
}
static int NotTerminalGet(int fd, struct termios *tio) { return enotty(); }
static int NotTerminalSet(int fd, int action, const struct termios *tio) { return enotty(); }
static int NotTerminalSize(int fd, struct winsize *ws) { return enotty(); }
static int NotTerminalSetSize(int fd, const struct winsize *ws) { return enotty(); }
const struct FdCb kFdCbRandom = { .close = CloseTerminal, .readv = ReadRandom,
  .writev = WriteRandom, .poll = PollRandom, .tcgetattr = NotTerminalGet,
  .tcsetattr = NotTerminalSet, .tcgetwinsize = NotTerminalSize, .tcsetwinsize = NotTerminalSetSize };
