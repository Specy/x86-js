#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <string>

extern "C" {
#include "blink/blinkenlib.h"
}

namespace {

using emscripten::val;

struct RegisterBinding {
  const char *name;
  int id;
};

constexpr RegisterBinding kRegisters[] = {
    {"rax", BLINKENLIB_REG_RAX}, {"rbx", BLINKENLIB_REG_RBX},
    {"rcx", BLINKENLIB_REG_RCX}, {"rdx", BLINKENLIB_REG_RDX},
    {"rsp", BLINKENLIB_REG_RSP}, {"rbp", BLINKENLIB_REG_RBP},
    {"rsi", BLINKENLIB_REG_RSI}, {"rdi", BLINKENLIB_REG_RDI},
    {"r8", BLINKENLIB_REG_R8},   {"r9", BLINKENLIB_REG_R9},
    {"r10", BLINKENLIB_REG_R10}, {"r11", BLINKENLIB_REG_R11},
    {"r12", BLINKENLIB_REG_R12}, {"r13", BLINKENLIB_REG_R13},
    {"r14", BLINKENLIB_REG_R14}, {"r15", BLINKENLIB_REG_R15},
    {"rip", BLINKENLIB_REG_RIP},
};

int RegisterIdFromName(const std::string &name) {
  for (const RegisterBinding &binding : kRegisters) {
    if (name == binding.name) return binding.id;
  }
  return -1;
}

val MakeError(const std::string &error) {
  val result = val::object();
  result.set("ok", false);
  result.set("error", error);
  return result;
}

uint64_t GetRegister(const std::string &name) {
  int id = RegisterIdFromName(name);
  return id < 0 ? 0 : blinkenlib_get_register_u64(id);
}

bool SetRegister(const std::string &name, uint64_t value) {
  int id = RegisterIdFromName(name);
  return id >= 0 && blinkenlib_set_register_u64(id, value);
}

val GetRegisterSnapshot() {
  val result = val::object();
  val registers = val::object();
  for (const RegisterBinding &binding : kRegisters) {
    registers.set(binding.name, blinkenlib_get_register_u64(binding.id));
  }
  result.set("registers", registers);
  result.set("rip", blinkenlib_get_register_u64(BLINKENLIB_REG_RIP));
  result.set("rsp", blinkenlib_get_sp());
  result.set("pc", blinkenlib_get_pc());
  result.set("flags", blinkenlib_get_flags());
  return result;
}

val ReadMemoryBytes(uint64_t address, uint32_t length) {
  val result = val::object();
  val bytes = val::array();
  for (uint32_t index = 0; index < length; ++index) {
    uint8_t byte = 0;
    if (!blinkenlib_read_memory_byte(address + index, &byte)) {
      result.set("ok", false);
      result.set("error", "virtual address is not mapped");
      result.set("readBytes", index);
      return result;
    }
    bytes.set(index, byte);
  }
  result.set("ok", true);
  result.set("bytes", bytes);
  return result;
}

val WriteMemoryBytes(uint64_t address, val bytes) {
  uint32_t length = bytes["length"].as<uint32_t>();
  for (uint32_t index = 0; index < length; ++index) {
    uint8_t byte = static_cast<uint8_t>(bytes[index].as<uint32_t>() & 0xff);
    if (!blinkenlib_write_memory_byte(address + index, byte)) {
      val result = MakeError("virtual address is not mapped");
      result.set("writtenBytes", index);
      return result;
    }
  }
  val result = val::object();
  result.set("ok", true);
  result.set("writtenBytes", length);
  return result;
}

val GetDisassemblySnapshot() {
  val result = val::object();
  val lines = val::array();
  uint32_t currentLine = blinkenlib_refresh_disassembly();
  uint32_t lineCount = blinkenlib_get_disassembly_line_count();
  for (uint32_t index = 0; index < lineCount; ++index) {
    const char *line = blinkenlib_get_disassembly_line(index);
    if (line && line[0]) lines.set(index, std::string(line));
  }
  result.set("lines", lines);
  result.set("currentLine", currentLine);
  return result;
}

const char *StopKindName(uint32_t kind) {
  switch (kind) {
    case BLINKENLIB_STOP_BREAKPOINT:
      return "breakpoint";
    case BLINKENLIB_STOP_LIMIT:
      return "limit";
    default:
      return "none";
  }
}

void SetRunControls(uint64_t limit, val breakpointAddresses) {
  blinkenlib_set_run_instruction_limit(limit);
  blinkenlib_clear_run_breakpoints();
  uint32_t length = breakpointAddresses["length"].as<uint32_t>();
  for (uint32_t index = 0; index < length; ++index) {
    blinkenlib_add_run_breakpoint(
        std::stoull(breakpointAddresses[index].as<std::string>()));
  }
}

val GetRunStop() {
  val result = val::object();
  uint32_t kind = blinkenlib_get_last_stop_kind();
  result.set("kind", StopKindName(kind));
  result.set("address", blinkenlib_get_last_stop_address());
  result.set("executedInstructions",
             blinkenlib_get_last_run_instruction_count());
  return result;
}

val GetRunControls() {
  val result = val::object();
  val breakpoints = val::array();
  uint32_t count = blinkenlib_get_run_breakpoint_count();
  for (uint32_t index = 0; index < count; ++index) {
    breakpoints.set(index, blinkenlib_get_run_breakpoint_address(index));
  }
  result.set("breakpoints", breakpoints);
  return result;
}

val GetInstructionAt(uint64_t address) {
  uint64_t resolvedAddress = 0;
  uint8_t size = 0;
  char buffer[1024];
  if (!blinkenlib_get_instruction_at(address, &resolvedAddress, &size, buffer,
                                     sizeof(buffer))) {
    return val::null();
  }
  val result = val::object();
  result.set("address", resolvedAddress);
  result.set("size", size);
  result.set("code", std::string(buffer));
  return result;
}

void SetEmulationArgs(const std::string &progname, const std::string &argc,
                      const std::string &argv) {
  blinkenlib_set_program_args(progname.c_str(), argc.c_str(), argv.c_str());
}

}  // namespace

EMSCRIPTEN_BINDINGS(blinkenlib_facade) {
  emscripten::function("blinkenlibGetRegister", &GetRegister);
  emscripten::function("blinkenlibSetRegister", &SetRegister);
  emscripten::function("blinkenlibGetRegisterSnapshot", &GetRegisterSnapshot);
  emscripten::function("blinkenlibReadMemoryBytes", &ReadMemoryBytes);
  emscripten::function("blinkenlibWriteMemoryBytes", &WriteMemoryBytes);
  emscripten::function("blinkenlibGetDisassembly", &GetDisassemblySnapshot);
  emscripten::function("blinkenlibSetRunControls", &SetRunControls);
  emscripten::function("blinkenlibGetRunControls", &GetRunControls);
  emscripten::function("blinkenlibGetRunStop", &GetRunStop);
  emscripten::function("blinkenlibGetInstructionAt", &GetInstructionAt);
  emscripten::function("blinkenlibSetEmulationArgs", &SetEmulationArgs);
  emscripten::function("blinkenlibGetInputMaxBytes",
                       &blinkenlib_get_input_max_bytes);
}