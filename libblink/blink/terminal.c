/* The terminal a program's standard streams refer to, as a Linux process
 * started from a shell on a tty has them: descriptors 0, 1 and 2 are one
 * terminal, open for reading and writing, which isatty() recognises because
 * it answers TCGETS and TIOCGWINSZ. Nothing goes through Emscripten's file
 * system. Each descriptor keeps a host descriptor of the same number only so
 * that the host hands out the numbers Linux would: 3 for the first open(), 1
 * for an open() after close(1).
 *
 * Input. The host gives the terminal what its line discipline releases (a
 * line ended with Enter, a paste) as bytes, and End of input for Ctrl+D on an
 * empty line. Both queue here, in the order they came. A read takes bytes as
 * a canonical-mode read on Linux does: at most the bytes it asked for and
 * never past the end of a line, so the rest waits for the next read. A read
 * that finds an End of input token first returns 0 and takes the token, so
 * each token ends one read. Only a read that finds nothing at all waits: the
 * machine halts with kMachineFakeTTYtrap before the read has set anything up
 * or recorded anything, the host provides input, and the system call starts
 * over.
 *
 * Output. Every write reaches the host as one call of its own, with the bytes
 * it wrote, on the channel of the descriptor it went through, so the host
 * sees standard output and standard error in the order the program wrote
 * them. */
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
#include "blink/errno.h"
#include "blink/macros.h"
#include "blink/vfs.h"
#include "blink/random.h"
#include "blink/environment.h"
#include "blink/debughistory.h"

void (*terminal_output_callback)(int, const u8 *, u32) = 0;

/* The bytes no read has taken yet are input[head..tail). `position` counts
 * the bytes taken before input[head] since the input was last cleared, and
 * each End of input token is kept as the position it comes at. */
static u8 *input;
static size_t head, tail, allocated;
static u64 position;
static u64 *ends;
static size_t end_count, end_allocated;
/* The size of the read that last waited for input. */
static u64 wait_size;

/* The device numbers of /dev/tty, /dev/stdin, /dev/stdout and /dev/stderr,
 * learned before any program could remove them. */
static dev_t devices[6];
static bool devices_known;

void ProvideTerminalInput(const u8 *bytes, size_t size) {
  size_t want;
  u8 *grown;
  if (!size) return;
  if (size > allocated - tail) {
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
  memcpy(input + tail, bytes, size);
  tail += size;
}

void ProvideTerminalEndOfInput(void) {
  u64 *grown;
  if (end_count == end_allocated) {
    end_allocated = MAX(end_allocated * 2, 4);
    unassert((grown = (u64 *)realloc(ends, end_allocated * sizeof(*ends))));
    ends = grown;
  }
  ends[end_count++] = position + (tail - head);
}

/* Forgets what no read took: a program that starts finds nothing typed for
 * the one before it. */
void ClearTerminalInput(void) {
  head = tail = 0;
  position = 0;
  end_count = 0;
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

/* Halts the machine, unless the terminal has input or `size` is 0, so that
 * the host can provide some; the read starts over when it resumes. A read
 * calls this before it sets anything up, so the read that waited is still
 * one instruction to the history, finished when the input comes. */
bool WaitForTerminalInput(struct Machine *m, u64 size) {
  if (!size || head < tail || end_count || !m->fakettycanhalt) return false;
  if (GuestWaitInterruptedRestartable(m)) return true;
  wait_size = size;
  HaltMachine(m, kMachineFakeTTYtrap);
}

/* The one place a program consumes the terminal's input: `size` bytes, or
 * the End of input token at the head for a size of 0. Undo puts back the
 * memory and registers a read changed, not what it took from here: an undone
 * read leaves its input taken, and the read run again gets the input after
 * it, or waits for more. This is where an instruction that consumes input can
 * be recorded as irreversible, so that undo stops before it. */
static void TakeTerminalInput(size_t size) {
  DebugHistoryMarkIrreversible();
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
  u8 *newline;
  size_t size, limit, copied;
  if (end_count && ends[0] == position) {
    TakeTerminalInput(0);
    return 0;
  }
  if (head == tail) return eagain();
  limit = tail - head;
  if (end_count) limit = MIN(limit, ends[0] - position);
  for (copied = i = 0; i < iovcnt && copied < limit; ++i) {
    size = MIN(iov[i].iov_len, limit - copied);
    if ((newline = (u8 *)memchr(input + head + copied, '\n', size))) {
      size = newline - (input + head + copied) + 1;
    }
    memcpy(iov[i].iov_base, input + head + copied, size);
    copied += size;
    if (newline) break;
  }
  if (copied) TakeTerminalInput(copied);
  return copied;
}

static ssize_t WriteTerminal(int channel, const struct iovec *iov, int iovcnt) {
  int i, parts;
  u8 *gathered;
  size_t size, offset;
  const u8 *bytes = 0;
  for (size = parts = i = 0; i < iovcnt; ++i) {
    if (!iov[i].iov_len) continue;
    if (iov[i].iov_len > SSIZE_MAX - size) return einval();
    bytes = (const u8 *)iov[i].iov_base;
    size += iov[i].iov_len;
    ++parts;
  }
  if (!size || !terminal_output_callback) return size;
  if (parts == 1) {
    terminal_output_callback(channel, bytes, size);
    return size;
  }
  if (!(gathered = (u8 *)malloc(size))) return enomem();
  for (offset = i = 0; i < iovcnt; ++i) {
    if (!iov[i].iov_len) continue;
    memcpy(gathered + offset, iov[i].iov_base, iov[i].iov_len);
    offset += iov[i].iov_len;
  }
  terminal_output_callback(channel, gathered, size);
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

/* Output is ready immediately. Input is ready only when a read can consume
 * queued bytes or an End of input token; empty polls suspend asynchronously. */
static int PollTerminal(struct pollfd *fds, nfds_t nfds, int timeout) {
  int ready;
  nfds_t i;
  for (ready = i = 0; i < nfds; ++i) {
    fds[i].revents = (fds[i].events & POLLOUT) |
                     ((head < tail || end_count) ? (fds[i].events & POLLIN) : 0);
    if (fds[i].revents) ++ready;
  }
  return ready;
}

static int CloseTerminal(int fildes) {
  return VfsClose(fildes);
}

/* What a pseudo-terminal a terminal emulator opens reports, which is how the
 * host's line discipline behaves: canonical, echoing, Enter read as a line
 * feed, Backspace erasing a whole UTF-8 character (IUTF8), and Linux's
 * control characters. */
static int GetTerminalAttributes(int fildes, struct termios *tio) {
  memset(tio, 0, sizeof(*tio));
  tio->c_iflag = ICRNL | IXON;
#ifdef IUTF8
  tio->c_iflag |= IUTF8;
#endif
  tio->c_oflag = OPOST | ONLCR;
  tio->c_cflag = CS8 | CREAD;
  tio->c_lflag = ISIG | ICANON | ECHO | ECHOE | ECHOK | IEXTEN;
#ifdef ECHOCTL
  tio->c_lflag |= ECHOCTL;
#endif
#ifdef ECHOKE
  tio->c_lflag |= ECHOKE;
#endif
  tio->c_cc[VINTR] = 'C' - '@';
  tio->c_cc[VQUIT] = '\\' - '@';
  tio->c_cc[VERASE] = 0177;
  tio->c_cc[VKILL] = 'U' - '@';
  tio->c_cc[VEOF] = 'D' - '@';
  tio->c_cc[VTIME] = 0;
  tio->c_cc[VMIN] = 1;
  tio->c_cc[VSTART] = 'Q' - '@';
  tio->c_cc[VSTOP] = 'S' - '@';
  tio->c_cc[VSUSP] = 'Z' - '@';
  tio->c_cc[VEOL] = 0;
#ifdef VREPRINT
  tio->c_cc[VREPRINT] = 'R' - '@';
#endif
#ifdef VDISCARD
  tio->c_cc[VDISCARD] = 'O' - '@';
#endif
#ifdef VWERASE
  tio->c_cc[VWERASE] = 'W' - '@';
#endif
#ifdef VLNEXT
  tio->c_cc[VLNEXT] = 'V' - '@';
#endif
  unassert(!cfsetispeed(tio, B38400));
  unassert(!cfsetospeed(tio, B38400));
  return 0;
}

/* Accepted and ignored, as the host's line discipline does not change. */
static int SetTerminalAttributes(int fildes, int action,
                                 const struct termios *tio) {
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

/* Gives descriptors 0 to 2 a host descriptor each again where the last
 * program closed one, before the next program loads and opens anything. */
void OpenTerminalHostFds(void) {
  int fildes, hostfd;
  static const char *const kPlaceholders[] = {"/dev/stdin", "/dev/stdout",
                                              "/dev/stderr"};
  if (!devices_known) LearnTerminalDevices();
  for (fildes = 0; fildes < 3; ++fildes) {
    if (VfsFcntl(fildes, F_GETFD) != -1) continue;
    if ((hostfd = VfsOpen(AT_FDCWD, kPlaceholders[fildes],
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
