.global _start
.text
_start:
  mov $1, %rax
  mov $2, %rbx
  mov $60, %rax
  xor %rdi, %rdi
  syscall
