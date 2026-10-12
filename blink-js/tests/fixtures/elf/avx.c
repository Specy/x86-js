#include <immintrin.h>
#include <stdio.h>
__attribute__((target("avx2"), noinline))
int vector_sum(int value) {
  volatile __m256i vector = _mm256_set1_epi32(value);
  __m256i sum = _mm256_add_epi32(vector, vector);
  return _mm256_extract_epi32(sum, 0);
}
int main(int argc, char **argv) {
  (void)argv;
  printf("value=%d\n", argc > 5 ? vector_sum(argc) : argc);
  return 0;
}
