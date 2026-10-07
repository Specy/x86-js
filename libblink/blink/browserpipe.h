#ifndef BLINK_BROWSERPIPE_H_
#define BLINK_BROWSERPIPE_H_
#include "blink/machine.h"
#include <sys/stat.h>
int BrowserPipe(int *, int);
void BrowserPipeForget(int);
void BrowserPipeDup(int, int);
bool IsBrowserPipe(int);
size_t BrowserPipeCount(int);
size_t BrowserPipeSpace(int);
void BrowserPipeStat(int, struct stat *);
int BrowserPipeFlags(int, int);
void BrowserPipeSetFlags(int, int);
int WaitForBrowserPipe(struct Machine *, int, bool, u64, int);
extern const struct FdCb kFdCbBrowserPipe;
#endif
