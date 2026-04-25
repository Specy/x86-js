#ifndef BLINK_BLINKENLIB_H_
#define BLINK_BLINKENLIB_H_
#include <stdbool.h>

#include "blink/types.h"

#ifdef __cplusplus
extern "C" {
#endif

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

/**
 * cross-language struct.
 * This is just a list of wasm 32-bit pointers
 * that will be passed to js.
 * Since passing a struct to js is complicated, we are
 * passing an array of pointers instead. js will have an hardcoded
 * list with the meaning of each pointer.
 */
#define CLSTRUCT_VERSION 1
struct clstruct {
  u32 version;  // number

  u32 codemem;
  u32 stackmem;

  u32 readaddr;
  u32 readsize;  // number
  u32 writeaddr;
  u32 writesize;  // number

  u32 flags;

  u32 cs__base;
  u32 rip;
  u32 rsp;
  u32 rbp;
  u32 rsi;
  u32 rdi;

  u32 r8;
  u32 r9;
  u32 r10;
  u32 r11;
  u32 r12;
  u32 r13;
  u32 r14;
  u32 r15;

  u32 rax;
  u32 rbx;
  u32 rcx;
  u32 rdx;

  // disassembly buffer
  u32 dis__max_lines;     // number
  u32 dis__max_line_len;  // number
  u32 dis__current_line;  // number
  u32 dis__buffer;
};

enum blinkenlib_register_id {
  BLINKENLIB_REG_RAX = 0,
  BLINKENLIB_REG_RBX = 1,
  BLINKENLIB_REG_RCX = 2,
  BLINKENLIB_REG_RDX = 3,
  BLINKENLIB_REG_RSP = 4,
  BLINKENLIB_REG_RBP = 5,
  BLINKENLIB_REG_RSI = 6,
  BLINKENLIB_REG_RDI = 7,
  BLINKENLIB_REG_R8 = 8,
  BLINKENLIB_REG_R9 = 9,
  BLINKENLIB_REG_R10 = 10,
  BLINKENLIB_REG_R11 = 11,
  BLINKENLIB_REG_R12 = 12,
  BLINKENLIB_REG_R13 = 13,
  BLINKENLIB_REG_R14 = 14,
  BLINKENLIB_REG_R15 = 15,
  BLINKENLIB_REG_RIP = 16,
};

enum blinkenlib_stop_kind {
  BLINKENLIB_STOP_NONE = 0,
  BLINKENLIB_STOP_BREAKPOINT = 1,
  BLINKENLIB_STOP_LIMIT = 2,
};

void blinkenlib_run_fast();
void blinkenlib_run();
void blinkenlib_start();
void blinkenlib_starti();
void blinkenlib_stepi();
void blinkenlib_continue();
void blinkenlib_preempt_resume();
void blinkenlib_faketty_resume();
void *blinkenlib_get_clstruct();
void *blinkenlib_get_argc_string();
void *blinkenlib_get_argv_string();
void *blinkenlib_get_progname_string();
u8 *blinkenlib_spy_address(u64 virtual_address);

bool blinkenlib_has_machine();
u64 blinkenlib_get_register_u64(int register_id);
bool blinkenlib_set_register_u64(int register_id, u64 value);
u64 blinkenlib_get_pc();
u64 blinkenlib_get_sp();
u32 blinkenlib_get_flags();
u64 blinkenlib_get_input_max_bytes();
bool blinkenlib_read_memory_byte(u64 virtual_address, u8 *value);
bool blinkenlib_write_memory_byte(u64 virtual_address, u8 value);
void blinkenlib_set_run_instruction_limit(u64 limit);
void blinkenlib_clear_run_breakpoints();
bool blinkenlib_add_run_breakpoint(u64 address);
u32 blinkenlib_get_run_breakpoint_count();
u64 blinkenlib_get_run_breakpoint_address(u32 index);
u32 blinkenlib_get_last_stop_kind();
u64 blinkenlib_get_last_stop_address();
u64 blinkenlib_get_last_run_instruction_count();
bool blinkenlib_get_instruction_at(u64 virtual_address, u64 *address, u8 *size,
                                   char *buffer, u32 buffer_size);
u32 blinkenlib_refresh_disassembly();
u32 blinkenlib_get_disassembly_current_line();
u32 blinkenlib_get_disassembly_line_count();
const char *blinkenlib_get_disassembly_line(u32 index);
void blinkenlib_set_program_args(const char *progname, const char *argc,
                                 const char *argv);

#ifdef __cplusplus
}
#endif

#endif /* BLINK_BLINKENLIB_H_ */
