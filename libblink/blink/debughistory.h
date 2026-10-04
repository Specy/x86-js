#ifndef BLINK_DEBUGHISTORY_H_
#define BLINK_DEBUGHISTORY_H_
#include "blink/types.h"
#include <stdbool.h>

void DebugHistoryClear(void);
void DebugHistoryBegin(u32 control_flow, u32 instruction_size);
void DebugHistoryFinish(void);
void DebugHistoryCancel(void);
bool DebugHistoryPending(void);
void DebugHistoryPokeByte(u64 address, u8 old);
#endif
