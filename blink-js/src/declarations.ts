/** A name a unit defines as `ld` indexes it: a definition, or a common symbol. */
export type DeclaredName = { readonly name: string; readonly common: boolean }

/** `global` or `common`, written plainly or as NASM's bracketed primitive, `[global name]`. */
const DIRECTIVE = /^\s*\[?\s*(global|common)\s+(.*?)\s*\]?\s*$/i
/** A label, `name:`, or a name at the start of a line followed by what it names, `name db 1`. */
const LABEL = /^\s*\$?([A-Za-z_?][\w$#@~.?]*)(?=\s*:|\s|$)/
/**
 * A label that local labels after it attach to: one written with a colon, or a name followed by
 * data, a reservation or `times`, which no instruction or directive is. A name `equ` defines is
 * not one, as NASM has it.
 */
const BASE_LABEL = /^\s*\$?([A-Za-z_?][\w$#@~.?]*)\s*(?::(?!\s*equ\b)|\s+(?:d[bwdqtoyz]|res[bwdqtoyz]|times|istruc)\b)/i
/** A local label, `.name`, which NASM defines as the last base label's `base.name`; not `..@` or `..start`. */
const LOCAL_LABEL = /^\s*(\.[A-Za-z_?$#@~][\w$#@~.?]*)(?=\s*:|\s|$)/
/** `struc name` and `endstruc`, which define `name`, its fields as `name.field`, and `name_size`. */
const STRUC = /^\s*struc\s+([A-Za-z_?.][\w$#@~.?]*)/i
const ENDSTRUC = /^\s*endstruc\b/i

/**
 * The names a unit of NASM assembly defines that another unit can be linked to, as a scan of its
 * text reads them before anything assembles it: each name a `global` line declares that the unit
 * also defines, by a label (`name:`, or a name that starts a line, `name db 1`, `name equ 5`), and
 * each `common` symbol, in the order the unit declares them. A name declared `global` and never
 * defined is a reference, as NASM makes it. Comments and quoted text are skipped; a line the scan
 * cannot read declares nothing.
 *
 * Lines a backslash continues are read as one, as NASM reads them. A local label, `.inner`, is the
 * last base label's (`helper.inner`), and a `struc` defines its name, its fields (`point.x`) and
 * `point_size`, written as they are or as `nasm -E` expands them.
 *
 * It reads the text as written, so a `global` a macro writes is found only in the unit's
 * preprocessed text, which is what a unit that uses the preprocessor is scanned in instead.
 */
export function declaredNames(text: string): DeclaredName[] {
    const declared: string[] = []
    const commons = new Set<string>()
    const labels = new Set<string>()
    let base = ''
    let struc = ''
    for (const raw of text.replace(/\\\r?\n/g, '').split(/\r?\n/)) {
        const line = withoutComment(raw)
        if (!line.trim() || /^\s*%/.test(line)) continue
        const structure = STRUC.exec(line)
        if (structure) {
            struc = base = structure[1]!
            labels.add(struc)
            continue
        }
        if (ENDSTRUC.test(line)) {
            if (struc) labels.add(`${struc}_size`)
            struc = ''
            continue
        }
        const directive = DIRECTIVE.exec(line)
        if (directive) {
            const common = directive[1]!.toLowerCase() === 'common'
            for (const item of common ? [directive[2]!] : directive[2]!.split(',')) {
                // `name:function hidden`, `name:weak`, or a common's `name 8:4`
                const name = /^\s*\$?([A-Za-z_?.][\w$#@~.?]*)/.exec(item)?.[1]
                if (!name) continue
                if (common) commons.add(name)
                else declared.push(name)
            }
            continue
        }
        const local = LOCAL_LABEL.exec(line)
        if (local) {
            if (base && !local[1]!.startsWith('..')) labels.add(base + local[1]!)
            continue
        }
        const label = LABEL.exec(line)
        if (label) labels.add(label[1]!)
        const named = BASE_LABEL.exec(line)
        if (named) base = named[1]!
    }
    const names: DeclaredName[] = []
    const seen = new Set<string>()
    for (const name of declared) {
        if (seen.has(name) || !labels.has(name)) continue
        seen.add(name)
        names.push({ name, common: false })
    }
    for (const name of commons) {
        if (seen.has(name)) continue
        seen.add(name)
        names.push({ name, common: true })
    }
    return names
}

/** `extern`, or NASM's `required`, an `extern` it keeps in the object even when nothing uses it. */
const EXTERN = /^\s*\[?\s*(?:extern|required)\s+(.*?)\s*\]?\s*$/i

/**
 * The names a unit's `extern` lines declare, as a scan of its text reads them: what it may need
 * from another unit, for when it cannot be assembled to say so itself. Read as `declaredNames`
 * reads `global`.
 */
export function externNames(text: string): string[] {
    const names = new Set<string>()
    for (const raw of text.replace(/\\\r?\n/g, '').split(/\r?\n/)) {
        const directive = EXTERN.exec(withoutComment(raw))
        if (!directive) continue
        for (const item of directive[1]!.split(',')) {
            const name = /^\s*\$?([A-Za-z_?.][\w$#@~.?]*)/.exec(item)?.[1]
            if (name) names.add(name)
        }
    }
    return [...names]
}
/** The line up to its `;` comment, which a quoted `;` does not start. */
function withoutComment(line: string): string {
    let quote = ''
    for (let i = 0; i < line.length; i++) {
        const c = line[i]!
        if (quote) {
            if (c === '\\' && quote === '`') i++
            else if (c === quote) quote = ''
        } else if (c === '"' || c === "'" || c === '`') quote = c
        else if (c === ';') return line.slice(0, i)
    }
    return line
}
