/**
 * `@specy/x86/compiler-output`: GCC's `-masm=intel` x86-64 output translated to NASM 3.00 source
 * that the Core assembles and links like hand-written Files, with provenance for every line. Pure
 * TypeScript: nothing here loads WebAssembly, so it runs in Node, browsers and workers alike.
 */
export { GCC_INTEL_V1 } from './profile'
export { translateCompilerOutput } from './translate'
export type {
    CompilerLocation,
    SymbolSummary,
    TranslatedLine,
    TranslatedSymbol,
    TranslationDiagnostic,
    TranslationDiagnosticCode,
    TranslationOptions,
    TranslationProfile,
    TranslationProfileId,
    TranslationResult,
} from './types'
