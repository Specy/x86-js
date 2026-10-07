/* Host transport and restart state for a single browser process. */
#include "blink/environment.h"
#include "blink/blinkenlib.h"
#include "blink/timespec.h"
#include "blink/endian.h"
#include "blink/syscall.h"
#include "blink/signal.h"
#include "blink/linux.h"
#include "blink/debughistory.h"
#include <stdint.h>
#include <limits.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_JS(double, HostMilliseconds, (int clock), {
  try { return Module.blinkHostNow ? Module.blinkHostNow(clock) : (clock === 0 ? Date.now() : performance.now()); }
  catch (error) { Module.blinkHostError = error; return 0; }
});
#endif
static bool pending, masked, cancelled, input_wait;
static u64 saved_mask;
static int wait_clock = CLOCK_MONOTONIC;
static int reported_wait_clock = CLOCK_MONOTONIC;
static bool reported_wait_clock_valid;
static struct timespec deadline;
/* ITIMER_REAL belongs to the guest process, not the browser's host process.
 * Its elapsed time is monotonic even when CLOCK_REALTIME jumps. */
static struct timespec timer_deadline;
static int64_t timer_interval_us;
static bool timer_armed;
static struct timespec TimerNow(void) {
  struct timespec now;
  HostNow(CLOCK_MONOTONIC, &now);
  return now;
}
static int64_t TimevalMicros(struct timeval value) {
  return (int64_t)value.tv_sec * 1000000 + value.tv_usec;
}
static struct timeval MicrosTimeval(int64_t us) {
  struct timeval value = {us / 1000000, us % 1000000};
  return value;
}
static struct timespec AddMicros(struct timespec now, int64_t us) {
  struct timespec delta = {us / 1000000, (us % 1000000) * 1000};
  return AddTime(now, delta);
}
void GuestTimerReset(void) {
  timer_armed = false;
  timer_interval_us = 0;
  timer_deadline = GetZeroTime();
}
void GuestTimerCheck(struct Machine *m) {
  struct timespec now;
  struct timespec late, step;
  __int128 late_ns, interval_ns, remaining_ns;
  if (!timer_armed || !m) return;
  now = TimerNow();
  if (CompareTime(now, timer_deadline) < 0) return;
  DebugHistoryMarkIrreversible();
  EnqueueSignal(m, SIGALRM_LINUX);
  if (!timer_interval_us) {
    timer_armed = false;
    return;
  }
  late = SubtractTime(now, timer_deadline);
  late_ns = (__int128)late.tv_sec * 1000000000 + late.tv_nsec;
  interval_ns = (__int128)timer_interval_us * 1000;
  remaining_ns = interval_ns - late_ns % interval_ns;
  step.tv_sec = remaining_ns / 1000000000;
  step.tv_nsec = remaining_ns % 1000000000;
  timer_deadline = AddTime(now, step);
}
int GuestTimerGet(struct itimerval *out) {
  struct timespec now, left;
  GuestTimerCheck(g_machine);
  out->it_interval = MicrosTimeval(timer_interval_us);
  out->it_value = MicrosTimeval(0);
  if (!timer_armed) return 0;
  now = TimerNow();
  left = SubtractTime(timer_deadline, now);
  /* Linux rounds a nonzero remaining interval up to one microsecond. */
  out->it_value.tv_sec = left.tv_sec;
  out->it_value.tv_usec = (left.tv_nsec + 999) / 1000;
  if (out->it_value.tv_usec == 1000000) {
    ++out->it_value.tv_sec;
    out->it_value.tv_usec = 0;
  }
  return 0;
}
int GuestTimerSet(const struct itimerval *value, struct itimerval *old) {
  if (old) GuestTimerGet(old);
#ifdef __EMSCRIPTEN__
  DebugHistoryMarkIrreversible();
#endif
  if (!value) {
    GuestTimerReset();
    return 0;
  }
  timer_interval_us = TimevalMicros(value->it_interval);
  timer_armed = value->it_value.tv_sec || value->it_value.tv_usec;
  if (timer_armed)
    timer_deadline = AddMicros(TimerNow(), TimevalMicros(value->it_value));
  return 0;
}
unsigned GuestTimerAlarm(unsigned seconds) {
  struct itimerval old, next = {0};
  GuestTimerGet(&old);
  if (seconds) next.it_value.tv_sec = seconds;
  GuestTimerSet(&next, 0);
  return old.it_value.tv_sec + !!old.it_value.tv_usec;
}
int64_t GuestTimerDeadline(void) {
  if (!timer_armed) return -1;
  if (timer_deadline.tv_sec >= INT64_MAX / 1000000000)
    return INT64_MAX;
  return ToNanoseconds(timer_deadline);
}
int HostNow(int clock, struct timespec *ts) {
#ifdef __EMSCRIPTEN__
  double ms = HostMilliseconds(clock);
  ts->tv_sec = ms / 1000;
  ts->tv_nsec = (ms - (double)ts->tv_sec * 1000) * 1000000;
  return 0;
#else
  return clock_gettime(clock, ts);
#endif
}
struct timespec GuestWaitDeadline(struct timespec proposed) {
  return pending ? deadline : proposed;
}
void GuestWaitMask(struct Machine *m, u64 mask) {
  if (!masked) {
    saved_mask = m->sigmask;
    masked = true;
  }
  m->sigmask = mask & ~((1ull << (9 - 1)) | (1ull << (19 - 1)));
}
void GuestWaitFinish(struct Machine *m) {
  if (masked) m->sigmask = saved_mask;
  m->issigsuspend = false;
  pending = masked = cancelled = input_wait = false;
  wait_clock = CLOCK_MONOTONIC;
  reported_wait_clock_valid = false;
  deadline = GetZeroTime();
}
void GuestWaitRestoreMask(struct Machine *m) {
  if (masked) {
    m->sigmask = saved_mask;
    masked = false;
  }
  m->issigsuspend = false;
}
bool GuestWaitCancelled(void) { return cancelled; }
_Noreturn void GuestWaitHalt(struct Machine *m, struct timespec until, bool input) {
  deadline = GuestWaitDeadline(until);
  pending = true;
  input_wait = input;
  reported_wait_clock_valid = false;
  HaltMachine(m, kMachineWaitTrap);
}
EMSCRIPTEN_KEEPALIVE
void blinkenlib_wait_cancel(void) { cancelled = true; }
EMSCRIPTEN_KEEPALIVE
bool blinkenlib_wait_pending(void) { return pending; }
EMSCRIPTEN_KEEPALIVE
bool blinkenlib_wait_input(void) { return input_wait; }
EMSCRIPTEN_KEEPALIVE
int64_t blinkenlib_wait_deadline(void) {
  int64_t timer = GuestTimerDeadline();
  int64_t wait = deadline.tv_sec == GetMaxTime().tv_sec ? -1 : ToNanoseconds(deadline);
  reported_wait_clock = wait_clock;
  reported_wait_clock_valid = true;
  if (timer < 0) return wait;
  if (wait < 0) {
    reported_wait_clock = CLOCK_MONOTONIC;
    return timer;
  }
  struct timespec timer_now, wait_now;
  HostNow(CLOCK_MONOTONIC, &timer_now);
  HostNow(wait_clock, &wait_now);
  if (timer - ToNanoseconds(timer_now) < wait - ToNanoseconds(wait_now)) {
    reported_wait_clock = CLOCK_MONOTONIC;
    return timer;
  }
  return wait;
}
EMSCRIPTEN_KEEPALIVE
int64_t blinkenlib_timer_deadline(void) { return GuestTimerDeadline(); }

void GuestWaitClock(int clock) {
  wait_clock = clock;
  reported_wait_clock_valid = false;
}
EMSCRIPTEN_KEEPALIVE
int blinkenlib_wait_clock(void) {
  return reported_wait_clock_valid ? reported_wait_clock : wait_clock;
}

static bool WaitInterrupted(struct Machine *m, bool restartable) {
  GuestTimerCheck(m);
  if (cancelled) return true;
  u64 ax = Read64(m->ax);
  bool interrupted = CheckInterrupt(m, restartable);
  if (!interrupted) Write64(m->ax, ax);
  return interrupted;
}
bool GuestWaitInterrupted(struct Machine *m) {
  return WaitInterrupted(m, false);
}
bool GuestWaitInterruptedRestartable(struct Machine *m) {
  return WaitInterrupted(m, true);
}
