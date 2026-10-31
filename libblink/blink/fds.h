#ifndef BLINK_FDS_H_
#define BLINK_FDS_H_
#include <dirent.h>
#include <limits.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdbool.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <termios.h>

#include "blink/dll.h"
#include "blink/thread.h"
#include "blink/types.h"

#define FD_CONTAINER(e) DLL_CONTAINER(struct Fd, elem, e)

struct winsize;
struct Machine;
struct DeviceFile;

struct FdCb {
  int (*close)(int);
  ssize_t (*readv)(int, const struct iovec *, int);
  ssize_t (*writev)(int, const struct iovec *, int);
  int (*poll)(struct pollfd *, nfds_t, int);
  int (*tcgetattr)(int, struct termios *);
  int (*tcsetattr)(int, int, const struct termios *);
  int (*tcgetwinsize)(int, struct winsize *);
  int (*tcsetwinsize)(int, const struct winsize *);
  // A device's own ioctl requests, which SysIoctl() hands it after the ones
  // every descriptor answers; null for everything that is not a device.
  int (*ioctl)(struct Machine *, int, u64, i64);
};

struct Fd {
  int fildes;      // file descriptor
  int oflags;      // host O_XXX constants
  int socktype;    // host SOCK_XXX constants
  bool norestart;  // is SO_RCVTIMEO in play?
  DIR *dirstream;  // for getdents() lazilly
  struct Dll elem;
  pthread_mutex_t_ lock;
  const struct FdCb *cb;
  // The open file description of a device, which a dup() of the descriptor
  // shares and the last of them releases (see devices.c); null otherwise.
  struct DeviceFile *device;
  char *path;
  union {
    struct sockaddr sa;
    struct sockaddr_in sin;
    struct sockaddr_in6 sin6;
  } saddr;
};

struct Fds {
  struct Dll *list;
  pthread_mutex_t_ lock;
};

extern const struct FdCb kFdCbHost;

void InitFds(struct Fds *);
struct Fd *AddFd(struct Fds *, int, int);
struct Fd *ForkFd(struct Fds *, struct Fd *, int, int);
struct Fd *GetFd(struct Fds *, int);
void LockFd(struct Fd *);
void UnlockFd(struct Fd *);
int CountFds(struct Fds *);
void FreeFd(struct Fd *);
void DestroyFds(struct Fds *);
void InheritFd(struct Fd *);

#endif /* BLINK_FDS_H_ */
