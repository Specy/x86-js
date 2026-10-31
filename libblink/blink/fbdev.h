#ifndef BLINK_FBDEV_H_
#define BLINK_FBDEV_H_
#include <stdbool.h>
#include <sys/uio.h>

#include "blink/fds.h"
#include "blink/machine.h"
#include "blink/types.h"

// The framebuffer's journal records (debughistory.h gives devices' settings
// the kinds from 32): what Undo puts back.
#define JOURNAL_FRAMEBUFFER_STATE    32  // the screen information, pan and blank before
#define JOURNAL_FRAMEBUFFER_POSITION 33  // an open file description's offset before
#define JOURNAL_FRAMEBUFFER_BYTES    34  // the bytes a write() replaced

void ResetFramebuffer(void);
int OpenFramebuffer(void);
bool IsFramebufferFildes(struct Machine *, int);
ssize_t ReadFramebuffer(int, const struct iovec *, int);
ssize_t WriteFramebuffer(int, const struct iovec *, int);
ssize_t PreadFramebuffer(int, const struct iovec *, int, i64);
ssize_t PwriteFramebuffer(int, const struct iovec *, int, i64);
i64 SeekFramebuffer(int, i64, int);
int SyncFramebuffer(int);
int IoctlFramebuffer(struct Machine *, int, u64, i64);
u8 *MapFramebuffer(struct System *, int, i64, i64);
bool FramebufferJournalsSyscall(struct Machine *, u64, i64);
void UndoFramebufferJournal(u32, const u8 *, u32);

#endif /* BLINK_FBDEV_H_ */
