#include <math.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  printf("cos=%.6f\n", cos(argc > 1 ? atof(argv[1]) : 0.0));
  return 0;
}
