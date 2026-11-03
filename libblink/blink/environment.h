#ifndef BLINK_ENVIRONMENT_H_
#define BLINK_ENVIRONMENT_H_
#include "blink/machine.h"
#include <time.h>
#include <sys/time.h>
int HostNow(int, struct timespec *);
struct timespec GuestWaitDeadline(struct timespec);
void GuestWaitMask(struct Machine *, u64);
void GuestWaitFinish(struct Machine *);
_Noreturn void GuestWaitHalt(struct Machine *, struct timespec, u32);
_Noreturn void GuestWaitHaltWake(struct Machine *, struct timespec, u32,
                                 struct timespec);
_Noreturn void GuestWaitHaltTerminalRead(struct Machine *, struct timespec);
bool GuestWaitCancelled(void);
bool GuestWaitInterrupted(struct Machine *);
bool GuestWaitInterruptedRestartable(struct Machine *);
void GuestWaitClock(int);
void GuestWaitRestoreMask(struct Machine *);
void GuestTimerReset(void);
/* Whether ITIMER_REAL is armed: the run loop reads it before every
 * instruction, and only then calls GuestTimerCheck(), once every
 * TIMER_CHECK_INSTRUCTIONS of them (blinkenlib.c). */
extern bool guest_timer_armed;
void GuestTimerCheck(struct Machine *);
int GuestTimerGet(struct itimerval *);
int GuestTimerSet(const struct itimerval *, struct itimerval *);
unsigned GuestTimerAlarm(unsigned);
int64_t GuestTimerDeadline(void);
#endif
