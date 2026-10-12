#include "Zydis.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// A packed batch, independent of Blink and of JavaScript objects.
typedef struct {
  uint64_t address, branch, memory, immediate;
  uint32_t length, flags, text_offset, text_length, mnemonic;
  uint8_t branch_index, memory_index, immediate_index, reserved;
} Record;
_Static_assert(sizeof(Record) == 56, "decoder packet size");
static struct { Record *records; char *text; uint32_t count, text_size; } result;
static ZydisFormatterFunc original_typecast, original_memory;

static ZyanStatus nasm_typecast(const ZydisFormatter *f, ZydisFormatterBuffer *b,
                               ZydisFormatterContext *c) {
  ZyanUSize before;
  ZyanString *initial;
  ZydisFormatterBufferGetString(b, &initial);
  ZyanStringGetSize(initial, &before);
  ZyanStatus status = original_typecast(f, b, c);
  if (!ZYAN_SUCCESS(status)) return status;
  ZyanString *str;
  ZyanUSize size;
  const char *text;
  ZYAN_CHECK(ZydisFormatterBufferGetString(b, &str));
  ZYAN_CHECK(ZyanStringGetSize(str, &size));
  ZYAN_CHECK(ZyanStringGetData(str, &text));
  if (size >= 5 && !memcmp(text + size - 5, " ptr ", 5))
    ZYAN_CHECK(ZyanStringDelete(str, size - 5, 4));
  ZyanStringGetSize(str, &size);
  ZyanStringGetData(str, &text);
  const char *replacement = NULL;
  if (size > before) {
    if (!strncmp(text + before, "xmmword", 7)) replacement = "oword ";
    else if (!strncmp(text + before, "ymmword", 7)) replacement = "yword ";
    else if (!strncmp(text + before, "zmmword", 7)) replacement = "zword ";
    else if (!strncmp(text + before, "tbyte", 5)) replacement = "tword ";
  }
  if (replacement) {
    ZyanStringView part;
    ZYAN_CHECK(ZyanStringTruncate(str, before));
    ZYAN_CHECK(ZyanStringViewInsideBuffer(&part, replacement));
    ZYAN_CHECK(ZyanStringAppend(str, &part));
  }
  return ZYAN_STATUS_SUCCESS;
}

static ZyanStatus nasm_memory(const ZydisFormatter *f, ZydisFormatterBuffer *b,
                             ZydisFormatterContext *c) {
  if (c->operand->mem.base != ZYDIS_REGISTER_RIP &&
      c->operand->mem.base != ZYDIS_REGISTER_EIP) return original_memory(f,b,c);
  ZYAN_CHECK(f->func_print_typecast(f,b,c));
  ZYAN_CHECK(f->func_print_segment(f,b,c));
  ZyanU64 target;
  ZYAN_CHECK(ZydisCalcAbsoluteAddress(c->instruction, c->operand, c->runtime_address, &target));
  char text[40];
  snprintf(text, sizeof(text), "[rel 0x%llx]", (unsigned long long)target);
  ZyanString *str;
  ZyanStringView part;
  ZYAN_CHECK(ZydisFormatterBufferGetString(b, &str));
  ZYAN_CHECK(ZyanStringViewInsideBuffer(&part, text));
  return ZyanStringAppend(str, &part);
}

void release_decoded(void) {
  free(result.records); free(result.text);
  memset(&result, 0, sizeof(result));
}

void *decode(const uint8_t *bytes, uint32_t length, uint64_t address) {
  release_decoded();
  ZydisDecoder decoder;
  ZydisFormatter formatter;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
  ZydisFormatterInit(&formatter, ZYDIS_FORMATTER_STYLE_INTEL);
  ZydisFormatterSetProperty(&formatter, ZYDIS_FORMATTER_PROP_HEX_UPPERCASE, ZYAN_FALSE);
  ZydisFormatterSetProperty(&formatter, ZYDIS_FORMATTER_PROP_ADDR_PADDING_ABSOLUTE, 0);
  const void *hook = nasm_typecast;
  ZydisFormatterSetHook(&formatter, ZYDIS_FORMATTER_FUNC_PRINT_TYPECAST, &hook);
  original_typecast = hook;
  hook = nasm_memory;
  ZydisFormatterSetHook(&formatter, ZYDIS_FORMATTER_FUNC_FORMAT_OPERAND_MEM, &hook);
  original_memory = hook;
  ZydisDecodedInstruction instruction;
  ZydisDecodedOperand operands[ZYDIS_MAX_OPERAND_COUNT];
  uint32_t count = 0;
  for (uint32_t offset=0; offset<length; ++count) {
    offset += ZYAN_SUCCESS(ZydisDecoderDecodeFull(&decoder,bytes+offset,length-offset,&instruction,operands)) ? instruction.length : 1;
  }
  result.records = calloc(count, sizeof(Record));
  uint32_t capacity = count * 32 + 1;
  result.text = malloc(capacity);
  if (!result.records || !result.text) { release_decoded(); return NULL; }
  for (uint32_t offset=0; offset<length; ++result.count) {
    Record *r = &result.records[result.count];
    char text[192];
    r->address = address + offset;
    if (!ZYAN_SUCCESS(ZydisDecoderDecodeFull(&decoder,bytes+offset,length-offset,&instruction,operands))) {
      r->length = 1; r->flags = 16;
      snprintf(text,sizeof(text),"db 0x%02x",bytes[offset]);
    } else {
      r->length = instruction.length;
      r->mnemonic = (uintptr_t)ZydisMnemonicGetString(instruction.mnemonic);
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
      if (!ZYAN_SUCCESS(ZydisFormatterFormatInstruction(&formatter,&instruction,operands,
          instruction.operand_count_visible,text,sizeof(text),r->address,NULL))) {
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
