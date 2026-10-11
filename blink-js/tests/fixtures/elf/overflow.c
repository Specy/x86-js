#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
int main(void) {
  // A guard page makes the unterminated buffer's overread deterministic.
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  char *buffer = mmap(0, page * 2, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (buffer == MAP_FAILED) return 1;
  memset(buffer, 'A', page);
  mprotect(buffer + page, page, PROT_NONE);
  printf("length=%zu\n", strlen(buffer + page - 16));
  return 0;
}
