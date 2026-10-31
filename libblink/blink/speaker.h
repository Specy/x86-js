#ifndef BLINK_SPEAKER_H_
#define BLINK_SPEAKER_H_
#include "blink/machine.h"
#include "blink/types.h"

/* What one input event written to the PC Speaker's evdev node does, as the
 * pcspkr driver's event handler: an EV_SND SND_TONE or SND_BELL sets the
 * speaker's tone, anything else changes nothing. The evdev device calls it
 * for every whole event a program writes there (speaker.c defines it). */
int SpeakerInputEvent(struct Machine *m, u16 type, u16 code, i32 value);

#endif /* BLINK_SPEAKER_H_ */
