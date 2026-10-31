#ifndef BLINK_TERMINAL_H_
#define BLINK_TERMINAL_H_
#include <stdbool.h>
#include <stddef.h>

#include "blink/fds.h"
#include "blink/linux.h"
#include "blink/machine.h"
#include "blink/types.h"

// The two output channels the host tells apart.
#define TERMINAL_STDOUT 1
#define TERMINAL_STDERR 2

// The termios settings the host's line discipline follows, as
// GetTerminalMode() reports them.
#define TERMINAL_MODE_CANONICAL         1   // ICANON
#define TERMINAL_MODE_ECHO              2   // ECHO
#define TERMINAL_MODE_SIGNALS           4   // ISIG
#define TERMINAL_MODE_CR_TO_NL          8   // ICRNL
#define TERMINAL_MODE_OUTPUT_PROCESSING 16  // OPOST
#define TERMINAL_MODE_NL_TO_CR_NL       32  // ONLCR

// The flags of a JOURNAL_TERMINAL_READ record.
#define TERMINAL_READ_END_OF_INPUT 1  // it took an End of input token
#define TERMINAL_READ_WAITED       2  // it halted for its input

// Standard input, standard output and the terminal opened by path write to
// the host's standard output; standard error, and what is dup'd from it, to
// its standard error. Both read the terminal's input.
extern const struct FdCb kFdCbRandom;
extern const struct FdCb kFdCbTerminal;
extern const struct FdCb kFdCbTerminalError;

// Receives every write to the terminal, as (channel, bytes, length).
extern void (*terminal_output_callback)(int, const u8 *, u32);

bool IsTerminalFd(const struct Fd *);
const struct FdCb *GetTerminalDeviceCb(int);
void OpenTerminalHostFds(void);
void AddTerminalFds(struct Fds *);
bool WaitForTerminalInput(struct Machine *, u64, int);
u64 GetTerminalWaitSize(void);
size_t CountTerminalInput(void);
bool HasTerminalInput(void);
void ProvideTerminalInput(const u8 *, size_t);
void ProvideTerminalEndOfInput(void);
void ClearTerminalInput(void);
void FlushTerminalInput(void);
int GetTerminalMode(void);
void GetTerminalTermios(struct termios_linux *);
void SetTerminalTermios(const struct termios_linux *);
void ResetTerminal(void);
void SetTerminalProcessing(bool, bool);
void SendTerminalSignal(struct Machine *, int);
void UndoTerminalJournal(u32, const u8 *, u32);

#endif /* BLINK_TERMINAL_H_ */
