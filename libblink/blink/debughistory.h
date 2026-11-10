#ifndef BLINK_DEBUGHISTORY_H_
#define BLINK_DEBUGHISTORY_H_
#include "blink/types.h"
#include <stdbool.h>

// The kinds of journal record a history packet carries (see debughistory.c),
// each taken back by the file that wrote it, which owns a range of them: the
// terminal 1 to 15 (here), the input devices 16 to 31 (evdev.h), the
// framebuffer 32 to 35 (fbdev.h) and the sound devices 36 to 63 (sound.h).
#define JOURNAL_TERMINAL_READ  1  // what a read of the terminal took
#define JOURNAL_TERMINAL_FLUSH 2  // the terminal input TCFLSH or TCSETSF discarded
#define JOURNAL_TERMINAL_MODE  3  // the termios before and after TCSETS

void DebugHistoryClear(void);
void DebugHistoryBegin(u32 control_flow, u32 instruction_size);
void DebugHistoryFinish(bool exited);
void DebugHistoryCancel(void);
void DebugHistoryMarkIrreversible(void);
bool DebugHistoryPending(void);
void DebugHistoryPokeByte(u64 address, u8 old);
void DebugHistoryJournal(u32 kind, const void *data, u32 size);
void DebugHistorySplit(void);

// The call stack, kept for every instruction a debugged program runs whether
// or not the history records it, and put back by Undo with the entry it
// belongs to (see debughistory.c). A frame is a call or a signal delivered to
// a handler. `call_stack_depth` is how many frames there are, and
// `call_stack_until` the stack pointer at or above which the newest is gone,
// UINT64_MAX with none: the run loop reads both after every instruction.
#define CALL_STACK_CALL   0
#define CALL_STACK_SIGNAL 1
extern u32 call_stack_depth;
extern u64 call_stack_until;
// Whether a `call` pushes a frame: only in a program being debugged.
extern bool call_stack_calls;
void CallStackClear(void);
// A call from `destination` less its length to `target`, whose return
// address is at `sp`.
void CallStackCall(u64 target, u64 destination, u64 sp);
// A signal delivered to `handler`, with rsp at `sp` holding the restorer's
// address, that interrupted the program at `resume` with rsp at
// `interrupted_sp`.
void CallStackSignal(u64 handler, u64 resume, u64 sp, u64 interrupted_sp);
// The signal just delivered resumes at `resume` instead, as a restarted
// system call does.
void CallStackRedirectSignal(u64 resume);
// Drops every frame rsp has passed: called when `sp` >= `call_stack_until`.
void CallStackUnwind(u64 sp);
#endif
