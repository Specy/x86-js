import type { TranslationProfile, TranslationProfileId } from './types'

function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child)
        Object.freeze(value)
    }
    return value
}

/**
 * GCC 14.2's x86-64 output under the flag groups below (`docs/design/x86-compiler-assembly-
 * translation-plan.md`, "Input profile"). The optimization levels are the ones the corpus
 * (`tests/fixtures/gcc-intel-v1`) passes at.
 */
export const GCC_INTEL_V1: TranslationProfile = freeze({
    id: 'gcc-intel-v1',
    compiler: { name: 'GCC', version: '14.2', target: 'x86-64' },
    flags: {
        translation: ['-masm=intel', '-fno-pie', '-fno-stack-protector', '-fcf-protection=none', '-fno-verbose-asm'],
        locations: ['-g1'],
        target: ['-march=x86-64', '-mtune=generic'],
        language: {
            c: ['-std=c17'],
            cpp: ['-std=c++17', '-fno-exceptions', '-fno-rtti'],
        },
    },
    optimizations: ['0', '1', '2', '3', 's'],
} as const satisfies TranslationProfile)

/**
 * Rules a pending decision can still change within a profile, kept apart from the profile itself so
 * that switching one is a one-line change here rather than a search through the translator.
 */
export type TranslationRules = {
    /**
     * `.type x, @gnu_unique_object` (gate 7): `'weak-object'` drops it like `@object`, keeping the
     * symbol's `.weak` binding, which is equivalent in a static link, and makes it an error for a
     * symbol that is not `.weak`; `'reject'` makes every one an `unsupported-symbol` error. The
     * corpus capture found GCC writing `.weak x` before every one of 201 occurrences.
     */
    readonly gnuUniqueObject: 'reject' | 'weak-object'
}

const PROFILES: Readonly<Record<TranslationProfileId, { profile: TranslationProfile; rules: TranslationRules }>> =
    freeze({
        'gcc-intel-v1': { profile: GCC_INTEL_V1, rules: { gnuUniqueObject: 'weak-object' } },
    })

/** The profile and its rules for an id; throws for an id this package does not know. */
export function resolveProfile(id: unknown): { profile: TranslationProfile; rules: TranslationRules } {
    if (typeof id !== 'string' || !Object.hasOwn(PROFILES, id)) {
        throw new Error(
            `Unknown compiler-output translation profile ${JSON.stringify(id)}; known profiles: ${Object.keys(PROFILES).join(', ')}`,
        )
    }
    return PROFILES[id as TranslationProfileId]
}
