#ifndef BLINK_SIGNAL_H_
#define BLINK_SIGNAL_H_
#include "blink/machine.h"

bool IsSignalSerious(int);
bool IsSignalQueueable(int);
void SigRestore(struct Machine *);
bool IsSignalIgnoredByDefault(int);
void OnSignal(int, siginfo_t *, void *);
void EnqueueSignal(struct Machine *, int);
void EnqueueSignalWithCode(struct Machine *, int, int);
void DeliverSignal(struct Machine *, int, int);
void RestartSignalSyscall(struct Machine *, u64, u64);
void TerminateSignal(struct Machine *, int, int);
int ConsumeSignal(struct Machine *, int *, bool *);
void DeliverSignalToUser(struct Machine *, int, int);

#endif /* BLINK_SIGNAL_H_ */
