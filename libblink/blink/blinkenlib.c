#include "blink/blinkenlib.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "blink/breakpoint.h"
#include "blink/bus.h"
#include "blink/dis.h"
#include "blink/endian.h"
#include "blink/high.h"
#include "blink/loader.h"
#include "blink/machine.h"
#include "blink/map.h"
#include "blink/syscall.h"
#include "blink/x86.h"

void update_clstruct(struct Machine *m);

/*
 * program  | cpu cycles | speed on low end device
 * -----------------------------------------------
 * FASM     |   7 * 10e3 | 300ms
 * GNU AS   | 157 * 10e3 | 1s
 * GNU LD   | 215 * 10e3 | 1s
 * NASM     |1000 * 10e3 | 10s
 * ---------------------
 * MAX_CYCLES holds the max amount of cpu emulation
 * cycles before a "context switch" where execution
 * is paused, and the javascript runtime event loop
 * is allowed to resume.
 * MAX_CYCLES is set so that FASM runs uninterrupted,
 * and anything else is interrupted at least 5 times
 * per second, which is enough to have good renderer
 * updates on low end devices, despite some lag.
 */
#define MAX_CYCLES 100000

/*
 * After this max amount of context switches,
 * the process will terminate with SIGXCPU
 */
#define MAX_SWITCHES 1000

int switches_count = 0;

/*
 * This blink wrapper will communicate events with
 * the javascript side via SIGTRAP signals and the
 * additional SIGTRAP event codes.
 * The event codes are defined here. An event code
 * of 0 will be recognized as an actuall SIGTRAP.
 */
#define SIGTRAP_CODE_SIGTRAP  0
#define SIGTRAP_CODE_PREEMPT  40
#define SIGTRAP_CODE_STEP     41
#define SIGTRAP_CODE_FAKE_TTY 42
#define SIGTRAP_CODE_BREAKPOINT 43
#define SIGTRAP_CODE_RUN_LIMIT 44

/*
 * These variables are defined by javascript;
 * the pointers are passed to main when this module starts
 */
void (*signal_callback)(int, int) = 0;
void (*exit_callback)(int) = 0;

/*
 * this buffer holds the disassembly strings
 * that will be passed to js
 */
#define DIS_MAX_LINES    200
#define DIS_MAX_LINE_LEN 200
char dis_buffer[DIS_MAX_LINES][DIS_MAX_LINE_LEN] = {0};

/*
 * These buffers hold the program execution arguments.
 * The pointers to these strings will be passed to js,
 * and the content will be dynamically set by js
 */
#define ARGC_MAX_LINE_LEN     200
#define ARGV_MAX_LINE_LEN     200
#define PROGNAME_MAX_LINE_LEN 200
char argc_string[ARGC_MAX_LINE_LEN] = {0};
char argv_string[ARGV_MAX_LINE_LEN] = {0};
char progname_string[PROGNAME_MAX_LINE_LEN] = {0};

struct clstruct cls;
struct System *s;
struct Machine *m;
static struct Dis dis[1];
bool single_stepping = false;
bool debugger_enabled = false;
static u32 dis_current_line = 0;
static struct Breakpoints run_breakpoints;
#define RUN_BREAKPOINT_MAX 1024
static u64 pending_run_breakpoints[RUN_BREAKPOINT_MAX];
static u32 pending_run_breakpoint_count = 0;
static u64 run_instruction_limit = 0;
static u64 run_instruction_count = 0;
static u32 last_stop_kind = BLINKENLIB_STOP_NONE;
static u64 last_stop_address = 0;
static bool skip_current_breakpoint = false;
static u64 skip_breakpoint_address = 0;

/**
 * Signals handler.
 * Signals will be passed to the javascript runtime.
 * SIGTRAP will not terminate the program
 */
void TerminateSignal(struct Machine *m, int sig, int code) {
#ifdef DEBUG
  if (sig != SIGTRAP) {
    printf("Terminate signal received! %d : %d \n", sig, code);
  } else {
    printf("SIGTRAP received\n");
  }
#endif
  update_clstruct(m);
  if (signal_callback) {
    signal_callback(sig, code);
  }
}

/* -------------------- */
/* Utility functions    */
/* -------------------- */

/**
 * Returns true if 𝑣 is a shadow memory virtual address.
 */
static bool IsShadow(i64 v) {
  return 0x7fff8000 <= v && v < 0x100080000000;
}

/**
 * disassemble n lines of code, starting from the current ip.
 * the disassembled lines will be stored in the dis struct.
 */
static i64 Disassemble(void) {
  i64 lines = DIS_MAX_LINES;
  if (Dis(dis, m, GetPc(m), m->ip, lines) != -1) {
    return DisFind(dis, GetPc(m));
  } else {
    return -1;
  }
}

/**
 * get the index in the dis struct at which
 * the current instruction is stored.
 * if it's not there, the dis struct is repopulated
 * by a new run of the disassembler
 */
static i64 GetDisIndex(void) {
  i64 i;
  if ((i = DisFind(dis, GetPc(m) - m->oplen)) != -1 ||
      (i = Disassemble()) != -1) {
    while (i + 1 < dis->ops.i) {
      if (!dis->ops.p[i].size) {
        ++i;
      } else {
        break;
      }
    }
  }
  return i;
}

/**
 * Populate a buffer with the ascii disassembly listing updated to
 * the current ip.
 * The buffer is designed to be read from js, and parsed into html.
 */
u64 updateDisassembler() {
  i64 lineIndex = GetDisIndex();
  if (lineIndex < 0) lineIndex = 0;
  for (int i = 0; i < dis->ops.i && i < DIS_MAX_LINES; i++) {
    const char *curr = DisGetLine(dis, m, i);
    int len = strlen(curr) + 1;
    if (len > DIS_MAX_LINE_LEN) {
      len = DIS_MAX_LINE_LEN;
    }
    memcpy(dis_buffer[i], curr, len);
    dis_buffer[i][len - 1] = 0;
  }
  dis_current_line = lineIndex;
  return dis_current_line;
}

static u8 *GetRegisterPointer(int register_id) {
  if (!m) return 0;
  switch (register_id) {
    case BLINKENLIB_REG_RAX:
      return m->ax;
    case BLINKENLIB_REG_RBX:
      return m->bx;
    case BLINKENLIB_REG_RCX:
      return m->cx;
    case BLINKENLIB_REG_RDX:
      return m->dx;
    case BLINKENLIB_REG_RSP:
      return m->sp;
    case BLINKENLIB_REG_RBP:
      return m->bp;
    case BLINKENLIB_REG_RSI:
      return m->si;
    case BLINKENLIB_REG_RDI:
      return m->di;
    case BLINKENLIB_REG_R8:
      return m->r8;
    case BLINKENLIB_REG_R9:
      return m->r9;
    case BLINKENLIB_REG_R10:
      return m->r10;
    case BLINKENLIB_REG_R11:
      return m->r11;
    case BLINKENLIB_REG_R12:
      return m->r12;
    case BLINKENLIB_REG_R13:
      return m->r13;
    case BLINKENLIB_REG_R14:
      return m->r14;
    case BLINKENLIB_REG_R15:
      return m->r15;
    default:
      return 0;
  }
}

static void CopySafeAscii(char *target, int max_length, const char *source) {
  int index;
  if (!target || max_length <= 0) return;
  if (!source) source = "";
  for (index = 0; index < max_length - 1 && source[index]; ++index) {
    unsigned char ch = source[index];
    target[index] = ch >= 0x20 && ch <= 0x7e ? ch : ' ';
  }
  target[index] = 0;
}

static void SetRunStop(u32 kind, u64 address) {
  last_stop_kind = kind;
  last_stop_address = address;
}

static void ClearRunStop(void) {
  SetRunStop(BLINKENLIB_STOP_NONE, 0);
}

static bool PushRunBreakpoint(u64 address) {
  struct Breakpoint breakpoint = {0};
  breakpoint.addr = address;
  breakpoint.symbol = 0;
  breakpoint.disable = false;
  breakpoint.oneshot = false;
  return PushBreakpoint(&run_breakpoints, &breakpoint) != -1;
}

static void ApplyPendingRunBreakpoints(void) {
  run_breakpoints.i = 0;
  for (u32 index = 0; index < pending_run_breakpoint_count; ++index) {
    PushRunBreakpoint(pending_run_breakpoints[index]);
  }
}

static void PauseForRunControl(u32 kind, int signal_code, u64 address) {
  SetRunStop(kind, address);
  update_clstruct(m);
  TerminateSignal(m, SIGTRAP, signal_code);
}

void update_clstruct(struct Machine *m) {
  if (!debugger_enabled) return;
  // memory regions
  u64 pc = GetPc(m);
  u64 sp = Read64(m->sp);
  cls.codemem = (u32)SpyAddress(m, pc);
  cls.stackmem = (u32)SpyAddress(m, sp);
  // read or writes
  cls.readaddr = 0;
  cls.readsize = 0;
  cls.writeaddr = 0;
  cls.writesize = 0;
  if (!IsShadow(m->readaddr) && !IsShadow(m->readaddr + m->readsize)) {
    cls.readaddr = (u32)&m->readaddr;
    cls.readsize = (u32)&m->readsize;
  }
  if (!IsShadow(m->writeaddr) && !IsShadow(m->writeaddr + m->writesize)) {
    cls.writeaddr = (u32)&m->writeaddr;
    cls.writesize = (u32)&m->writesize;
  }

  // flags and other useful info
  cls.flags = (u32)&m->flags;
  cls.cs__base = (u32)&m->cs.base;

  // registers
  cls.rip = (u32)&m->ip;
  cls.rsp = (u32)&m->sp;
  cls.rbp = (u32)&m->bp;
  cls.rsi = (u32)&m->si;
  cls.rdi = (u32)&m->di;
  cls.r8 = (u32)&m->r8;
  cls.r9 = (u32)&m->r9;
  cls.r10 = (u32)&m->r10;
  cls.r11 = (u32)&m->r11;
  cls.r12 = (u32)&m->r12;
  cls.r13 = (u32)&m->r13;
  cls.r14 = (u32)&m->r14;
  cls.r15 = (u32)&m->r15;

  cls.rax = (u32)&m->ax;
  cls.rbx = (u32)&m->bx;
  cls.rcx = (u32)&m->cx;
  cls.rdx = (u32)&m->dx;

  // disassembled code buffer
  // TODO: all this data should be in a global
  // disassembler struct, this function should
  // only copy pointers.
  cls.dis__max_lines = DIS_MAX_LINES;
  cls.dis__max_line_len = DIS_MAX_LINE_LEN;
  cls.dis__current_line = updateDisassembler();
  cls.dis__buffer = (u32)&dis_buffer;

  // TODO: other useful data
  //  printf("page tables:\n%s\n", FormatPml4t(m));
  //  u64 entry = FindPageTableEntry(m, (GetPc(m) & -4096));
  //  printf("pagetable %lx: %lx\n", GetPc(m), entry);
}

void runLoop() {
  int interrupt;
  ssize_t breakpoint;
  m->nofault = false;

  // TODO: update global disassember struct with
  // a function call. both the struct and fcall dont
  // exist right now

  if (!(interrupt = sigsetjmp(m->onhalt, 1))) {
    m->canhalt = true;
    for (int i = 0; i < MAX_CYCLES; i++) {
      u64 pc = GetPc(m);
      if (run_instruction_limit &&
          run_instruction_count >= run_instruction_limit) {
        PauseForRunControl(BLINKENLIB_STOP_LIMIT, SIGTRAP_CODE_RUN_LIMIT, pc);
        return;
      }
      LoadInstruction(m, pc);  // not really needed like this
      pc = GetPc(m);
      if (!single_stepping) {
        if (skip_current_breakpoint && pc == skip_breakpoint_address) {
          skip_current_breakpoint = false;
        } else if ((breakpoint = IsAtBreakpoint(&run_breakpoints, pc)) != -1 ||
                   (breakpoint = IsAtBreakpoint(&run_breakpoints, m->ip)) !=
                       -1) {
          (void)breakpoint;
          skip_current_breakpoint = true;
          skip_breakpoint_address = pc;
          PauseForRunControl(BLINKENLIB_STOP_BREAKPOINT,
                             SIGTRAP_CODE_BREAKPOINT, pc);
          return;
        }
      }

      ExecuteInstruction(m);
      run_instruction_count += 1;

      if (single_stepping) {
        TerminateSignal(m, SIGTRAP, SIGTRAP_CODE_STEP);
        return;
      }

    }

    // send the preemption signal, passing the execution back to
    // javascript so that the JS event loop can resume. After a
    // rerender on the main thread JS will call preempt_resume()
    // and pass execution back to this routine.
    switches_count += 1;
    if (switches_count > MAX_SWITCHES) {
      TerminateSignal(m, SIGXCPU, 0);
    } else {
      TerminateSignal(m, SIGTRAP, SIGTRAP_CODE_PREEMPT);
    }

    // TODO: make the loop run a fixed num of instructions,
    // then from here use the emscripten loop features
    // to schedule a recursive call to runLoop that won't block
    // the thread
  } else {
    // if sigsetjmp fake-returned 1, the actual trap number might have been
    // either 1 or 0; this should have been stored in m->trapno
    if (interrupt == 1) interrupt = m->trapno;
#ifdef DEBUG
    printf("handling machine interrupt: %d \n", interrupt);
    puts("--");
#endif
    if (interrupt == kMachineExitTrap) {
      if (signal_callback) {
        update_clstruct(m);
        exit_callback(m->system->exitcode);
      }
    } else if (interrupt == kMachineFakeTTYtrap) {
      update_clstruct(m);
      TerminateSignal(m, SIGTRAP, SIGTRAP_CODE_FAKE_TTY);
    }
  }
  m->canhalt = false;
}

void SetUp(void) {
  InitMap();
  InitBus();
  s = NewSystem(XED_MACHINE_MODE_LONG);
  m = g_machine = NewMachine(s, 0);
  m->metal = false;
  // when true, read(0) will halt the machine, with a SIGTRAP_CODE_FAKE_TTY
  // To resume the machine, a call to blinkenlib_faketty_resume is required
  m->fakettycanhalt = true;
  // when true, guest exit syscalls will generate an interrupt that
  // can be handled via sigsetjmp, instead of calling the native _exit().
  // see: blinkenlib.c:runLoop()
  m->system->trapexit = true;

  // reset the counter we use to limit the execution cycles of a program
  switches_count = 0;

  // TODO: from blinkenlights. define these callbacks
  //  m->system->redraw = Redraw;
  //  m->system->onbinbase = OnBinbase;
  //  m->system->onlongbranch = OnLongBranch;
}

// callback
void OnSymbols(struct System *s) {
  // ResolveBreakpoints();
  // ResolveWatchpoints();
}

void PostLoadSetup() {
  AddStdFd(&m->system->fds, 0);
  AddStdFd(&m->system->fds, 1);
  AddStdFd(&m->system->fds, 2);
  if (debugger_enabled) {
    // initialize the disassembler
    m->system->dis = dis;
    m->system->onsymbols = OnSymbols;
    LoadDebugSymbols(m->system);
    Disassemble();
  }
}

void TearDown(void) {
  // TODO: make sure free is ok when not allocated
  DisFree(dis);
  FreeMachine(m);
  memset(dis_buffer, 0, sizeof(dis_buffer));
}

void stringToArgsArray(char *argsString, char **argsArray, int maxArgs) {
  int count = 0;
  char *token = strtok(argsString, " ");
  while (token != NULL && count < maxArgs - 1) {
    argsArray[count++] = token;
    token = strtok(NULL, " ");
  }
  argsArray[count] = NULL;
}

/**
 * Set up a program using the arguments previously set
 * by javascript in the global strings:
 * - progname_string
 * - argc_string
 * - argv_string
 *
 */
void setupProgram(bool withdebugger) {
  debugger_enabled = withdebugger;

  // terminal prompt
  printf("\n$ %s\n", argc_string);

  // get **argc
  char *args[ARGC_MAX_LINE_LEN];
  char argc_string_copy[ARGC_MAX_LINE_LEN];
  memcpy(argc_string_copy, argc_string, ARGC_MAX_LINE_LEN);
  stringToArgsArray(argc_string_copy, args, ARGC_MAX_LINE_LEN);

  // get **argv
  // TODO
  char *vars = 0;

  // close previous instances
  TearDown();
  SetUp();
  char *bios = 0;
  LoadProgram(m, progname_string, progname_string, args, &vars, bios);
  PostLoadSetup();
  ApplyPendingRunBreakpoints();
  skip_current_breakpoint = false;
  skip_breakpoint_address = 0;
  update_clstruct(m);
}

/* -------------------- */
/* Exported api         */
/* -------------------- */

EMSCRIPTEN_KEEPALIVE
void blinkenlib_run_fast() {
  setupProgram(false);
  single_stepping = false;
  blinkenlib_set_run_instruction_limit(0);
  blinkenlib_clear_run_breakpoints();
  runLoop();
}

EMSCRIPTEN_KEEPALIVE
void blinkenlib_run() {
  setupProgram(true);
  // run the program to the end
  single_stepping = false;
  runLoop();
}

EMSCRIPTEN_KEEPALIVE
void blinkenlib_starti() {
  setupProgram(true);
  // don't run any instruction
}

EMSCRIPTEN_KEEPALIVE
void blinkenlib_start() {
  setupProgram(true);
  // TODO: set breakpoint at main
  single_stepping = false;
  runLoop();
}

EMSCRIPTEN_KEEPALIVE
void blinkenlib_stepi() {
  if (s->exited) {
    unassert(!"Invalid state");
  }
  // run a single step
  single_stepping = true;
  runLoop();
}

EMSCRIPTEN_KEEPALIVE
void blinkenlib_continue() {
  if (s->exited) {
    unassert(!"Invalid state");
  }
  single_stepping = false;
  runLoop();
}

EMSCRIPTEN_KEEPALIVE
void blinkenlib_preempt_resume() {
  if (s->exited) {
    unassert(!"Invalid state");
  }
  runLoop();
}

EMSCRIPTEN_KEEPALIVE
void blinkenlib_faketty_resume() {
  if (s->exited) {
    unassert(!"Invalid state");
  }
  if (!m->fakettycanhalt) {
    unassert(!"Invalid state (tty)");
  }
  m->fakettycanhalt = false;
  runLoop();
}

bool blinkenlib_has_machine() {
  return m != 0;
}

u64 blinkenlib_get_register_u64(int register_id) {
  u8 *reg;
  if (!m) return 0;
  if (register_id == BLINKENLIB_REG_RIP) return m->ip;
  reg = GetRegisterPointer(register_id);
  return reg ? Read64(reg) : 0;
}

bool blinkenlib_set_register_u64(int register_id, u64 value) {
  u8 *reg;
  if (!m) return false;
  if (register_id == BLINKENLIB_REG_RIP) {
    m->ip = value;
    return true;
  }
  reg = GetRegisterPointer(register_id);
  if (!reg) return false;
  Write64(reg, value);
  return true;
}

u64 blinkenlib_get_pc() {
  return m ? GetPc(m) : 0;
}

u64 blinkenlib_get_sp() {
  return m ? Read64(m->sp) : 0;
}

u32 blinkenlib_get_flags() {
  return m ? m->flags : 0;
}

u64 blinkenlib_get_input_max_bytes() {
  return blinkenlib_get_register_u64(BLINKENLIB_REG_RDX);
}

bool blinkenlib_read_memory_byte(u64 virtual_address, u8 *value) {
  u8 *ptr = 0;
  if (!m || !value || IsShadow(virtual_address)) return false;
  BEGIN_NO_PAGE_FAULTS;
  ptr = SpyAddress(m, virtual_address);
  END_NO_PAGE_FAULTS;
  if (!ptr) return false;
  *value = *ptr;
  return true;
}

bool blinkenlib_write_memory_byte(u64 virtual_address, u8 value) {
  u8 *ptr = 0;
  if (!m || IsShadow(virtual_address)) return false;
  BEGIN_NO_PAGE_FAULTS;
  ptr = SpyAddress(m, virtual_address);
  END_NO_PAGE_FAULTS;
  if (!ptr) return false;
  *ptr = value;
  return true;
}

void blinkenlib_set_run_instruction_limit(u64 limit) {
  run_instruction_limit = limit;
  run_instruction_count = 0;
  ClearRunStop();
}

void blinkenlib_clear_run_breakpoints() {
  pending_run_breakpoint_count = 0;
  run_breakpoints.i = 0;
}

bool blinkenlib_add_run_breakpoint(u64 address) {
  if (pending_run_breakpoint_count >= RUN_BREAKPOINT_MAX) return false;
  pending_run_breakpoints[pending_run_breakpoint_count++] = address;
  return PushRunBreakpoint(address);
}

u32 blinkenlib_get_run_breakpoint_count() {
  return run_breakpoints.i;
}

u64 blinkenlib_get_run_breakpoint_address(u32 index) {
  if (index >= (u32)run_breakpoints.i) return 0;
  return run_breakpoints.p[index].addr;
}

u32 blinkenlib_get_last_stop_kind() {
  return last_stop_kind;
}

u64 blinkenlib_get_last_stop_address() {
  return last_stop_address;
}

u64 blinkenlib_get_last_run_instruction_count() {
  return run_instruction_count;
}

bool blinkenlib_get_instruction_at(u64 virtual_address, u64 *address, u8 *size,
                                   char *buffer, u32 buffer_size) {
  struct Dis one = {true};
  const char *line;
  if (buffer && buffer_size) buffer[0] = 0;
  if (!m || !address || !size || !buffer || !buffer_size) return false;
  if (Dis(&one, m, virtual_address, virtual_address - m->cs.base, 1) == -1 ||
      one.ops.i <= 0) {
    DisFree(&one);
    return false;
  }
  *address = one.ops.p[0].addr;
  *size = one.ops.p[0].size;
  line = DisGetLine(&one, m, 0);
  snprintf(buffer, buffer_size, "%s", line ? line : "");
  DisFree(&one);
  return true;
}

u32 blinkenlib_refresh_disassembly() {
  if (!m || !debugger_enabled) return 0;
  return updateDisassembler();
}

u32 blinkenlib_get_disassembly_current_line() {
  return dis_current_line;
}

u32 blinkenlib_get_disassembly_line_count() {
  if (!m || !debugger_enabled) return 0;
  if (dis->ops.i < 0) return 0;
  if (dis->ops.i > DIS_MAX_LINES) return DIS_MAX_LINES;
  return dis->ops.i;
}

const char *blinkenlib_get_disassembly_line(u32 index) {
  if (index >= DIS_MAX_LINES) return "";
  return dis_buffer[index];
}

void blinkenlib_set_program_args(const char *progname, const char *argc,
                                 const char *argv) {
  CopySafeAscii(progname_string, PROGNAME_MAX_LINE_LEN, progname);
  CopySafeAscii(argc_string, ARGC_MAX_LINE_LEN, argc);
  CopySafeAscii(argv_string, ARGV_MAX_LINE_LEN, argv);
}

EMSCRIPTEN_KEEPALIVE
void *blinkenlib_get_clstruct() {
  return &cls;
}

EMSCRIPTEN_KEEPALIVE
void *blinkenlib_get_argc_string() {
  return &argc_string;
}

EMSCRIPTEN_KEEPALIVE
void *blinkenlib_get_argv_string() {
  return &argv_string;
}

EMSCRIPTEN_KEEPALIVE
void *blinkenlib_get_progname_string() {
  return &progname_string;
}

EMSCRIPTEN_KEEPALIVE
u8 *blinkenlib_spy_address(u64 virtual_address) {
  BEGIN_NO_PAGE_FAULTS;
  return SpyAddress(m, virtual_address);
  END_NO_PAGE_FAULTS;
}

EMSCRIPTEN_KEEPALIVE
int main(int argc, char *argv[]) {
#ifndef __EMSCRIPTEN__
  puts("This program is designed to run in emscripten");
  return 1;
#endif
  puts("Initializing blink emulator...");
  if (argc != 3) {
    puts("Error. main expected 3 args");
    return 1;
  }
  int signal_callback_num = atoi(argv[1]);
  int exit_callback_num = atoi(argv[2]);
  signal_callback = (void (*)(int, int))signal_callback_num;
  exit_callback = (void (*)(int))exit_callback_num;
#ifdef DEBUG
  printf("fp1: %d\n", signal_callback_num);
  printf("fp2: %d\n", exit_callback_num);
#endif
  // disable ansi colors in prints
  g_high.enabled = false;
  // initialize the cross-language struct
  cls.version = CLSTRUCT_VERSION;
  // overlays setup goes here
  // vfs setup goes here
  puts("blink ready!");
}
