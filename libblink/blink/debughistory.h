#ifndef BLINK_DEBUGHISTORY_H_
#define BLINK_DEBUGHISTORY_H_
#include "blink/types.h"
#include <stdbool.h>

// The kinds of journal record a history packet carries (see debughistory.c),
// each taken back by the file that wrote it. Room is left for the input
// devices' reads and flushes (16 to 31) and the devices' settings (32 to 63).
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
