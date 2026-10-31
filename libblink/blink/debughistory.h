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
#endif
