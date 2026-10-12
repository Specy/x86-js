#include "Zydis.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// A packed batch, independent of Blink and of JavaScript objects.
// flags: 1 call, 2 jump, 4 conditional, 8 return, 16 invalid, 32 branch target, 64 RIP-relative
// target, 128 immediate, 256 truncated (the bytes ended before the instruction did).
typedef struct {
  uint64_t address, branch, memory, immediate;
  uint32_t length, flags, text_offset, text_length, mnemonic;
  uint8_t branch_index, memory_index, immediate_index, reserved;
} Record;
_Static_assert(sizeof(Record) == 56, "decoder packet size");
static struct { Record *records; char *text; uint32_t count, text_size; } result;
static ZydisFormatterFunc original_memory, original_segment, original_mnemonic, original_prefixes,
  original_immediate;
static ZydisFormatterDecoratorFunc original_decorator;

// The text below is NASM, which assembleInstruction reads back: every hook exists because Zydis's
// Intel style prints something NASM rejects or encodes differently.

static ZyanStatus append(ZydisFormatterBuffer *b, const char *text) {
  ZyanString *str;
  ZyanStringView part;
  ZYAN_CHECK(ZydisFormatterBufferGetString(b, &str));
  ZYAN_CHECK(ZyanStringViewInsideBuffer(&part, text));
  return ZyanStringAppend(str, &part);
}

static ZyanUSize buffer_size(ZydisFormatterBuffer *b) {
  ZyanString *str;
  ZyanUSize size = 0;
  if (ZYAN_SUCCESS(ZydisFormatterBufferGetString(b, &str))) ZyanStringGetSize(str, &size);
  return size;
}

// NASM's spelling where Zydis's differs, for the text and the record's mnemonic alike: one name per
// condition (je, not jz; jae, not jnb; the same for setcc and cmovcc), while loops and jrcxz/jecxz
// keep theirs; and the 16-bit and far forms NASM names apart from the 64-bit ones.
static const char *nasm_alias(const ZydisDecodedInstruction *in) {
  switch (in->mnemonic) {
  case ZYDIS_MNEMONIC_JZ: return "je"; case ZYDIS_MNEMONIC_JNZ: return "jne";
  case ZYDIS_MNEMONIC_JNB: return "jae"; case ZYDIS_MNEMONIC_JNBE: return "ja";
  case ZYDIS_MNEMONIC_JNL: return "jge"; case ZYDIS_MNEMONIC_JNLE: return "jg";
  case ZYDIS_MNEMONIC_SETZ: return "sete"; case ZYDIS_MNEMONIC_SETNZ: return "setne";
  case ZYDIS_MNEMONIC_SETNB: return "setae"; case ZYDIS_MNEMONIC_SETNBE: return "seta";
  case ZYDIS_MNEMONIC_SETNL: return "setge"; case ZYDIS_MNEMONIC_SETNLE: return "setg";
  case ZYDIS_MNEMONIC_CMOVZ: return "cmove"; case ZYDIS_MNEMONIC_CMOVNZ: return "cmovne";
  case ZYDIS_MNEMONIC_CMOVNB: return "cmovae"; case ZYDIS_MNEMONIC_CMOVNBE: return "cmova";
  case ZYDIS_MNEMONIC_CMOVNL: return "cmovge"; case ZYDIS_MNEMONIC_CMOVNLE: return "cmovg";
  // In 64-bit mode Zydis's pushf, popf and iret are the 16-bit forms; NASM's are 64-bit.
  case ZYDIS_MNEMONIC_PUSHF: return "pushfw"; case ZYDIS_MNEMONIC_POPF: return "popfw";
  case ZYDIS_MNEMONIC_IRET: return "iretw";
  // Zydis's `ret far` is NASM's retf.
  case ZYDIS_MNEMONIC_RET:
    if (in->meta.branch_type != ZYDIS_BRANCH_TYPE_FAR) return NULL;
    return in->operand_width == 64 ? "retfq" : in->operand_width == 16 ? "retfw" : "retf";
  default: return NULL;
  }
}

// Zydis's own rule for when another operand implies a memory operand's size, from FormatterBase.c
// (not in Zydis.h, but linked from the same amalgamation).
ZyanU32 ZydisFormatterHelperGetExplicitSize(const ZydisFormatter *formatter,
    ZydisFormatterContext *context, const ZydisDecodedOperand *operand);

static ZyanStatus nasm_mnemonic(const ZydisFormatter *f, ZydisFormatterBuffer *b,
                               ZydisFormatterContext *c) {
  const char *alias = nasm_alias(c->instruction);
  if (!alias) return original_mnemonic(f, b, c);
  ZYAN_CHECK(ZydisFormatterBufferAppend(b, ZYDIS_TOKEN_MNEMONIC));
  return append(b, alias);
}

// VEX instructions NASM encodes as EVEX unless told otherwise.
static ZyanStatus nasm_prefixes(const ZydisFormatter *f, ZydisFormatterBuffer *b,
                               ZydisFormatterContext *c) {
  ZYAN_CHECK(original_prefixes(f, b, c));
  const ZydisDecodedInstruction *in = c->instruction;
  if (in->encoding == ZYDIS_INSTRUCTION_ENCODING_VEX &&
      (in->meta.isa_set == ZYDIS_ISA_SET_AVX_IFMA || in->meta.isa_set == ZYDIS_ISA_SET_AVX_VNNI_INT8 ||
       in->meta.isa_set == ZYDIS_ISA_SET_AVX_VNNI_INT16)) return append(b, "{vex} ");
  return ZYAN_STATUS_SUCCESS;
}

// NASM's size keywords, without `ptr`. A size is printed on every memory operand except an
// address (lea, MIB) and one whose size another operand implies; Zydis also leaves it out when
// the operand is the only one, which NASM rejects (`idiv [rbp-0x8]`) or guesses at (`fld [rax]`).
static ZyanStatus nasm_typecast(const ZydisFormatter *f, ZydisFormatterBuffer *b,
                               ZydisFormatterContext *c) {
  const ZydisDecodedInstruction *in = c->instruction;
  const ZydisDecodedOperand *op = c->operand;
  if (op->mem.type == ZYDIS_MEMOP_TYPE_AGEN || op->mem.type == ZYDIS_MEMOP_TYPE_MIB)
    return ZYAN_STATUS_SUCCESS;
  ZyanU32 bits;
  switch (in->mnemonic) {
  // lfs/lgs/lss take theirs from the register, and NASM takes none on the descriptor tables.
  case ZYDIS_MNEMONIC_LFS: case ZYDIS_MNEMONIC_LGS: case ZYDIS_MNEMONIC_LSS:
  case ZYDIS_MNEMONIC_LGDT: case ZYDIS_MNEMONIC_LIDT: case ZYDIS_MNEMONIC_SGDT:
  case ZYDIS_MNEMONIC_SIDT: bits = 0; break;
  // A register this operand's size does not follow: NASM would pick a size of its own.
  case ZYDIS_MNEMONIC_CRC32: case ZYDIS_MNEMONIC_MOVZX: case ZYDIS_MNEMONIC_MOVSX:
  case ZYDIS_MNEMONIC_CVTSI2SD: case ZYDIS_MNEMONIC_CVTSI2SS: case ZYDIS_MNEMONIC_VCVTSI2SD:
  case ZYDIS_MNEMONIC_VCVTSI2SS: case ZYDIS_MNEMONIC_VCVTUSI2SD: case ZYDIS_MNEMONIC_VCVTUSI2SS:
  case ZYDIS_MNEMONIC_VCVTSI2SH: case ZYDIS_MNEMONIC_VCVTUSI2SH: bits = op->size; break;
  // NASM 3.00 rejects a size on VEX vcmpss's memory operand, and needs none.
  case ZYDIS_MNEMONIC_VCMPSS:
    if (in->encoding == ZYDIS_INSTRUCTION_ENCODING_VEX) { bits = 0; break; }
    ZYAN_FALLTHROUGH;
  default:
    // NASM sizes a far pointer by its offset: m16:32 is `call far dword [rax]`, m16:64 `qword`.
    if (in->meta.branch_type == ZYDIS_BRANCH_TYPE_FAR) bits = op->size - 16;
    else if (in->operand_count_visible < 2) bits = op->size;
    else bits = ZydisFormatterHelperGetExplicitSize(f, c, op);
  }
  const char *size = NULL;
  switch (bits) {
  case 8: size = "byte "; break; case 16: size = "word "; break;
  case 32: size = "dword "; break; case 64: size = "qword "; break;
  case 80: size = "tword "; break; case 128: size = "oword "; break;
  case 256: size = "yword "; break; case 512: size = "zword "; break;
  }
  return size ? append(b, size) : ZYAN_STATUS_SUCCESS;
}

// `push word 0x10` is the 16-bit push (66 6a 10); `push 0x10` is the 64-bit one.
static ZyanStatus nasm_immediate(const ZydisFormatter *f, ZydisFormatterBuffer *b,
                                ZydisFormatterContext *c) {
  if (c->instruction->mnemonic == ZYDIS_MNEMONIC_PUSH && c->instruction->operand_width == 16)
    ZYAN_CHECK(append(b, "word "));
  return original_immediate(f, b, c);
}

// NASM writes a rounding mode or {sae} as an operand of its own: `vaddps zmm0, zmm1, zmm2, {rn-sae}`.
static ZyanStatus nasm_decorator(const ZydisFormatter *f, ZydisFormatterBuffer *b,
                                ZydisFormatterContext *c, ZydisDecorator decorator) {
  ZyanUSize before = buffer_size(b);
  ZYAN_CHECK(original_decorator(f, b, c, decorator));
  if ((decorator != ZYDIS_DECORATOR_RC && decorator != ZYDIS_DECORATOR_SAE) ||
      buffer_size(b) == before) return ZYAN_STATUS_SUCCESS;
  ZyanString *str;
  ZyanStringView comma;
  ZYAN_CHECK(ZydisFormatterBufferGetString(b, &str));
  ZYAN_CHECK(ZyanStringViewInsideBuffer(&comma, ","));
  return ZyanStringInsert(str, before, &comma);
}

// 64-bit mode ignores a cs, ds, es or ss override, and Zydis prints none; NASM encodes one when
// it is written, so the last such prefix is printed as the memory operand's segment
// (`nop word cs:[rax+rax*1]`), and the text keeps every byte. `3e` read as notrack is not one.
static ZyanStatus nasm_segment(const ZydisFormatter *f, ZydisFormatterBuffer *b,
                              ZydisFormatterContext *c) {
  ZyanUSize before = buffer_size(b);
  ZYAN_CHECK(original_segment(f, b, c));
  if (buffer_size(b) != before) return ZYAN_STATUS_SUCCESS;
  const ZydisDecodedInstruction *in = c->instruction;
  const char *segment = NULL;
  for (ZyanU8 i = 0; i < in->raw.prefix_count; ++i) {
    if (in->raw.prefixes[i].type != ZYDIS_PREFIX_TYPE_IGNORED) continue;
    switch (in->raw.prefixes[i].value) {
    case 0x26: segment = "es:"; break; case 0x2e: segment = "cs:"; break;
    case 0x36: segment = "ss:"; break; case 0x3e: segment = "ds:"; break;
    }
  }
  return segment ? append(b, segment) : ZYAN_STATUS_SUCCESS;
}

static ZyanStatus nasm_memory(const ZydisFormatter *f, ZydisFormatterBuffer *b,
                             ZydisFormatterContext *c) {
  const ZydisDecodedOperand *op = c->operand;
  ZyanBool relative = op->mem.base == ZYDIS_REGISTER_RIP || op->mem.base == ZYDIS_REGISTER_EIP;
  ZyanBool absolute = op->mem.base == ZYDIS_REGISTER_NONE && op->mem.index == ZYDIS_REGISTER_NONE &&
                      c->instruction->address_width == 64;
  ZyanU64 target = 0;
  if ((!relative && !absolute) ||
      !ZYAN_SUCCESS(ZydisCalcAbsoluteAddress(c->instruction, op, c->runtime_address, &target)))
    return original_memory(f, b, c);
  // NASM encodes a 64-bit address that a sign-extended dword cannot hold (only mov's moffs forms
  // have one) when the address is written as a qword.
  if (!relative && (ZyanI64)target == (ZyanI32)target) return original_memory(f, b, c);
  ZYAN_CHECK(f->func_print_typecast(f,b,c));
  ZYAN_CHECK(f->func_print_segment(f,b,c));
  char text[40];
  snprintf(text, sizeof(text), relative ? "[rel 0x%llx]" : "[qword 0x%llx]",
           (unsigned long long)target);
  return append(b, text);
}

static ZyanBool is_st(const ZydisDecodedOperand *op) {
  return op->type == ZYDIS_OPERAND_TYPE_REGISTER && op->reg.value >= ZYDIS_REGISTER_ST0 &&
         op->reg.value <= ZYDIS_REGISTER_ST7;
}

// x87 register forms name only the register the instruction encodes: `fadd st1` (Zydis's
// `fadd st0, st1`), `fadd to st1` (`fadd st1, st0`), `faddp st1`, `fcomi st1`, `fcmovb st1`.
static ZyanStatus nasm_pre_operand(const ZydisFormatter *f, ZydisFormatterBuffer *b,
                                  ZydisFormatterContext *c) {
  (void)f;
  const ZydisDecodedOperand *ops = c->operands;
  if (c->instruction->operand_count_visible != 2 || !is_st(&ops[0]) || !is_st(&ops[1]) ||
      (ops[0].visibility == ZYDIS_OPERAND_VISIBILITY_IMPLICIT) ==
      (ops[1].visibility == ZYDIS_OPERAND_VISIBILITY_IMPLICIT)) return ZYAN_STATUS_SUCCESS;
  if (c->operand->visibility == ZYDIS_OPERAND_VISIBILITY_IMPLICIT) return ZYDIS_STATUS_SKIP_TOKEN;
  switch (c->instruction->mnemonic) {
  case ZYDIS_MNEMONIC_FADD: case ZYDIS_MNEMONIC_FMUL: case ZYDIS_MNEMONIC_FSUB:
  case ZYDIS_MNEMONIC_FSUBR: case ZYDIS_MNEMONIC_FDIV: case ZYDIS_MNEMONIC_FDIVR:
    if (c->operand->id == 0) return append(b, "to ");
    ZYAN_FALLTHROUGH;
  default: return ZYAN_STATUS_SUCCESS;
  }
}

void release_decoded(void) {
  free(result.records); free(result.text);
  memset(&result, 0, sizeof(result));
}

static ZyanStatus hook(ZydisFormatter *formatter, ZydisFormatterFunction type, const void *func,
                       ZydisFormatterFunc *original) {
  const void *callback = func;
  ZYAN_CHECK(ZydisFormatterSetHook(formatter, type, &callback));
  if (original) *original = (ZydisFormatterFunc)callback;
  return ZYAN_STATUS_SUCCESS;
}

void *decode(const uint8_t *bytes, uint32_t length, uint64_t address) {
  release_decoded();
  ZydisDecoder decoder;
  ZydisFormatter formatter;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
  ZydisFormatterInit(&formatter, ZYDIS_FORMATTER_STYLE_INTEL);
  ZydisFormatterSetProperty(&formatter, ZYDIS_FORMATTER_PROP_HEX_UPPERCASE, ZYAN_FALSE);
  ZydisFormatterSetProperty(&formatter, ZYDIS_FORMATTER_PROP_ADDR_PADDING_ABSOLUTE, 0);
  hook(&formatter, ZYDIS_FORMATTER_FUNC_PRINT_TYPECAST, nasm_typecast, NULL);
  hook(&formatter, ZYDIS_FORMATTER_FUNC_FORMAT_OPERAND_MEM, nasm_memory, &original_memory);
  hook(&formatter, ZYDIS_FORMATTER_FUNC_PRINT_SEGMENT, nasm_segment, &original_segment);
  hook(&formatter, ZYDIS_FORMATTER_FUNC_PRINT_MNEMONIC, nasm_mnemonic, &original_mnemonic);
  hook(&formatter, ZYDIS_FORMATTER_FUNC_PRE_OPERAND, nasm_pre_operand, NULL);
  hook(&formatter, ZYDIS_FORMATTER_FUNC_PRINT_PREFIXES, nasm_prefixes, &original_prefixes);
  hook(&formatter, ZYDIS_FORMATTER_FUNC_FORMAT_OPERAND_IMM, nasm_immediate, &original_immediate);
  const void *decorator = nasm_decorator;
  ZydisFormatterSetHook(&formatter, ZYDIS_FORMATTER_FUNC_PRINT_DECORATOR, &decorator);
  original_decorator = (ZydisFormatterDecoratorFunc)decorator;
  ZydisDecodedInstruction instruction;
  ZydisDecodedOperand operands[ZYDIS_MAX_OPERAND_COUNT];
  // One pass: x86 code averages about 4 bytes and 32 characters an instruction, and both
  // buffers grow when a range does not.
  uint32_t slots = length / 4 + 16, capacity = slots * 32 + 1;
  result.records = malloc(slots * sizeof(Record));
  result.text = malloc(capacity);
  if (!result.records || !result.text) { release_decoded(); return NULL; }
  for (uint32_t offset=0; offset<length; ++result.count) {
    if (result.count == slots) {
      Record *grown = slots < UINT32_MAX / 2 / sizeof(Record) ?
        realloc(result.records, slots * 2 * sizeof(Record)) : NULL;
      if (!grown) { release_decoded(); return NULL; }
      result.records = grown; slots *= 2;
    }
    Record *r = &result.records[result.count];
    memset(r, 0, sizeof(*r));
    char text[192];
    r->address = address + offset;
    ZyanStatus status = ZydisDecoderDecodeFull(&decoder,bytes+offset,length-offset,&instruction,operands);
    if (!ZYAN_SUCCESS(status)) {
      r->length = 1; r->flags = status == ZYDIS_STATUS_NO_MORE_DATA ? 16|256 : 16;
      snprintf(text,sizeof(text),"db 0x%02x",bytes[offset]);
    } else {
      r->length = instruction.length;
      const char *alias = nasm_alias(&instruction);
      r->mnemonic = (uintptr_t)(alias ? alias : ZydisMnemonicGetString(instruction.mnemonic));
      if (instruction.meta.category == ZYDIS_CATEGORY_CALL) r->flags |= 1;
      if (instruction.meta.category == ZYDIS_CATEGORY_UNCOND_BR) r->flags |= 2;
      if (instruction.meta.category == ZYDIS_CATEGORY_COND_BR) r->flags |= 2|4;
      if (instruction.meta.category == ZYDIS_CATEGORY_RET) r->flags |= 8;
      for (uint32_t i=0; i<instruction.operand_count_visible; ++i) {
        const ZydisDecodedOperand *op = &operands[i];
        if (op->type == ZYDIS_OPERAND_TYPE_IMMEDIATE) {
          if (op->imm.is_relative && (r->flags & 3)) {
            if (ZYAN_SUCCESS(ZydisCalcAbsoluteAddress(&instruction,op,r->address,&r->branch))) {
              r->flags |= 32; r->branch_index = i;
            }
          } else { r->immediate=op->imm.value.u; r->immediate_index=i; r->flags|=128; }
        }
        if (op->type == ZYDIS_OPERAND_TYPE_MEMORY &&
            (op->mem.base == ZYDIS_REGISTER_RIP || op->mem.base == ZYDIS_REGISTER_EIP)) {
          if (ZYAN_SUCCESS(ZydisCalcAbsoluteAddress(&instruction,op,r->address,&r->memory))) {
            r->flags |= 64; r->memory_index = i;
          }
        }
      }
      // NASM's nop takes only the memory or register operand (0f 1f /0); the register Zydis
      // shows from the reg field, any value of which is the same nop, is left out.
      ZydisDecodedInstruction shown = instruction;
      if (shown.mnemonic == ZYDIS_MNEMONIC_NOP && shown.operand_count_visible > 1)
        shown.operand_count_visible = 1;
      if (!ZYAN_SUCCESS(ZydisFormatterFormatInstruction(&formatter,&shown,operands,
          shown.operand_count_visible,text,sizeof(text),r->address,NULL))) {
        release_decoded(); return NULL;
      }
    }
    r->text_length = strlen(text);
    r->text_offset = result.text_size;
    uint32_t needed = result.text_size + r->text_length;
    if (needed > capacity) {
      capacity = needed * 2;
      char *grown = realloc(result.text,capacity);
      if (!grown) { release_decoded(); return NULL; }
      result.text = grown;
    }
    memcpy(result.text+result.text_size,text,r->text_length);
    result.text_size = needed;
    offset += r->length;
  }
  return &result;
}
