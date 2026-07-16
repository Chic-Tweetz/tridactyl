/** Key-sequence parser

    If `map` is a Map of `MinimalKey[]` to objects (exstrs or callbacks)
    and `keyseq` is an array of [[MinimalKey]] compatible objects...

     - `parse(keyseq, map)` returns the mapped object and a count OR a prefix
       of `MinimalKey[]` (possibly empty) that, if more keys are pressed, could
       map to an object.
     - `completions(keyseq, map)` returns the fragment of `map` that keyseq is
       a valid prefix of.
     - `mapstrToKeySeq` generates KeySequences for the rest of the API.

    No key sequence in a `map` may be a prefix of another key sequence in that
    map. This is a point of difference from Vim that removes any time-dependence
    in the parser. Vimperator, Pentadactyl, saka-key, etc, all share this
    limitation.

    If a key is represented by a single character then the shift modifier state
    is ignored unless other modifiers are also present.

*/

/** Tries

    Encode keybinds and key events as single strings instead of objects (MinimalKeys).

    This lets us make use of Maps in a more natural way, rather than converting to arrays and filtering etc.

    A keymap might have ["g", "g"] -> "scrollto 0"
    Equivalent trie nodes would be { "g": { "g": { command: "scrollto 0" } } }
    Well, almost. We'll be encoding all essential information about binds/key events and prepending to the key name. So:
    { "00g" -> { "00g" -> { "command" -> "scrollto 0" } } }

    Despite messing about a bit too much, this is... actually working quite well?

*/

/** */
import * as R from "ramda"
import { Parser } from "@src/lib/nearley_utils"
import * as config from "@src/lib/config"
import grammar from "@src/grammars/.bracketexpr.generated"
const bracketexpr_grammar = grammar
const bracketexpr_parser = new Parser(bracketexpr_grammar)

let KEYCODETRANSLATEMAP = {}

// {{{ Single-string key encoding
/* eslint-disable no-bitwise */

// Encode key event details as bits, eventually to convert into a string
// Separated into two consts because typescript casting got out of hand
const rawFlagFns = [
  ["keyup", (ev: KeyEventLike | MinimalKey) =>
    (ev as KeyboardEvent).type === "keyup" || (ev as MinimalKey).keyup
  ],
  ["shiftKey", (ev: KeyEventLike | MinimalKey) =>
    ev.shiftKey && (ev.key.length > 1 || ev.key === " ")
  ],
] as const

const encodeFlagFns: [string, (ev: KeyEventLike | MinimalKey) => boolean, number][] =
  rawFlagFns.map(([name, f], i) => [name, f, 1 << i])

const encodeFlags: [string, number][] = [
  "repeat", // repeats are interesting because we might want to bind both down & repeat, or just repeat, or just down...
  "altKey",
  "ctrlKey",
  "metaKey",
  // "translated", // not something we should match on i don't believe
].map((f, i) => [f, 1 << (i + encodeFlagFns.length)])

const encodeFlagBits: Map<string, number> = new Map(
    encodeFlags.concat(encodeFlagFns.map(([name, _, bit]) => [name, bit]))
)

const ENCODED_FLAGS_BASE = 36
const ENCODED_FLAGS_LENGTH = Math.ceil(
    (encodeFlagFns.length + encodeFlags.length) / Math.log2(ENCODED_FLAGS_BASE)
)

// Just exploring possibilities, may or may not use this
// these flags would be bits higher than for those used when creating trie-keys
// so they can be easily filtered out with a bit mask
const _trieNodeFlags: [string, number][] = [
    "cancelRepeats",
    "cancelKeyup",
].map((name, i) => [name, 1 << (i + encodeFlagFns.length + encodeFlags.length)])

// Encode useful key event details to 2 chars and prepend them to the key name
export function keyEventToString(ev: KeyEventLike) {
    let flags = 0

    for (const [_, f, bit] of encodeFlagFns)
        flags |= f(ev) ? bit : 0

    for (const [flag, bit] of encodeFlags)
        flags |= ev[flag] ? bit : 0

    return flags.toString(ENCODED_FLAGS_BASE).padStart(ENCODED_FLAGS_LENGTH, "0") + ev.key
}

export function encodedKeystrFlagBits(...flagNames) {
    let flags = 0
    for (const flag of flagNames) {
        flags |= (encodeFlagBits.get(flag) || 0)
    }
    return flags
}

export function addFlagsToEncodedKeystr(encodedKeystr, ...flagNames) {
    const flags = parseInt(encodedKeystr.slice(0, ENCODED_FLAGS_LENGTH), ENCODED_FLAGS_BASE) | encodedKeystrFlagBits(...flagNames)
    return flags.toString(ENCODED_FLAGS_BASE).padStart(ENCODED_FLAGS_LENGTH, "0") + encodedKeystr.slice(ENCODED_FLAGS_LENGTH)
}

export function removeFlagsFromEncodedKeystr(encodedKeystr, ...flagNames) {
    const flags = parseInt(encodedKeystr.slice(0, ENCODED_FLAGS_LENGTH), ENCODED_FLAGS_BASE) & ~encodedKeystrFlagBits(...flagNames)
    return flags.toString(ENCODED_FLAGS_BASE).padStart(ENCODED_FLAGS_LENGTH, "0") + encodedKeystr.slice(ENCODED_FLAGS_LENGTH)
}

// Anticipating I'll want something like this eventually
function _encodedKeystrToMinimalKey(enc) {
    const flags = parseInt(enc.slice(0, ENCODED_FLAGS_LENGTH), ENCODED_FLAGS_BASE)
    const key = enc.slice(ENCODED_FLAGS_LENGTH)
    const mods = {}
    encodeFlagFns.forEach(([flag, _, bit]) => mods[flag] = Boolean(flags & bit))
	encodeFlags.forEach(([flag, bit]) => mods[flag] = Boolean(flags & bit))
	return new MinimalKey(key, mods)
}

/* eslint-enable no-bitwise */

// On bitwise operators:
// 1. the same could be achieved with equivalent maths operations
// 2. a similar system could just be to start each key string with a known length string of yes/nos for each modifier
//      - like let's just think about the 4 modifier keys, "l" becomes "0000l" or "acmsl"
//      - Ctrl-l => "1000l" or "Acmdsl" (caps/no caps indicating whether that modifier is active)
//      - benefit of this being that it's readable... maybe underscores or something? "A___l"
//      - could even add a nice little dividing character(s) "AC__-l" "AC..|l"
//  yeah, basically just sayin' there are other ways of encoding key events as string literals
//  and I would be happy to explore other options to avoid disabling linter rules (bit flags just seemed a good fit here)

// }}}

// {{{ General types

// I ought to separate trie-keys from trie-node-properties
export interface KeyModifiers {
    altKey?: boolean
    ctrlKey?: boolean
    metaKey?: boolean
    shiftKey?: boolean
    keyup?: boolean
    type?: string
    repeat?: boolean
    code?: string
    keydown?: boolean
    press?: boolean // here I mean "ignore repeats and keyups for this keypress"
    noReset?: boolean
    noCancel?: boolean // allow page to see the key event
    optional?: boolean
}

// Format modifiers
const modifiers = new Map([
    ["A", "altKey"],
    ["C", "ctrlKey"],
    ["M", "metaKey"],
    ["S", "shiftKey"],
    ["R", "repeat"],
    ["U", "keyup"],
    ["D", "keydown"],
    ["P", "press"],
    ["N", "noReset"],
    ["!", "noCancel"],
    ["?", "optional"],
])

const mapstrModifiers = new Map([...modifiers, ["D", "keydown"], ["U", "keyup"], ["?", "optional"]])

const bindModifiers = new Map([
    ["D", "keydown"],
    ["P", "press"],
    ["N", "noReset"],
    ["!", "noCancel"],
    ["?", "optional"],
    ["R", "repeat"],
])

export class MinimalKey {
    readonly code: string | undefined = undefined // Can use this to keep track of held keys, even if you press a modifier while they're held
    readonly altKey = false
    readonly ctrlKey = false
    readonly metaKey = false
    readonly shiftKey = false

    translated = false

    readonly keyup: boolean = false
    readonly repeat = false // either KeyboardEvent repeat or <R-x> type bind (maybe separate these!)

    constructor(readonly key: string, modifiers?: KeyModifiers) {
        if (modifiers !== undefined) {
            for (const mod of Object.keys(modifiers)) {
                if (
                    this.key.length === 1 &&
                    this.key !== " " &&
                    mod === "shiftKey"
                )
                    continue
                this[mod] = modifiers[mod]
            }
            if (modifiers.type === "keyup" || modifiers.keyup) {
                this.keyup = true
            }
            this.code = modifiers.code
        }
    }

    /** Does this key match another MinimalKey */
    // NB: not symmetric!
    // public match(keyevent: MinimalKey): true | false | "skip" {
    //     const fail = () => (this.optional ? "skip" as const : false)
    //     if (this.key !== keyevent.key) return fail()
    //     for (const [_, attr] of modifiers.entries()) {
    //         if (attr === "shiftKey" && this.key.length === 1) continue
    //         if (this[attr] !== keyevent[attr]) return fail()
    //     }
    //     if (this.keyup !== keyevent.keyup) return fail()
    //     return !(this.keydown && keyevent.repeat)
    // }

    public translate(keytranslatemap: { [inkey: string]: string }): MinimalKey {
        let newkey = keytranslatemap[this.key]
        if (newkey === undefined || this.translated) newkey = this.key
        const result = new MinimalKey(newkey, this as KeyModifiers)
        result.translated = true
        return result
    }

    public toMapstr() {
        let str = ""
        let needsBrackets = this.key.length > 1

        for (const [letter, attr] of mapstrModifiers.entries()) {
            if (this[attr]) {
                str += letter
                needsBrackets = true
            }
        }
        if (str) {
            str += "-"
        }

        let key = this.key
        if (key === " ") {
            key = "Space"
            needsBrackets = true
        }

        // Format the rest
        str += key
        if (needsBrackets) {
            str = "<" + str + ">"
        }

        return str
    }
    public isPrintable() {
        return this.key.length === 1
    }
}

export class TrieKey extends MinimalKey {
    readonly keydown = false // <D-x> not really keydown, more "ignore repeats"
    readonly press = false // <P-x> - ignore repeats and keyup
    readonly noReset = false // <N-x> - don't reset keysequence if matching a command
    readonly noCancel = false // <!-x> - don't cancel keyevents (let page see them)
    readonly optional = false // <?-x>

    // Can pass more than one object so we can use an existing TrieKey as a base then set/unset
    constructor(readonly key: string, ...modifiers: KeyModifiers[]) {
        super(key, modifiers[0])
        for (const mod of bindModifiers.values())
            this[mod] = modifiers[0]?.[mod] || false

        for (let i = 1; i < modifiers.length; ++i) {
            for (const mod of bindModifiers.values()) {
                if (modifiers[i][mod] !== undefined)
                    this[mod] = modifiers[i][mod]
            }
        }
    }
}

export type KeyEventLike = MinimalKey | KeyboardEvent

// }}}

// {{{ parser and completions

type MapTarget = string | ((...args: any[]) => any)
type KeyMap = Map<TrieKey[], MapTarget>

export interface ParserResponse {
    keys?: MinimalKey[]
    value?: string
    exstr?: string
    isMatch?: boolean
    numericPrefix?: number
    didReset?: boolean
    actions?: string[]
}

const isDigit = (d: string) => d.length === 1 && d >= "0" && d <= "9"

const isKeyup = (k: MinimalKey) => k.keyup

function splitNumericPrefix(
    keyseq: MinimalKey[],
): [MinimalKey[], MinimalKey[]] {
    if (
        !hasModifiers(keyseq[0]) &&
        !isKeyup(keyseq[0]) &&
        isDigit(keyseq[0].key) &&
        keyseq[0].key !== "0"
    ) {
        const prefix = [keyseq[0]]
        let skipcount = 0
        for (const ke of keyseq.slice(1)) {
            if (isKeyup(ke)) {
                if (!isDigit(ke.key)) break
                skipcount++
                continue
            }
            if (!hasModifiers(ke) && isDigit(ke.key)) {
                prefix.push(ke)
                skipcount++
            } else break
        }
        const rest = keyseq.slice(skipcount + 1)
        return [prefix, rest]
    } else {
        return [[], keyseq]
    }
}

export function stripOnlyModifiers(keyseq) {
    return keyseq.filter(
        key =>
            !["Control", "Shift", "Alt", "AltGraph", "Meta"].includes(key.key),
    )
}

// function isPerfectMatch(input: MinimalKey[], mapEntry: MinimalKey[]): boolean {
//     let i = 0
//     const remaining = [...mapEntry]
//     while (input[i] !== undefined && remaining.length > 0) {
//         const mapKey = remaining.shift()
//         switch (mapKey.match(input[i])) {
//             case false:
//                 return false
//             case "skip":
//                 continue
//             case true:
//                 i++
//                 break
//         }
//     }
//     return remaining.every(k => k.optional)
// }

/**
 * Between this and controller_content.ts I think I've got most of the logic right for:
 * <D-x> - ignore repeats
 * <P-x> - ignore repeats and keyup
 * <R-x> - while key is held, keep executing bind (use at the end of a seqeuence, ab<R-c>)
 * <N-x> - allow shadowed binds to work eg ":bind <N-a> first" ":bind ab second"
 * <U-x> - keyup
 *
 * Keyup intricacies:
 *
 * For most unadorned binds (:bind abc ...), keyups corresponding to keydowns should behave intuitively:
 * - "gg" won't be broken by releasing g the first time
 * - a "<U-g>" bind" would be triggered after releasing "g" the second time
 * - "g<U-g>" would also work
 *
 * in contrast, sequences with <D-...> keys will be broken when releasing that key:
 * - with both a "<D-g>g" and "<U-g>" bind, the <U-g> bind WOULD trigger after releasing g the first time
 * - in fact <D-g>g wouldn't work because <D-...> also prevents repeats
 *
 * the <P-...> behaviour prevents repeats and keyups:
 * - So "<P-g>g" would work and <U-g> would not trigger after releasing g the first time.
 * - <P-g><P-g> would also prevent <U-g> after releasing g the second time.
 * - holding "g" would not trigger <P-g>g
 *
 */
export function parse(keyseq: MinimalKey[], trie: Map<string, any>, useNumericPrefixes = true): ParserResponse {
    keyseq = stripOnlyModifiers(keyseq)
    if (keyseq.length === 0) return { keys: [], isMatch: false, actions: [] }

    let numericPrefix: MinimalKey[]
    if (useNumericPrefixes) {
        ;[numericPrefix, keyseq] = splitNumericPrefix(keyseq)
    } else {
        numericPrefix = []
    }

    let cursor: Map<string, any> = trie
    let keys: MinimalKey[] = []

    let didReset = false
    let isMatch = false

    for (const minKey of keyseq) {
        const key = keyEventToString(minKey)
        let next = cursor.get(key)

        if (next === undefined) {
            didReset = true
            numericPrefix = []

            next = trie.get(key)
            if (next === undefined) {
                next = trie
                keys = []
                isMatch = false
            } else {
                keys = [minKey]
                isMatch = true
            }
        } else {
            // Don't collect collect repeat keydowns when holding a key for a stickyRepeat node
            if (cursor !== next)
                keys.push(minKey)
            isMatch = true
        }
        cursor = next
    }

    const numericPrefixStr = numericPrefixToExstrSuffix(numericPrefix)
    if (cursor.has("command")) {
        return {
            value: cursor.get("command"),
            exstr: cursor.get("command") + numericPrefixStr,
            isMatch,
            numericPrefix: numericPrefix.length ? Number(numericPrefixStr) : undefined,
            keys: cursor.has("noReset") ? keys : numericPrefix.concat(keys),
            didReset,
            actions: isMatch ? (cursor.get("properties") || []) : []
        }
    }
    return {
        isMatch,
        keys: numericPrefix.concat(keys),
        didReset,
        actions: isMatch ? (cursor.get("properties") || []) : []
    }
}

/** True if seq1 is a prefix or equal to seq2 */
// function prefixes(seq1: MinimalKey[], seq2: MinimalKey[]) {
//     if (seq1.length > seq2.length) {
//         return false
//     } else {
//         let i = 0
//         for (const desired_key of seq2) {
//             if (seq1[i] == undefined) break
//             switch (desired_key.match(seq1[i])) {
//                 case false:
//                     return false
//                 case "skip":
//                     i = i - 1 // if skipped, we want to try the real key again against the next thing in the sequence
//                     break
//                 case true:
//                     break
//             }
//             i = i + 1
//         }
//         return true
//     }
// }

/** returns the fragment of `map` that keyseq is a valid prefix of. */
// export function completions(keyseq: MinimalKey[], map: KeyMap): KeyMap {
//     return new Map(
//         filter(map.entries(), ([ks, _maptarget]) => prefixes(keyseq, ks)),
//     )
// }

// function printableKey(k: MinimalKey, showDirection: boolean) {
//     if (["Control", "Meta", "Alt", "Shift", "OS"].includes(k.key)) return ""

//     let modstr = Array.from(modifiers, ([letter, attr]) => k[attr] ? letter : "").join("")
//     if (showDirection) modstr += k.keyup ? "U" : "D"
//     const result = modstr ? modstr + "-" + k.key : k.key
//     return result.length > 1 ? "<" + result + ">" : result
// }

// export function formatKeysForModeIndicator(
//     keys: MinimalKey[],
//     mapstrs: Iterable<string> = [],
// ) {
//     const showDirection = Array.from(mapstrs)
//         .map(parseMapstr)
//         .some(({ keyseq, hasExplicitDirection }) =>
//             hasExplicitDirection && prefixes(keys, keyseq),
//         )
//     return keys
//         .filter(key => showDirection || !key.keyup)
//         .map(key => printableKey(key, showDirection))
//         .join("")
// }

/** Return the first existing mapstr that would match before mapstr can complete. */
// export function findShadowingMapstr(
//     mapstr: string,
//     existingMapstrs: Iterable<string>,
// ): string | undefined {
//     const keyseq = mapstrToKeyseq(mapstr)
//     const existing = Array.from(existingMapstrs)
//         .filter(existingMapstr => existingMapstr !== mapstr)
//         .map(existingMapstr =>
//             [existingMapstr, mapstrToKeyseq(existingMapstr)] as [
//                 string,
//                 MinimalKey[],
//             ],
//         )

//     for (let i = 1; i <= keyseq.length; i++) {
//         const prefix = keyseq.slice(0, i)
//         for (const [existingMapstr, existingKeyseq] of existing) {
//             if (isPerfectMatch(prefix, existingKeyseq)) return existingMapstr
//         }
//     }
// }

// }}}

// {{{ mapStrToKeySeq stuff

/** Expand special key aliases that Vim provides to canonical values

    Vim aliases are case insensitive.
*/
function expandAliases(key: string) {
    // Vim compatibility aliases
    const aliases = {
        cr: "Enter",
        esc: "Escape",
        return: "Enter",
        enter: "Enter",
        space: " ",
        bar: "|",
        del: "Delete",
        bs: "Backspace",
        lt: "<",
    }
    if (key.toLowerCase() in aliases) return aliases[key.toLowerCase()]
    else return key
}

/** String starting with a `<` to MinimalKey and remainder.

    Bracket expressions generally start with a `<` contain no angle brackets or
    whitespace and end with a `>.` These special-cased expressions are also
    permitted: `<{modifier}<>`, `<{modifier}>>`, and `<{modifier}->`.

    If the string passed does not match this definition, it is treated as a
    literal `<.`

    Backus Naur approximation:

    ```
        - bracketexpr ::= '<' modifier? key '>'
        - modifier ::= 'm'|'s'|'a'|'c' '-'
        - key ::= '<'|'>'|/[^\s<>-]+/
    ```

    See `src/grammars/bracketExpr.ne` for the canonical definition.

    Modifiers are case insensitive.

    Some case insensitive vim compatibility aliases are also defined, see
    [[expandAliases]].

    Compatibility breaks:

    Shift + key must use the correct capitalisation of key:
        `<S-j> != J, <S-J> == J`.

    In Vim `<A-x> == <M-x>` on most systems. Not so here: we can't detect
    platform, so just have to use what the browser gives us.

    Vim has a predefined list of special key sequences, we don't: there are too
    many (and they're non-standard) [1].

    In the future, we may just use the names as defined in keyNameList.h [2].

    In Vim, you're still allowed to use `<lt>` within angled brackets:
        `<M-<> == <M-lt> == <M-<lt>>`
    Here only the first two will work.

    Restrictions:

    It is not possible to map to a keyevent that actually sends the key value
    of any of the aliases or to any multi-character sequence containing a space
    or `>.` It is unlikely that browsers will ever do either of those things.

    [1]: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values
    [2]: https://searchfox.org/mozilla-central/source/dom/events/KeyNameList.h

*/
export function bracketexprToKey(inputStr) {
    if (inputStr.indexOf(">") > 0) {
        try {
            const [[modifiers, key], remainder] =
                bracketexpr_parser.feedUntilError(inputStr)
            return [new TrieKey(expandAliases(key), modifiers), remainder]
        } catch (e) {
            // No valid bracketExpr
            return [new TrieKey("<"), inputStr.slice(1)]
        }
    } else {
        // No end bracket to match == no valid bracketExpr
        return [new TrieKey("<"), inputStr.slice(1)]
    }
}

// const hasDirection = (key: MinimalKey) => key.keyup || key.keydown

/** Generate KeySequences for the rest of the API.

    A map expression is something like:

    ```
    j scrollline 10
    <C-f> scrollpage 0.5
    <C-d> scrollpage 0.5
    <C-/><C-n> mode normal
    ```

    A mapstr is the bit before the space.

    mapstrToKeyseq turns a mapstr into a keySequence that looks like this:

    ```
    [MinimalKey {key: 'j'}]
    [MinimalKey {key: 'f', ctrlKey: true}]
    [MinimalKey {key: 'd', ctrlKey: true}]
    [MinimalKey {key: '/', ctrlKey: true}, MinimalKey {key: 'n', ctrlKey: true}]
    ```

    (All four {modifier}Key flags are actually provided on all MinimalKeys)
*/
export function mapstrToKeyseq(mapstr: string): TrieKey[] {
    const keyseq: TrieKey[] = []
    let key: TrieKey
    // Reduce mapstr by one character or one bracket expression per iteration
    while (mapstr.length) {
        if (mapstr[0] === "<") {
            ;[key, mapstr] = bracketexprToKey(mapstr)
            keyseq.push(key)
        } else {
            keyseq.push(new TrieKey(mapstr[0]))
            mapstr = mapstr.slice(1)
        }
    }
    return keyseq
}

// export function mapstrToKeyseq(mapstr: string): MinimalKey[] {
//     return parseMapstr(mapstr).keyseq
// }

export function canonicaliseMapstr(mapstr: string): string {
    const keyseq = mapstrToKeyseq(mapstr)

    // No optional first or last keys (it wouldn't make sense)
    if (keyseq[0].optional) {
        keyseq[0] = new TrieKey(
            keyseq[0].key,
            keyseq[0],
            { optional: false }
        )
    }
    if (keyseq[keyseq.length - 1].optional) {
        keyseq[keyseq.length - 1] = new TrieKey(
            keyseq[keyseq.length - 1].key,
            keyseq[keyseq.length - 1],
            { optional: false }
        )
    }

    // noReset/stickyRepeat only makes sense for final key
    for (let i = 0; i < keyseq.length - 1; ++i) {
        if (keyseq[i].noReset || keyseq[i].repeat) {
            keyseq[i] = new TrieKey(
                keyseq[i].key,
                keyseq[i],
                { noReset: false, repeat: false }
            )
        }
    }
    return keyseq
        .map(k => k.toMapstr())
        .join("")
}

export function walkKeyTrie(mapstr: string, conf = "nmaps") {
    const keys = mapstrToKeyseq(
        canonicaliseMapstr(mapstr))
        .map(trieKey => removeFlagsFromEncodedKeystr(keyEventToString(trieKey), "stickyRepeat"))
    const matches: any = []
    let node = keyTrie(conf)
    for (const key of keys) {
        if (node.has(key)) {
            node = node.get(key)
            if (node.has("command")) {
                matches.push(
                    {
                        command: node.get("command"),
                        properties: node.get("properties") || [],
                        mapstr: node.get("mapstr"),
                    }
                )
                if (!matches[matches.length - 1].properties.includes("noShadow")) {
                    node = keyTrie(conf)
                }
            }
        } else {
            node = keyTrie(conf)
        }
    }
    return matches
}

export function checkForShadowedBinds(mapstr: string, conf = "nmaps") {
    const clash = walkKeyTrie(mapstr, conf)
        .find(
            match => !match.properties.includes("noShadow") ||
                match.properties.includes("stickyRepeat")
        )?.mapstr || null

    // Overwriting is not the same as being shadowed
    return clash !== mapstr ? clash : null
}

export const commandKey2jsKey = {
    Comma: ",",
    Period: ".",
    Up: "ArrowUp",
    Down: "ArrowDown",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    Space: " ",
}

/*
 * Convert a Commands API shortcut string to a MinimalKey. NB: no error checking done, media keys probably unsupported.
 */
export function mozMapToMinimalKey(mozmap: string): MinimalKey {
    const arr = mozmap.split("+")
    const modifiers = {
        altKey: arr.includes("Alt"),
        ctrlKey: arr.includes("MacCtrl"), // MacCtrl gives us _actual_ ctrl on all platforms rather than splat on Mac and Ctrl everywhere else
        shiftKey: arr.includes("Shift"),
        metaKey: arr.includes("Command"),
    }
    let key = arr[arr.length - 1]
    key = R.propOr(key.toLowerCase(), key, commandKey2jsKey)
    // TODO: support mediakeys: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/commands#Media_keys

    return new MinimalKey(key, modifiers)
}

/*
 * Convert a minimal key to a Commands API compatible bind. NB: no error checking done.
 *
 * Ctrl-key behaviour on Mac may be surprising.
 */
export function minimalKeyToMozMap(key: MinimalKey): string {
    const mozMap: string[] = []
    key.altKey && mozMap.push("Alt")
    key.ctrlKey && mozMap.push("MacCtrl")
    key.shiftKey && mozMap.push("Shift")
    key.metaKey && mozMap.push("Command")
    const jsKey2commandKey = Object.fromEntries(
        Object.entries(commandKey2jsKey).map(([key, value]) => [value, key]),
    )
    mozMap.push(R.propOr(key.key.toUpperCase(), key.key, jsKey2commandKey))
    return mozMap.join("+")
}

/** Convert a map of mapstrs (e.g. from config) to a KeyMap */
export function mapstrMapToKeyMap(mapstrMap: Map<string, MapTarget>): KeyMap {
    const newKeyMap = new Map()
    for (const [mapstr, target] of mapstrMap.entries()) {
        newKeyMap.set(mapstrToKeyseq(mapstr), target)
    }
    return newKeyMap
}

let KEYMAP_CACHE = {}

/**
 * Return a "*maps" config converted into sequences of minimalkeys (e.g. "nmaps")
 */
export function keyMap(conf): KeyMap {
    if (KEYMAP_CACHE[conf]) return KEYMAP_CACHE[conf]

    // Fail silently and pass keys through to page if Tridactyl hasn't loaded yet
    if (!config.INITIALISED) return new Map()

    const mapobj: { [keyseq: string]: string } = config.get(conf)
    if (mapobj === undefined)
        throw new Error(
            "No binds defined for this mode. Reload page with <C-r> and add binds, e.g. :bind --mode=[mode] <Esc> mode normal",
        )

    // Convert to KeyMap
    const maps = new Map(Object.entries(mapobj))
    KEYMAP_CACHE[conf] = mapstrMapToKeyMap(maps)
    return KEYMAP_CACHE[conf]
}

// TODO: consider whether property order is important
// TODO: should we make properties a Set? Sets are iterable and properties should be unique.
function addPropertyToNode(node: Map<string, any>, ...addProperties: string[]) {
    const props = node.get("properties") || []
    for (const property of addProperties)
        if (!props.includes(property))
            props.push(property)
    node.set("properties", props)
}

function removePropertyFromNode(node: Map<string, any>, ...removeProperties: string[]) {
    const props = (node.get("properties") || []).filter(p => !removeProperties.includes(p))
    node.set("properties", props)
}

function nodeHasProperty(node: Map<string, any>, property: string) {
    const props = node.get("properties")
    return props && props.includes(property)
}

let KEYTRIE_CACHE = {}
/**
 *  Encode keybinds as strings to use as the keys for nested maps.
 *  Key events can be similarly encoded to walk the trie.
 *
 *  TODO: decide on node property priorities/incompatibilities
*    - should a <P-x> node take priority over an x node? (I think so)
*    - some things are obviously incompatible: <DU-x>
*      though that could essentially be interpreted as <P-x> or <D-x><U-x>
*   TODO: improve shadow detection and warning to consider various keydown types
*    - :bind g ... shadows :bind gg ...
*    - :bind <D-g> ... also shadows gg and the cmdline should show a warning
 */
export function keyTrie(conf) {
    if (KEYTRIE_CACHE[conf]) return KEYTRIE_CACHE[conf]

    // Get only the binds unique to each keymap (filter out inherited binds)
    const unwrapInherits = (conf) => {
        // Prevent infinite inherit loops (just in case)
        const mapNames = new Set([conf])

        const confs = [config.get(conf)];

        while (
            confs[confs.length - 1]["🕷🕷INHERITS🕷🕷"] &&
            !mapNames.has(confs[confs.length - 1]["🕷🕷INHERITS🕷🕷"])
        ) {
            mapNames.add(confs[confs.length - 1]["🕷🕷INHERITS🕷🕷"])
            confs.push(config.get(confs[confs.length - 1]["🕷🕷INHERITS🕷🕷"]))
            delete confs[confs.length - 2]["🕷🕷INHERITS🕷🕷"]
        }
            for (let i = confs.length - 1; i > 0; --i) {
            const filtering = confs[i - 1]
            const comparing = confs[i]
            confs[i - 1] = Object.fromEntries(
                Object.entries(filtering)
                    .filter(([k, v]) => comparing[k] !== v)
            )
        }

        return confs.map(c => mapstrMapToKeyMap(new Map(Object.entries(c))))
    }

    const keymaps = unwrapInherits(conf)
    const root = new Map()

    while (keymaps.length) {
        const keymap = keymaps.pop()
        const inheritDepth = keymaps.length

        for (const [keyseq, excmd] of keymap) {

            // TODO: sort out conflicts (:bind <D-x> ... shouldn't be allowed to coexist with :bind d ...)
            //   and nonsensical <?-x> or <N-x> positions (<N-x> should only appear at the end)
            // - <N-x> only for the last key is enforced here but not in the config itself
            // - optional key at the end of a sequence should show a warning/prevent the bind from being set
            // - noReset on a key NOT at the end of a sequence should be stripped/ignored
            // - different but incompatible binds should overwrite
            //   eg a<ND-b> should overwrite a<D-b> which should overwrite ab
            // priority shouldn't really matter, conflicting binds should just overwrite with the newest one

            // Set of active node "cursors", lets us add properties to optional nodes if needed
            let active = new Set([root])

            for (const minKey of keyseq) {
                const nextActive: Set<Map<any, any>> = new Set()

                let enc = keyEventToString(minKey)

                // <R-x> binds create MinimalKeys with the repeat property
                // Can either change that or remove the repeat flag here (which is easier!)
                enc = removeFlagsFromEncodedKeystr(enc, "repeat")

                // "Reset" inherited nodes on conflicting keydown binds
                // child nodes are NOT removed
                // This was added due to this specific scenario:
                // :bind <D-j> smoothscrollstart
                // :bind --mode=visual j extendline # not a real command but you get the gist
                // (visual mode's j wasn't allowed to repeat)
                for (let cursor of active) {
                    if (cursor.has(enc)) {
                        if (cursor.get(enc).get("inheritDepth") > inheritDepth) {
                            // Are there any instances where we wouldn't want to remove the repeat node?
                            cursor.delete(addFlagsToEncodedKeystr(enc, "repeat"))
                            cursor.get(enc).delete("properties")
                            cursor.get(enc).set("inheritDepth", inheritDepth)
                        }
                    } else {
                        cursor.set(enc, new Map([["inheritDepth", inheritDepth]]))
                    }

                    // Add equivalent repeat keys for keydowns
                    if (!minKey.keyup)
                        cursor.set(addFlagsToEncodedKeystr(enc, "repeat"), cursor.get(enc))

                    // Multiple active cursors means we're handling optional nodes
                    if (minKey.optional) nextActive.add(cursor)

                    cursor = cursor.get(enc)
                    nextActive.add(cursor)

                    // "noReset" property lets otherwise shadowed binds work: ":bind <N-x> one", ":bind xx two"
                    if (cursor.has("command") && !nodeHasProperty(cursor, "noReset")) continue

                    // stickyRepeat nodes mustn't prevent keyups, we can get stuck in them otherwise
                    if (!nodeHasProperty(cursor, "stickyRepeat")) {
                        if (minKey.press) {
                            addPropertyToNode(cursor, "ignoreRepeats", "ignoreKeyupExplicit")
                            removePropertyFromNode(cursor, "ignoreKeyupContextual")
                        } else if (minKey.keydown) {
                            // keydown is another misnomer, it represents "use the keydown and ignore repeats"
                            addPropertyToNode(cursor, "ignoreRepeats")
                        } else if (!minKey.keyup && !nodeHasProperty(cursor, "ignoreKeyupExplicit")) {
                            addPropertyToNode(cursor, "ignoreKeyupContextual")
                        }

                        // <R-x> means stickyRepeat but is misleadingly represented by the repeat property
                        if (minKey.repeat && minKey === keyseq[keyseq.length - 1] && keyseq.length > 1) {
                            // Repeats -> trigger command, keyup -> exit node
                            cursor.set(addFlagsToEncodedKeystr(enc, "repeat", cursor), cursor)
                            removePropertyFromNode(cursor, "ignoreRepeats", "ignoreKeyupExplicit", "ignoreKeyupContextual")
                            addPropertyToNode(cursor, "stickyRepeat", "noReset")
                        }
                    }
                    // Key event passthrough (page receives event, suggest careful use with :bindurl)
                    if (minKey.noCancel) {
                        addPropertyToNode(cursor, "noCancel")
                    }
                }
                active = nextActive
            }

            for (const cursor of active) {
                cursor.set("command", excmd)
                cursor.set("mapstr", keyseq.reduce((acc, minkey) => acc + minkey.toMapstr(), ""))

                // noReset binds, eg :bind <N-g> ...
                // will trigger without blocking gg
                if (keyseq[keyseq.length - 1].noReset) {
                    addPropertyToNode(cursor, "noReset")
                }
            }
        }
    }
    return KEYTRIE_CACHE[conf] = root
}

// }}}

// {{{ Utility functions for dealing with KeyboardEvents

export function hasModifiers(keyEvent: MinimalKey) {
    return (
        keyEvent.ctrlKey ||
        keyEvent.altKey ||
        keyEvent.metaKey ||
        keyEvent.shiftKey
    )
}

/** shiftKey is true for any capital letter, most numbers, etc. Generally care about other modifiers. */
export function hasNonShiftModifiers(keyEvent: MinimalKey) {
    return keyEvent.ctrlKey || keyEvent.altKey || keyEvent.metaKey
}

function numericPrefixToExstrSuffix(numericPrefix: MinimalKey[]) {
    if (numericPrefix.length > 0) {
        return " " + numericPrefix.map(k => k.key).join("")
    } else {
        return ""
    }
}

/**
 * Convert keyboardEvent to internal type MinimalKey
 * for further use. Key is obtained through layout-independent
 * code if config says so.
 */
export function minimalKeyFromKeyboardEvent(
    keyEvent: KeyboardEvent,
): MinimalKey {
    const modifiers = {
        altKey: keyEvent.altKey,
        ctrlKey: keyEvent.ctrlKey,
        metaKey: keyEvent.metaKey,
        shiftKey: keyEvent.shiftKey,
        repeat: keyEvent.repeat,
        keyup: keyEvent.type === "keyup",
        code: keyEvent.code,
    }

    if (config.get("keyboardlayoutforce") === "true") {
        Object.keys(KEYCODETRANSLATEMAP).length === 0 && updateBaseLayout()
        let newkey = keyEvent.key
        const translation = KEYCODETRANSLATEMAP[keyEvent.code]
        if (translation) newkey = translation[+keyEvent.shiftKey]
        return new MinimalKey(newkey, modifiers)
    }

    const result = new MinimalKey(keyEvent.key, modifiers)

    if (config.get("usekeytranslatemap") === "true") {
        const translationmap = config.get("keytranslatemap")
        return result.translate(translationmap)
    }
    return result
}

/**
 * Convert a MinimalKey to a keystr.
 */
export function PrintableKey(k) {
    let result = k.key
    if (
        result === "Control" ||
        result === "Meta" ||
        result === "Alt" ||
        result === "Shift" ||
        result === "OS"
    ) {
        return ""
    }

    let prefix = ""
    if (k.keyup) {
        prefix += "U"
    }
    if (k.altKey) {
        prefix += "A"
    }
    if (k.ctrlKey) {
        prefix += "C"
    }
    if (k.shiftKey) {
        prefix += "S"
    }
    if (prefix.length > 0) {
        result = prefix + "-" + result
    }
    if (result.length > 1) {
        result = "<" + result + ">"
    }
    return result
}
// }}}

browser.storage.onChanged.addListener(changes => {
    if ("userconfig" in changes) {
        KEYMAP_CACHE = {}
        KEYTRIE_CACHE = {}
}
})

// ideally this would get called via a config.addChangeListener but they are not fired for mysterious reasons
function updateBaseLayout() {
    KEYCODETRANSLATEMAP = R.mergeRight(
        config.keyboardlayouts[config.get("keyboardlayoutbase")],
        config.get("keyboardlayoutoverrides"),
    )
}
