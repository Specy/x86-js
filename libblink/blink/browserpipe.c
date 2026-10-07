/* A bounded, in-process byte pipe; host descriptors reserve Linux fd numbers.
 * Duplicates share both the byte queue and endpoint lifetime. */
#include "blink/browserpipe.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>

#include "blink/assert.h"
#include "blink/debughistory.h"
#include "blink/environment.h"
#include "blink/errno.h"
#include "blink/macros.h"
#include "blink/syscall.h"
#include "blink/timespec.h"
#include "blink/vfs.h"

#define PIPE_CAPACITY 65536
#define PIPE_ATOMIC 4096

struct BytePipe {
  size_t head, size;
  u64 inode;
  unsigned readers, writers;
  int readflags, writeflags;
  u8 bytes[PIPE_CAPACITY];
};
struct PipeEnd {
  int fd;
  bool write;
  struct BytePipe *pipe;
  struct PipeEnd *next;
};
static struct PipeEnd *ends;
static u64 inode_allocator;

static struct PipeEnd *Find(int fd) {
  for (struct PipeEnd *e = ends; e; e = e->next) {
    if (e->fd == fd) return e;
  }
  return 0;
}

bool IsBrowserPipe(int fd) {
  return Find(fd) != 0;
}

size_t BrowserPipeCount(int fd) {
  struct PipeEnd *e = Find(fd);
  return e ? e->pipe->size : 0;
}

size_t BrowserPipeSpace(int fd) {
  struct PipeEnd *e = Find(fd);
  return e ? PIPE_CAPACITY - e->pipe->size : 0;
}

static void Add(int fd, bool write, struct BytePipe *pipe) {
  struct PipeEnd *e = calloc(1, sizeof(*e));
  unassert(e);
  e->fd = fd;
  e->write = write;
  e->pipe = pipe;
  e->next = ends;
  ends = e;
  if (write) ++pipe->writers;
  else ++pipe->readers;
}

void BrowserPipeDup(int oldfd, int newfd) {
  struct PipeEnd *e = Find(oldfd);
  if (e) Add(newfd, e->write, e->pipe);
}

void BrowserPipeStat(int fd, struct stat *st) {
  struct PipeEnd *e = Find(fd);
  if (!e) return;
  memset(st, 0, sizeof(*st));
  st->st_mode = S_IFIFO | 0600;
  st->st_ino = e->pipe->inode;
  st->st_nlink = 1;
  st->st_blksize = PIPE_ATOMIC;
}

int BrowserPipeFlags(int fd, int flags) {
  struct PipeEnd *e = Find(fd);
  if (!e) return flags;
  return (flags & O_CLOEXEC) |
         (e->write ? O_WRONLY | e->pipe->writeflags
                   : O_RDONLY | e->pipe->readflags);
}

void BrowserPipeSetFlags(int fd, int flags) {
  struct PipeEnd *e = Find(fd);
  if (!e) return;
  if (e->write) e->pipe->writeflags = flags & ~(O_ACCMODE | O_CLOEXEC);
  else e->pipe->readflags = flags & ~(O_ACCMODE | O_CLOEXEC);
}

int BrowserPipe(int *fds, int flags) {
  struct BytePipe *p = calloc(1, sizeof(*p));
  if (!p) return enomem();
  fds[0] = VfsOpen(AT_FDCWD, "/dev/null", O_RDWR | (flags & O_CLOEXEC), 0);
  if (fds[0] < 0) {
    free(p);
    return -1;
  }
  fds[1] = VfsOpen(AT_FDCWD, "/dev/null", O_RDWR | (flags & O_CLOEXEC), 0);
  if (fds[1] < 0) {
    VfsClose(fds[0]);
    free(p);
    return -1;
  }
  p->inode = ++inode_allocator;
  p->readflags = p->writeflags = flags & O_NONBLOCK;
  Add(fds[0], false, p);
  Add(fds[1], true, p);
  return 0;
}

void BrowserPipeForget(int fd) {
  struct PipeEnd **link = &ends;
  while (*link && (*link)->fd != fd) link = &(*link)->next;
  if (*link) {
    struct PipeEnd *e = *link;
    struct BytePipe *p = e->pipe;
    *link = e->next;
    if (e->write) --p->writers;
    else --p->readers;
    free(e);
    if (!p->readers && !p->writers) free(p);
  }
}

static int Close(int fd) {
  BrowserPipeForget(fd);
  return VfsClose(fd);
}

static ssize_t Read(int fd, const struct iovec *iov, int count) {
  struct PipeEnd *e = Find(fd);
  if (!e || e->write) return ebadf();
  struct BytePipe *p = e->pipe;
  if (!p->size) return p->writers ? eagain() : 0;
  size_t done = 0;
  for (int i = 0; i < count && p->size; ++i) {
    size_t n = MIN(iov[i].iov_len, p->size);
    for (size_t j = 0; j < n; ++j) {
      ((u8 *)iov[i].iov_base)[j] = p->bytes[(p->head + j) % PIPE_CAPACITY];
    }
    p->head = (p->head + n) % PIPE_CAPACITY;
    p->size -= n;
    done += n;
  }
  if (done) DebugHistoryMarkIrreversible();
  return done;
}

static ssize_t Write(int fd, const struct iovec *iov, int count) {
  struct PipeEnd *e = Find(fd);
  if (!e || !e->write) return ebadf();
  struct BytePipe *p = e->pipe;
  if (!p->readers) {
    errno = EPIPE;
    return -1;
  }
  size_t size = 0, done = 0;
  for (int i = 0; i < count; ++i) size += iov[i].iov_len;
  if (!size) return 0;
  size_t space = PIPE_CAPACITY - p->size;
  if (!space || (size <= PIPE_ATOMIC && size > space)) return eagain();
  for (int i = 0; i < count && p->size < PIPE_CAPACITY; ++i) {
    size_t n = MIN(iov[i].iov_len, PIPE_CAPACITY - p->size);
    for (size_t j = 0; j < n; ++j) {
      p->bytes[(p->head + p->size + j) % PIPE_CAPACITY] =
          ((u8 *)iov[i].iov_base)[j];
    }
    p->size += n;
    done += n;
  }
  if (done) DebugHistoryMarkIrreversible();
  return done;
}

static int Poll(struct pollfd *fds, nfds_t count, int timeout) {
  int ready = 0;
  for (nfds_t i = 0; i < count; ++i) {
    struct PipeEnd *e = Find(fds[i].fd);
    fds[i].revents = 0;
    if (!e) {
      fds[i].revents = POLLNVAL;
    } else if (e->write) {
      if (!e->pipe->readers) fds[i].revents |= POLLERR;
      if (e->pipe->size < PIPE_CAPACITY) fds[i].revents |= fds[i].events & POLLOUT;
    } else {
      if (!e->pipe->writers) fds[i].revents |= POLLHUP;
      if (e->pipe->size) fds[i].revents |= fds[i].events & POLLIN;
    }
    if (fds[i].revents) ++ready;
  }
  return ready;
}

int WaitForBrowserPipe(struct Machine *m, int fd, bool write, u64 size,
                       int flags) {
  struct PipeEnd *e = Find(fd);
  if (!e || !size || (flags & O_NONBLOCK)) return 0;
  size_t space = PIPE_CAPACITY - e->pipe->size;
  bool block = write ? e->pipe->readers &&
                           (size <= PIPE_ATOMIC ? size > space : !space)
                     : !e->pipe->size && e->pipe->writers;
  if (!block) return 0;
  if (GuestWaitInterruptedRestartable(m)) return eintr();
  GuestWaitHalt(m, GetMaxTime(), false);
}

static int NotTerminalGet(int fd, struct termios *tio) { return enotty(); }
static int NotTerminalSet(int fd, int action, const struct termios *tio) {
  return enotty();
}
static int NotTerminalSize(int fd, struct winsize *ws) { return enotty(); }
static int NotTerminalSetSize(int fd, const struct winsize *ws) {
  return enotty();
}
const struct FdCb kFdCbBrowserPipe = {
    .close = Close,
    .readv = Read,
    .writev = Write,
    .poll = Poll,
    .tcgetattr = NotTerminalGet,
    .tcsetattr = NotTerminalSet,
    .tcgetwinsize = NotTerminalSize,
    .tcsetwinsize = NotTerminalSetSize,
};
