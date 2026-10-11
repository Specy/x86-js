#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  puts(argc > 1 && !strcmp(argv[1], "hunter2") ? "Correct!" : "Wrong!");
  return 0;
}
