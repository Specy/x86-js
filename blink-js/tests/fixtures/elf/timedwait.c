// Timed waits on futexes: glibc's sem_timedwait and pthread_cond_timedwait
// wait with FUTEX_WAIT_BITSET until an absolute CLOCK_REALTIME deadline, and
// one thread has nothing that could post or signal, so both time out.
#include <errno.h>
#include <pthread.h>
#include <semaphore.h>
#include <stdio.h>
#include <time.h>

static struct timespec after(long ms) {
  struct timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  t.tv_nsec += ms * 1000000;
  t.tv_sec += t.tv_nsec / 1000000000;
  t.tv_nsec %= 1000000000;
  return t;
}

static const char *waited(struct timespec start) {
  struct timespec end;
  clock_gettime(CLOCK_MONOTONIC, &end);
  long ms = (end.tv_sec - start.tv_sec) * 1000 + (end.tv_nsec - start.tv_nsec) / 1000000;
  return ms >= 100 ? "at least 100 ms" : "less than 100 ms";
}

int main(void) {
  struct timespec start, deadline;
  sem_t sem;
  sem_init(&sem, 0, 0);
  deadline = after(100);
  clock_gettime(CLOCK_MONOTONIC, &start);
  int result = sem_timedwait(&sem, &deadline);
  printf("sem_timedwait=%d %s, %s\n", result, errno == ETIMEDOUT ? "ETIMEDOUT" : "unexpected",
         waited(start));
  pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
  pthread_cond_t cond = PTHREAD_COND_INITIALIZER;
  pthread_mutex_lock(&mutex);
  deadline = after(100);
  clock_gettime(CLOCK_MONOTONIC, &start);
  result = pthread_cond_timedwait(&cond, &mutex, &deadline);
  printf("pthread_cond_timedwait=%s, %s\n", result == ETIMEDOUT ? "ETIMEDOUT" : "unexpected",
         waited(start));
  return 0;
}
