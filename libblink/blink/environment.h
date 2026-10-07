#ifndef BLINK_ENVIRONMENT_H_
#define BLINK_ENVIRONMENT_H_
#include "blink/machine.h"
#include <time.h>
#include <sys/time.h>
int HostNow(int, struct timespec *);
struct timespec GuestWaitDeadline(struct timespec);
void GuestWaitMask(struct Machine *, u64);
void GuestWaitFinish(struct Machine *);
_Noreturn void GuestWaitHalt(struct Machine *, struct timespec, bool);
bool GuestWaitCancelled(void);
bool GuestWaitInterrupted(struct Machine *);
bool GuestWaitInterruptedRestartable(struct Machine *);
void GuestWaitClock(int);
void GuestWaitRestoreMask(struct Machine *);
void GuestTimerReset(void);
void GuestTimerCheck(struct Machine *);
int GuestTimerGet(struct itimerval *);
int GuestTimerSet(const struct itimerval *, struct itimerval *);
unsigned GuestTimerAlarm(unsigned);
int64_t GuestTimerDeadline(void);
#endif
