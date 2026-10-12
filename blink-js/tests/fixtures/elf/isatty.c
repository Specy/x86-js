#include <stdio.h>
#include <unistd.h>

/* A tty's standard streams: isatty() is true for each, and glibc
 * line-buffers standard output, so a prompt without a newline is written
 * before the read that waits for its answer. */
int main(void) {
  char line[64];
  printf("%d %d %d\n", isatty(0), isatty(1), isatty(2));
  printf("name? ");
  if (!fgets(line, sizeof line, stdin)) return 1;
  printf("hi %s", line);
  return 0;
}
