#ifndef BLINK_SPEAKER_H_
#define BLINK_SPEAKER_H_
#include "blink/machine.h"
#include "blink/types.h"

/* The PC speaker's driver, Linux's pcspkr_event(): what an event the input
 * core passes the PC Speaker device does. evdev.c calls it where the input
 * core calls the driver: for every EV_SND event of a code the speaker has
 * (SND_BELL, SND_TONE), whether a program wrote it to /dev/input/event3 or
 * the console's KIOCSOUND and KDMKTONE injected it, whether or not it changes
 * anything, and for SYN_CONFIG. An EV_SND SND_TONE or SND_BELL sets the
 * speaker's tone, anything else changes nothing. Returns 0. */
int SpeakerInputEvent(struct Machine *m, u16 type, u16 code, i32 value);

/* KDMKTONE's timer, kept lazily, catches up with Program time: evdev.c calls
 * it before anything it does with the PC Speaker device's readers. */
void SpeakerSettle(void);

/* When KDMKTONE's timer ends the tone, in Program time, or -1 when no timer
 * is running: the silence it injects then can complete the PC Speaker
 * device's packet and wake a reader (kd_nosound()), so a reader waiting on
 * the device waits until then too. */
i64 SpeakerTimerDeadline(void);

#endif /* BLINK_SPEAKER_H_ */
