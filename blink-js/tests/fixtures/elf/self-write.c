#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  (void)argc;
  errno = 0;
  int fd = open(argv[0], O_WRONLY);
  printf("open=%d errno=%d\n", fd, errno);
  if (fd >= 0) close(fd);
  errno = 0;
  int result = unlink(argv[0]);
  printf("unlink=%d errno=%d\n", result, errno);
  errno = 0;
  result = rename(argv[0], "renamed");
  printf("rename=%d errno=%d\n", result, errno);
  return 0;
}
