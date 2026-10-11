#include <errno.h>
#include <stdio.h>
#include <sys/ptrace.h>
int main(void) {
  for (int i = 0; i < 2; ++i) {
    errno = 0;
    long result = ptrace(PTRACE_TRACEME, 0, 0, 0);
    printf("ptrace=%ld errno=%d\n", result, errno);
  }
  return 0;
}
