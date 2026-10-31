#ifndef BLINK_EVDEV_H_
#define BLINK_EVDEV_H_
#include <poll.h>
#include <stdbool.h>
#include <sys/types.h>
#include <sys/uio.h>

#include "blink/devices.h"
#include "blink/machine.h"
#include "blink/types.h"

// The journal records of the input devices (debughistory.h leaves them 16 to
// 31), each taken back by UndoEvdevJournal().
#define JOURNAL_EVDEV_READ   16  // the events a read took from a reader
#define JOURNAL_EVDEV_FLUSH  17  // the events an ioctl threw away from a queue
#define JOURNAL_EVDEV_CLOCK  18  // EVIOCSCLOCKID's clock before and after
#define JOURNAL_EVDEV_INJECT 19  // what a write or EVIOCSREP did to a device
#define JOURNAL_EVDEV_GRAB   20  // the reader with EVIOCGRAB, before and after
#define JOURNAL_EVDEV_MASK   21  // a reader's EVIOCSMASK mask before it changed
#define JOURNAL_EVDEV_ABS    22  // an axis's absinfo before and after EVIOCSABS

int OpenEvdev(struct DeviceFile *);
void ReleaseEvdev(struct DeviceFile *);
bool EvdevReadWaits(struct DeviceFile *);
i64 EvdevReadyDeadline(struct DeviceFile *);
ssize_t ReadEvdev(int, const struct iovec *, int);
ssize_t WriteEvdev(int, const struct iovec *, int);
int PollEvdev(struct pollfd *, nfds_t, int);
int IoctlEvdev(struct Machine *, int, u64, i64);
void ResetInputDevices(void);
bool EvdevConsoleSound(u32, i64);
void EvdevConsoleLeds(u8 *, u8 *);
void UndoEvdevJournal(u32, const u8 *, u32);

#endif /* BLINK_EVDEV_H_ */
