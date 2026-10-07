// The system calls the committed configuration turns on, each held to what Linux does: every
// probe runs in the Core and, on x86-64 Linux, natively, and both must return the values written
// here. `expectCore` marks what this host cannot show, such as a process running as root, or
// what varies with the host's kernel; each says which Linux behaviour its values stand for.
import { describe, expect, it } from 'vitest'
import {
    EBADF,
    EEXIST,
    EINVAL,
    ENOENT,
    EOPNOTSUPP,
    EPERM,
    ESRCH,
    NO_SUCH_PID,
    expectCore,
    expectLinux,
} from './linux-probe'

const MiB = 1024 * 1024
const RLIM_INFINITY = -1

describe('brk', () => {
    it('moves the break exactly where it is asked, never below the heap or within a page of a mapping', async () => {
        await expectLinux(
            [
                'sys 12, 0',
                'mov r12, rax',
                'lea rdi, [r12 + 1]', 'sys 12, rdi', 'sub rax, r12', 'save', // not rounded to a page
                'lea rdi, [r12 + 8292]', 'sys 12, rdi', 'sub rax, r12', 'save',
                'mov byte [r12 + 8000], 7', 'movzx eax, byte [r12 + 8000]', 'save', // the pages are there
                'sys 12, 0', 'sub rax, r12', 'save',
                'lea rdi, [r12 - 4096]', 'sys 12, rdi', 'sub rax, r12', 'save', // below the heap: refused
                'sys 12, 0x1000', 'sub rax, r12', 'save',
                'sys 12, r12', 'sub rax, r12', 'save', // back to where it started
                'lea rdi, [r12 + 100]', 'sys 12, rdi', 'sub rax, r12', 'save',
                'mov rdi, -4096', 'sys 12, rdi', 'sub rax, r12', 'save', // past the address space: refused
                // mmap(r12 + 64 KiB, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED)
                'lea rdi, [r12 + 0x10000]', 'sys 9, rdi, 4096, 3, 0x32, -1, 0', 'sub rax, r12', 'save',
                'lea rdi, [r12 + 0xf001]', 'sys 12, rdi', 'sub rax, r12', 'save', // no free page left: refused
                'lea rdi, [r12 + 0xf000]', 'sys 12, rdi', 'sub rax, r12', 'save',
            ],
            [1, 8292, 7, 8292, 8292, 8292, 0, 100, 100, 0x10000, 100, 0xf000],
        )
    })
})

describe('descriptors', () => {
    it('dup3 replaces a descriptor, close-on-exec if asked, and refuses what dup2 would not', async () => {
        await expectLinux(
            [
                'sys 292, 1, 1, 0', 'save', // the same descriptor
                'sys 292, 1, 9, 0', 'save',
                'sys 72, 9, 1', 'save', // F_GETFD
                'sys 292, 1, 9, 0x80000', 'save', // O_CLOEXEC, replacing 9
                'sys 72, 9, 1', 'save',
                'sys 292, 1, 10, 1', 'save', // a flag other than O_CLOEXEC
                'sys 292, 55, 10, 0', 'save',
                'sys 292, 1, -1, 0', 'save',
                'sys 292, 1, 100000000, 0', 'save', // past RLIMIT_NOFILE
            ],
            [EINVAL, 9, 0, 9, 1, EINVAL, EBADF, EBADF, EBADF],
        )
    })

    it('close_range closes or marks a range, and takes CLOSE_RANGE_UNSHARE', async () => {
        await expectLinux(
            [
                'sys 32, 1', 'save', 'sys 32, 1', 'save', 'sys 32, 1', 'save', // 3, 4, 5
                'sys 436, 4, 4, 4', 'save', // CLOSE_RANGE_CLOEXEC
                'sys 72, 4, 1', 'save', 'sys 72, 3, 1', 'save',
                'sys 436, 3, 4, 0', 'save',
                'sys 72, 3, 1', 'save', 'sys 72, 5, 1', 'save',
                'sys 436, 5, 3, 0', 'save', // first above last
                'sys 436, 100, 200, 2', 'save', // CLOSE_RANGE_UNSHARE
                'sys 436, 100, 200, 6', 'save', // CLOSE_RANGE_UNSHARE | CLOSE_RANGE_CLOEXEC
                'sys 436, 100, 200, 8', 'save', // no such flag
                'sys 436, 5, 5, 0', 'save',
                'sys 72, 5, 1', 'save',
                'sys 436, 5000, 6000, 0', 'save', // nothing to close
            ],
            [3, 4, 5, 0, 1, 0, 0, EBADF, 0, EINVAL, 0, 0, EINVAL, 0, EBADF, 0],
        )
    })

    it('FIOCLEX, FIONCLEX and FIONBIO change what fcntl reports', async () => {
        await expectLinux(
            [
                'sys 32, 1', 'mov r12, rax',
                'sys 16, r12, 0x5451, 0', 'save', 'sys 72, r12, 1', 'save', // FIOCLEX, F_GETFD
                'sys 16, r12, 0x5450, 0', 'save', 'sys 72, r12, 1', 'save', // FIONCLEX
                'mov dword [buf], 1', 'sys 16, r12, 0x5421, buf', 'save', // FIONBIO on
                'sys 72, r12, 3', 'and rax, 0x800', 'save', // O_NONBLOCK in F_GETFL
                'mov dword [buf], 0', 'sys 16, r12, 0x5421, buf', 'save',
                'sys 72, r12, 3', 'and rax, 0x800', 'save',
            ],
            [0, 1, 0, 0, 0, 0x800, 0, 0],
        )
    })
})

describe('resource limits', () => {
    it('prlimit64, getrlimit and setrlimit keep a limit and refuse what Linux refuses', async () => {
        await expectLinux(
            [
                'mov qword [buf2], 100', 'mov qword [buf2 + 8], 200',
                'sys 302, 0, 7, buf2, buf', 'save', // RLIMIT_NOFILE
                'sys 97, 7, buf', 'save', 'saveq buf', 'saveq buf + 8',
                'mov qword [buf2], 50', 'mov qword [buf2 + 8], 150',
                'sys 302, 0, 7, buf2, buf', 'save', 'saveq buf', 'saveq buf + 8', // hands back the old one
                'mov qword [buf2], 300', 'mov qword [buf2 + 8], 200',
                'sys 302, 0, 7, buf2, 0', 'save', // soft above hard
                'mov qword [buf2], 100', 'mov qword [buf2 + 8], 2000000',
                'sys 160, 7, buf2', 'save', // above fs.nr_open
                'sys 302, 0, 99, 0, buf', 'save',
                `sys 302, ${NO_SUCH_PID}, 7, 0, buf`, 'save',
                'sys 97, 99, buf', 'save',
            ],
            [0, 0, 100, 200, 0, 100, 200, EINVAL, EPERM, EINVAL, ESRCH, EINVAL],
        )
    })

    it('starts with the limits Linux gives its first process, and lets root raise a hard one', async () => {
        // INIT_RLIMITS, with the two that Linux sizes at boot worked out for 8 GiB of memory.
        const limits: Record<number, [number, number]> = {
            3: [8 * MiB, RLIM_INFINITY], // RLIMIT_STACK, Blink's stack
            4: [0, RLIM_INFINITY], // RLIMIT_CORE
            6: [32768, 32768], // RLIMIT_NPROC
            7: [1024, 4096], // RLIMIT_NOFILE
            8: [8 * MiB, 8 * MiB], // RLIMIT_MEMLOCK
            11: [32768, 32768], // RLIMIT_SIGPENDING
            12: [819200, 819200], // RLIMIT_MSGQUEUE
            13: [0, 0], // RLIMIT_NICE
            14: [0, 0], // RLIMIT_RTPRIO
        }
        await expectCore(
            [
                ...Array.from({ length: 16 }, (_, resource) => [`sys 97, ${resource}, buf`, 'saveq buf', 'saveq buf + 8']).flat(),
                'mov qword [buf2], 1024', 'mov qword [buf2 + 8], 8192',
                'sys 160, 7, buf2', 'save', // root may raise a hard limit
                'sys 105, 1000', // setuid(1000): no longer root
                'mov qword [buf2 + 8], 16384',
                'sys 160, 7, buf2', 'save',
            ],
            [
                ...Array.from({ length: 16 }, (_, resource) => limits[resource] ?? [RLIM_INFINITY, RLIM_INFINITY]).flat(),
                0,
                EPERM,
            ],
        )
    })
})

describe('vectored I/O', () => {
    // pread64 reads 8 bytes from offset 0 and from offset 6 of what the file ends up holding.
    const FILE = ['section .data', 'path: db "probe.txt", 0', 'text: db "0123456789"', 'text2: db "abcd"', 'iov: dq buf, 3, buf2, 4', 'iov2: dq text2, 2, text2 + 2, 2', 'section .text']

    it('preadv, pwritev and their v2 forms read and write like Linux, the offset high half ignored', async () => {
        await expectLinux(
            [
                'sys 2, path, 0x42, 0o644', 'mov r12, rax', // O_RDWR | O_CREAT
                'sys 1, r12, text, 10', 'save',
                'sys 295, r12, iov, 2, 2', 'save', 'saveq buf', 'saveq buf2', // preadv at 2
                'sys 295, r12, iov, 0, 0', 'save', // no vectors
                'sys 295, r12, iov, 2, -1', 'save',
                'sys 327, r12, iov, 2, -1, 0, 0', 'save', // preadv2 at the position, the end
                'sys 8, r12, 0, 0',
                'sys 327, r12, iov, 2, -1, 0, 0', 'save', 'sys 8, r12, 0, 1', 'save', // which moves
                'sys 327, r12, iov, 2, 0, 5, 0', 'save', // the high half of the offset
                'sys 295, r12, iov, 1025, 0', 'save', // past IOV_MAX
                'sys 296, r12, iov2, 2, 1', 'save', 'sys 8, r12, 0, 1', 'save', // pwritev leaves the position
                'sys 328, r12, iov2, 1, 0, 0, 0x10', 'save', 'sys 8, r12, 0, 1', 'save', // RWF_APPEND
                'sys 328, r12, iov2, 1, -1, 0, 0x10', 'save', 'sys 8, r12, 0, 1', 'save', // which moves it at -1
                'sys 328, r12, iov2, 1, 0, 0, 7', 'save', // RWF_HIPRI | RWF_DSYNC | RWF_SYNC
                'sys 17, r12, buf, 64, 0', 'save', 'saveq buf', 'saveq buf + 6',
                'sys 3, r12', 'sys 87, path',
                ...FILE,
            ],
            [
                10, 7, 0x343332n, 0x38373635n, 0, EINVAL, 0, 7, 7, 7, EINVAL, 4, 7, 2, 7, 2, 14, 2, 14,
                // "abbcd56789abab": the last write landed at 0
                0x3736356463626261n, 0x6261626139383736n,
            ],
        )
    })

    it('takes the RWF flags of Linux 6.18 that need nothing these files lack', async () => {
        // Linux 6.18 accepts RWF_NOSIGNAL; it answers EOPNOTSUPP for RWF_NOWAIT, RWF_ATOMIC and
        // RWF_DONTCACHE on a file system without them, and for flags it does not know; it refuses
        // RWF_APPEND with RWF_NOAPPEND. RWF_NOAPPEND writes an O_APPEND file where it is asked to.
        await expectCore(
            [
                'sys 2, path, 0x442, 0o644', 'mov r12, rax', // O_RDWR | O_CREAT | O_APPEND
                'sys 1, r12, text, 10',
                'sys 327, r12, iov, 2, 0, 0, 0x100', 'save', // RWF_NOSIGNAL
                'sys 327, r12, iov, 2, 0, 0, 8', 'save', // RWF_NOWAIT
                'sys 327, r12, iov, 2, 0, 0, 0x40', 'save', // RWF_ATOMIC
                'sys 327, r12, iov, 2, 0, 0, 0x80', 'save', // RWF_DONTCACHE
                'sys 327, r12, iov, 2, 0, 0, 0x40000000', 'save',
                'sys 328, r12, iov2, 1, 0, 0, 0x30', 'save',
                'sys 8, r12, 4, 0',
                'sys 328, r12, iov2, 1, 1, 0, 0x20', 'save', 'sys 8, r12, 0, 1', 'save', // RWF_NOAPPEND at 1
                'sys 328, r12, iov2, 1, -1, 0, 0x20', 'save', 'sys 8, r12, 0, 1', 'save', // at the position
                'sys 1, r12, text2, 1', 'save', // a plain write still appends
                'sys 17, r12, buf, 64, 0', 'save', 'saveq buf', 'saveq buf + 3',
                'sys 3, r12', 'sys 87, path',
                ...FILE,
            ],
            // "0ab3ab6789a": "ab" at 1, then at the position, 4, then a plain write's "a" at the end
            [7, EOPNOTSUPP, EOPNOTSUPP, EOPNOTSUPP, EOPNOTSUPP, EINVAL, 2, 4, 2, 6, 1, 11, 0x3736626133626130n, 0x6139383736626133n],
        )
    })
})

describe('files', () => {
    const NAMES = ['section .data', 'a: db "ra", 0', 'b: db "rb", 0', 'c: db "rc", 0', 'd: db "rd", 0', 'e: db "re", 0', 'section .text']

    it('renameat2 checks the source first, refuses to replace, and exchanges two names', async () => {
        await expectLinux(
            [
                'sys 2, a, 0x41, 0o644', 'sys 3, rax',
                'sys 2, b, 0x41, 0o644', 'mov r12, rax', 'sys 1, r12, b, 1', 'sys 3, r12',
                'sys 316, -100, a, -100, b, 1', 'save', // RENAME_NOREPLACE onto b
                'sys 316, -100, c, -100, b, 1', 'save', // nothing at c
                'sys 316, -100, a, -100, b, 2', 'save', // RENAME_EXCHANGE
                'sys 4, a, buf', 'save', 'saveq buf + 48', // a now holds b's byte
                'sys 4, b, buf', 'save', 'saveq buf + 48',
                'sys 316, -100, a, -100, b, 3', 'save',
                'sys 316, -100, a, -100, b, 6', 'save', // RENAME_EXCHANGE | RENAME_WHITEOUT
                'sys 316, -100, a, -100, a, 2', 'save',
                'sys 316, -100, a, -100, d, 1', 'save',
                'sys 316, -100, d, -100, b, 0x10', 'save',
                'sys 316, -100, d, -100, e, 2', 'save', // nothing at e
                'sys 87, b', 'sys 87, d',
                ...NAMES,
            ],
            [EEXIST, ENOENT, 0, 0, 1, 0, 0, EINVAL, EINVAL, 0, 0, EINVAL, ENOENT],
        )
    })

    it('renameat2 answers RENAME_WHITEOUT as Linux does on a file system without whiteouts', async () => {
        await expectCore(['sys 2, a, 0x41, 0o644', 'sys 3, rax', 'sys 316, -100, a, -100, b, 4', 'save', 'sys 87, a', ...NAMES], [EINVAL])
    })

    it('sendfile copies from an offset or the file position, to a file or to stdout', async () => {
        const core = await expectLinux(
            [
                'sys 2, path, 0x42, 0o644', 'mov r12, rax',
                'sys 1, r12, text, 10',
                'mov qword [off], 2',
                'sys 40, 1, r12, off, 5', 'save', 'saveq off',
                'sys 8, r12, 0, 1', 'save', // the position stays
                'sys 8, r12, 4, 0',
                'sys 40, 1, r12, 0, 3', 'save', 'sys 8, r12, 0, 1', 'save', // and moves without an offset
                'sys 40, 1, r12, 0, 100', 'save',
                'sys 40, 1, r12, 0, 0', 'save',
                'mov qword [off], -1', 'sys 40, 1, r12, off, 1', 'save',
                'sys 2, path, 1, 0', 'mov r13, rax', 'sys 40, 1, r13, 0, 1', 'save', // a write-only input
                'sys 2, path2, 0x41, 0o644', 'mov r14, rax',
                'mov qword [off], 0', 'sys 40, r14, r12, off, 10', 'save', 'saveq off',
                'sys 3, r14', 'sys 4, path2, buf', 'saveq buf + 48',
                'sys 87, path', 'sys 87, path2',
                'section .data', 'path: db "probe.txt", 0', 'path2: db "copy.txt", 0', 'text: db "0123456789"', 'off: dq 0', 'section .text',
            ],
            [5, 7, 10, 3, 7, 3, 0, EINVAL, EBADF, 10, 10, 10],
        )
        expect(core.stdout).toBe('23456456789')
    })

    it('fstatat and fchownat take AT_EMPTY_PATH, for a descriptor or the working directory', async () => {
        await expectLinux(
            [
                'sys 262, 1, empty, buf, 0x1000', 'save',
                'sys 262, -100, empty, buf, 0x1000', 'save', 'mov eax, [buf + 24]', 'and eax, 0xf000', 'save', // S_IFDIR
                'sys 262, 1, empty, buf, 0x1100', 'save', // with AT_SYMLINK_NOFOLLOW too
                'sys 262, 1, empty, buf, 0', 'save', // an empty path without it
                'sys 262, -100, dot, buf, 0x8000', 'save', // a flag fstatat does not take
                'sys 262, -100, dot, buf, 0x800', 'save', // AT_NO_AUTOMOUNT
                'sys 262, -100, dot, buf, 0x400', 'save', // AT_SYMLINK_FOLLOW is not one of them
                'sys 262, -100, dot, buf, 0x2000', 'save', // AT_STATX_FORCE_SYNC is
                'sys 260, 1, empty, -1, -1, 0x1000', 'save',
                'sys 260, -100, empty, -1, -1, 0x1000', 'save',
                'sys 260, -100, dot, -1, -1, 0', 'save',
                'sys 260, -100, dot, -1, -1, 0x400', 'save',
                'section .data', 'empty: db 0', 'dot: db ".", 0', 'section .text',
            ],
            [0, 0, 0x4000, 0, ENOENT, EINVAL, 0, EINVAL, 0, 0, 0, 0, EINVAL],
        )
    })

    it('opens an unnamed file with O_TMPFILE, and keeps O_NOATIME, as fcntl reports', async () => {
        await expectLinux(
            [
                'sys 2, dot, 0o20200002, 0o600', 'save', 'mov r12, rax', // O_TMPFILE | O_RDWR
                'sys 1, r12, dot, 1', 'save',
                'sys 72, r12, 3', 'save', // F_GETFL
                'sys 2, dot, 0o20200000, 0o600', 'save', // read-only
                'sys 2, path, 0o20200002, 0o600', 'save', // no such directory
                'sys 2, dot, 0o20200102, 0o600', 'save', // with O_CREAT
                // O_CLOEXEC | O_NOATIME | O_LARGEFILE | O_APPEND | O_EXCL | O_CREAT | O_RDWR
                'sys 2, path, 0o3102302, 0o644', 'save', 'mov r13, rax',
                'sys 72, r13, 3', 'save', 'sys 72, r13, 1', 'save',
                'sys 72, r13, 4, 0o1000000', 'save', 'sys 72, r13, 3', 'save', // F_SETFL O_NOATIME
                'sys 87, path',
                'section .data', 'dot: db ".", 0', 'path: db "probe.txt", 0', 'section .text',
            ],
            [3, 1, 0x418002, EINVAL, ENOENT, EINVAL, 4, 0x48402, 1, 0, 0x48002],
        )
    })

    it('sync, fsync and fdatasync answer as Linux does for a file and for a pipe or terminal', async () => {
        await expectLinux(['sys 162', 'save', 'sys 74, 1', 'save', 'sys 75, 1', 'save'], [0, EINVAL, EINVAL])
    })
})

describe('the process', () => {
    it('sched_getaffinity checks the size and the pid as Linux does', async () => {
        await expectLinux(
            [
                'sys 204, 0, 8, buf', 'save',
                'sys 204, 0, 9, buf', 'save', // not a multiple of a long
                'sys 204, 0, 4, buf', 'save', // too small
                `sys 204, ${NO_SUCH_PID}, 8, buf`, 'save',
                'sys 204, -1, 8, buf', 'save',
                'sys 39', 'mov rdi, rax', 'sys 204, rdi, 8, buf', 'save',
            ],
            [8, EINVAL, EINVAL, ESRCH, ESRCH, 8],
        )
        await expectCore(['sys 204, 0, 8, buf', 'saveq buf'], [1]) // one cpu
    })

    it('sysinfo describes a machine up since its boot clock started, with free memory', async () => {
        const shape = [
            'sys 99, buf', 'save',
            'mov rax, [buf]', 'cmp rax, 0', 'setg al', 'movzx eax, al', 'save', // uptime
            'mov rax, [buf + 32]', 'cmp rax, [buf + 40]', 'setge al', 'movzx eax, al', 'save', // totalram >= freeram
            'movzx eax, word [buf + 80]', 'cmp eax, 1', 'setge al', 'movzx eax, al', 'save', // procs
            'saved buf + 104', // mem_unit
        ]
        await expectLinux(shape, [0, 1, 1, 1, 1])
        await expectCore(['sys 99, buf', 'saveq buf + 32', 'mov rax, [buf + 40]', 'cmp rax, 0', 'setg al', 'movzx eax, al', 'save'], [8 * 1024 * MiB, 1])
    })

    it('prctl keeps the name, the death signal, dumpability and no_new_privs', async () => {
        await expectLinux(
            [
                'sys 157, 16, buf2', 'save', 'saveq buf2', // PR_GET_NAME: the file's name
                'sys 157, 15, longname', 'save', 'sys 157, 16, buf2', 'save', 'saveq buf2', 'saveq buf2 + 8',
                'sys 157, 38, 1, 0, 0, 0', 'save', 'sys 157, 39, 0, 0, 0, 0', 'save', // PR_SET/GET_NO_NEW_PRIVS
                'sys 157, 38, 2, 0, 0, 0', 'save', 'sys 157, 39, 1, 0, 0, 0', 'save',
                'sys 157, 4, 0', 'save', 'sys 157, 3', 'save', 'sys 157, 4, 2', 'save', // PR_SET/GET_DUMPABLE
                'sys 157, 4, 1', 'save', 'sys 157, 3', 'save',
                'sys 157, 1, 65', 'save', 'sys 157, 1, 64', 'save', 'sys 157, 2, buf', 'save', 'saved buf', // PDEATHSIG
                'sys 157, 25, buf', 'save', 'saved buf', // PR_GET_TSC
                'sys 157, 9999', 'save',
                'section .data', 'longname: db "abcdefghijklmnopqrstuvwxyz", 0', 'section .text',
            ],
            [
                0, 0x6d6172676f7270n, // "program"
                0, 0, 0x6867666564636261n, 0x6f6e6d6c6b6a69n, // the first 15 bytes
                0, 1, EINVAL, EINVAL,
                0, 0, EINVAL, 0, 1,
                EINVAL, 0, 0, 64,
                0, 1, // PR_TSC_ENABLE
                EINVAL,
            ],
        )
    })

    it('arch_prctl sets and reads the segment bases and says cpuid works', async () => {
        await expectLinux(
            [
                'sys 158, 0x1001, 0x1234', 'save', // ARCH_SET_GS
                'sys 158, 0x1004, buf', 'save', 'saveq buf', // ARCH_GET_GS
                'sys 158, 0x1003, buf', 'save', // ARCH_GET_FS
                'sys 158, 0x1011, 0', 'save', // ARCH_GET_CPUID
                'sys 158, 0x9999, 0', 'save',
            ],
            [0, 0, 0x1234, 0, 1, EINVAL],
        )
    })
})

describe('credentials', () => {
    // A process here starts as root, as its host reports, and changes ids by kernel/sys.c's rules;
    // this host runs probes as an ordinary user, so these are held to the rules, not to a run.
    it('a root process may take any ids, and keeps CAP_SETUID while its saved uid is 0', async () => {
        await expectCore(
            [
                'sys 102', 'save', 'sys 107', 'save', 'sys 104', 'save', 'sys 108', 'save',
                'sys 115, 0, 0', 'save', 'sys 115, 16, buf', 'save', 'saved buf', // getgroups: [0]
                'sys 157, 1, 9', // PR_SET_PDEATHSIG
                'sys 117, 1000, 1000, 0', 'save', // setresuid
                'sys 118, buf, buf + 4, buf + 8', 'save', 'saved buf', 'saved buf + 4', 'saved buf + 8',
                'sys 157, 3', 'save', // no longer dumpable once the effective uid changed
                'sys 157, 2, buf', 'saved buf', // and the death signal is forgotten
                'sys 106, 50', 'save', // setgid needs CAP_SETGID
                'sys 116, 0, 0', 'save', // so does setgroups
                'sys 117, -1, 0, -1', 'save', 'sys 107', 'save', // the saved uid takes root back
                'sys 106, 50', 'save', 'sys 120, buf, buf + 4, buf + 8', 'saved buf', 'saved buf + 4', 'saved buf + 8',
                'mov dword [buf], 7', 'mov dword [buf + 4], 3', 'mov dword [buf + 8], 5',
                'sys 116, 3, buf', 'save', 'sys 115, 0, 0', 'save', 'sys 115, 2, buf2', 'save',
                'sys 115, 3, buf2', 'save', 'saved buf2', 'saved buf2 + 4', 'saved buf2 + 8', // kept sorted
                'sys 115, -1, buf2', 'save', 'sys 116, 70000, buf', 'save',
                'sys 105, 2000', 'save', 'sys 118, buf, buf + 4, buf + 8', 'saved buf', 'saved buf + 4', 'saved buf + 8',
                'sys 105, 0', 'save', // all three changed, so root is gone for good
                'sys 113, -1, 2000', 'save', 'sys 113, 3000, -1', 'save', 'sys 105, -1', 'save',
            ],
            [
                0, 0, 0, 0, 1, 1, 0,
                0, 0, 1000, 1000, 0, 0, 0,
                EPERM, EPERM, 0, 0,
                0, 50, 50, 50,
                0, 3, EINVAL, 3, 3, 5, 7,
                EINVAL, EINVAL,
                0, 2000, 2000, 2000,
                EPERM, 0, EPERM, EINVAL,
            ],
        )
    })

    it('setreuid moves the saved uid with the effective one as Linux does', async () => {
        await expectCore(
            [
                'sys 113, 1000, 2000', 'save', 'sys 118, buf, buf + 4, buf + 8', 'saved buf', 'saved buf + 4', 'saved buf + 8',
                'sys 113, -1, 1000', 'save', 'sys 118, buf, buf + 4, buf + 8', 'saved buf', 'saved buf + 4', 'saved buf + 8',
                'sys 113, 2000, -1', 'save', 'sys 118, buf, buf + 4, buf + 8', 'saved buf', 'saved buf + 4', 'saved buf + 8',
            ],
            [0, 1000, 2000, 2000, 0, 1000, 1000, 2000, EPERM, 1000, 1000, 2000],
        )
    })
})

describe('time', () => {
    it('reads, resolves and sleeps on the clocks Linux has', async () => {
        await expectLinux(
            [
                // clock_gettime: MONOTONIC_RAW, REALTIME_COARSE, MONOTONIC_COARSE, BOOTTIME, TAI, two that are not clocks
                ...[4, 5, 6, 7, 11, 12, 10].flatMap((clock) => [`sys 228, ${clock}, buf`, 'save']),
                // clock_getres of the high resolution clocks: a nanosecond
                ...[4, 7, 11, 0, 1, 2].flatMap((clock) => [`sys 229, ${clock}, buf`, 'save', 'saveq buf + 8']),
                'mov qword [buf2], 0', 'mov qword [buf2 + 8], 1000',
                // clock_nanosleep: none on the raw and coarse clocks
                ...[4, 5, 6, 7, 11].flatMap((clock) => [`sys 230, ${clock}, 0, buf2, 0`, 'save']),
            ],
            [0, 0, 0, 0, 0, EINVAL, EINVAL, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, EOPNOTSUPP, EOPNOTSUPP, EOPNOTSUPP, 0, 0],
        )
    })

    it('keeps TAI at the wall clock and the boot clock at the monotonic one, coarse clocks at a 250 Hz tick', async () => {
        // Linux keeps CLOCK_TAI at CLOCK_REALTIME until something sets its TAI offset, and has no
        // timer on CLOCK_THREAD_CPUTIME_ID to sleep on. The alarm clocks read the clocks they wake.
        await expectCore(
            [
                // the same second, or the next one if a second turned between the two reads
                'sys 228, 11, buf', 'sys 228, 0, buf2', 'mov rax, [buf2]', 'sub rax, [buf]', 'cmp rax, 1', 'setbe al', 'movzx eax, al', 'save',
                'sys 228, 7, buf', 'sys 228, 1, buf2', 'mov rax, [buf2]', 'sub rax, [buf]', 'cmp rax, 1', 'setbe al', 'movzx eax, al', 'save',
                'sys 228, 8, buf', 'save', 'sys 228, 9, buf', 'save',
                'sys 229, 5, buf', 'save', 'saveq buf + 8', 'sys 229, 6, buf', 'save', 'saveq buf + 8',
                'mov qword [buf2], 0', 'mov qword [buf2 + 8], 1000', 'sys 230, 3, 0, buf2, 0', 'save',
            ],
            [1, 1, 0, 0, 0, 4000000, 0, 4000000, EOPNOTSUPP],
        )
    })

    it('select writes back the time it did not sleep, and only the fd_set bytes nfds covers', async () => {
        await expectLinux(
            [
                'mov qword [tv], 5', 'mov qword [tv + 8], 0', 'mov qword [wset], 2',
                'sys 23, 2, 0, wset, 0, tv', 'save',
                // what is left, in microseconds: about 5 s, never more
                'imul rax, [tv], 1000000', 'add rax, [tv + 8]', 'sub rax, 4900000', 'cmp rax, 100000', 'setbe al', 'movzx eax, al', 'save',
                'saveq wset', 'saveq guard', // a byte past the 8 nfds covers is left alone
                'mov qword [tv], 0', 'mov qword [tv + 8], 0', 'mov qword [wset], 2',
                'sys 23, 2, 0, wset, 0, tv', 'save', 'saveq tv', 'saveq tv + 8', // a zero timeout stays
                'mov qword [tv], 0', 'mov qword [tv + 8], 20000',
                'sys 23, 0, 0, 0, 0, tv', 'save', 'saveq tv', 'saveq tv + 8', // slept it all
                'mov qword [tv], 0', 'mov qword [tv + 8], 1500000', 'mov qword [wset], 2',
                'sys 23, 2, 0, wset, 0, tv', 'save', 'saveq tv', // microseconds carry into seconds
                'mov qword [tv], 0', 'mov qword [tv + 8], -1',
                'sys 23, 0, 0, 0, 0, tv', 'save',
                'section .data', 'tv: dq 0, 0', 'wset: dq 0', 'guard: dq 0x1122334455667788', 'section .text',
            ],
            [1, 1, 2, 0x1122334455667788n, 1, 0, 0, 0, 0, 0, 1, 1, EINVAL],
        )
    })

    it('gettimeofday fills the timezone it is given', async () => {
        await expectLinux(['sys 96, buf, buf2', 'save', 'saved buf2', 'saved buf2 + 4'], [0, 0, 0])
    })
})
