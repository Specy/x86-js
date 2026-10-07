#ifndef BLINK_TERMINAL_H_
#define BLINK_TERMINAL_H_
#include <stdbool.h>
#include <stddef.h>

#include "blink/fds.h"
#include "blink/machine.h"
#include "blink/types.h"

// The two output channels the host tells apart.
#define TERMINAL_STDOUT 1
#define TERMINAL_STDERR 2

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
bool WaitForTerminalInput(struct Machine *, u64);
u64 GetTerminalWaitSize(void);
size_t CountTerminalInput(void);
bool HasTerminalInput(void);
void ProvideTerminalInput(const u8 *, size_t);
void ProvideTerminalEndOfInput(void);
void ClearTerminalInput(void);

#endif /* BLINK_TERMINAL_H_ */
