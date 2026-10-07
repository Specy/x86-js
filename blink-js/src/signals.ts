import type { X86SignalInfo } from './types'

/**
 * Every Linux signal below the real-time ones, by number, with what a shell prints when one ends a
 * program (glibc's `strsignal()` texts, which bash uses).
 */
const SIGNALS: Record<number, readonly [name: string, description: string]> = {
    1: ['SIGHUP', 'Hangup'],
    2: ['SIGINT', 'Interrupt'],
    3: ['SIGQUIT', 'Quit'],
    4: ['SIGILL', 'Illegal instruction'],
    5: ['SIGTRAP', 'Trace/breakpoint trap'],
    6: ['SIGABRT', 'Aborted'],
    7: ['SIGBUS', 'Bus error'],
    8: ['SIGFPE', 'Floating point exception'],
    9: ['SIGKILL', 'Killed'],
    10: ['SIGUSR1', 'User defined signal 1'],
    11: ['SIGSEGV', 'Segmentation fault'],
    12: ['SIGUSR2', 'User defined signal 2'],
    13: ['SIGPIPE', 'Broken pipe'],
    14: ['SIGALRM', 'Alarm clock'],
    15: ['SIGTERM', 'Terminated'],
    16: ['SIGSTKFLT', 'Stack fault'],
    17: ['SIGCHLD', 'Child exited'],
    18: ['SIGCONT', 'Continued'],
    19: ['SIGSTOP', 'Stopped (signal)'],
    20: ['SIGTSTP', 'Stopped'],
    21: ['SIGTTIN', 'Stopped (tty input)'],
    22: ['SIGTTOU', 'Stopped (tty output)'],
    23: ['SIGURG', 'Urgent I/O condition'],
    24: ['SIGXCPU', 'CPU time limit exceeded'],
    25: ['SIGXFSZ', 'File size limit exceeded'],
    26: ['SIGVTALRM', 'Virtual timer expired'],
    27: ['SIGPROF', 'Profiling timer expired'],
    28: ['SIGWINCH', 'Window changed'],
    29: ['SIGIO', 'I/O possible'],
    30: ['SIGPWR', 'Power failure'],
    31: ['SIGSYS', 'Bad system call'],
}

/** The kernel's first real-time signal; C libraries keep the first two or three for themselves. */
const SIGRTMIN = 32
const SIGRTMAX = 64

/**
 * Names and describes a signal by its Linux number. The real-time signals are named from the
 * kernel's own `SIGRTMIN`, the lower half up from it and the upper half down from `SIGRTMAX`, as
 * `kill -l` lays them out.
 */
export function describeSignal(number: number, code: number): X86SignalInfo {
    const known = SIGNALS[number]
    if (known) return { number, code, name: known[0], description: known[1] }
    if (number >= SIGRTMIN && number <= SIGRTMAX) {
        const name =
            number - SIGRTMIN <= (SIGRTMAX - SIGRTMIN) / 2
                ? number === SIGRTMIN
                    ? 'SIGRTMIN'
                    : `SIGRTMIN+${number - SIGRTMIN}`
                : number === SIGRTMAX
                  ? 'SIGRTMAX'
                  : `SIGRTMAX-${SIGRTMAX - number}`
        return { number, code, name, description: `Real-time signal ${number - SIGRTMIN}` }
    }
    return { number, code, name: `signal ${number}`, description: `Unknown signal ${number}` }
}
