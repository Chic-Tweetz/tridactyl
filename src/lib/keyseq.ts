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
import { filter, find, izip } from "@src/lib/itertools"
import { Parser } from "@src/lib/nearley_utils"
import * as config from "@src/lib/config"
import * as R from "ramda"
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

// Encode usefult key event details to 2 chars and prepend them to the key name
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

// }}}

// {{{ General types

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
])
export class MinimalKey {
    readonly altKey = false
    readonly ctrlKey = false
    readonly metaKey = false
    readonly shiftKey = false
    repeat = false
    translated = false
    keyup = false
    keydown = false // this is less about it being a keydown, more about letting us know that we don't want to cancel the keyup
    // type: string = "keydown" // why have both keyup and type
    code?: string // Can use this to keep track of held keys, even if you press a modifier while they're held

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
                // this.type = "keyup"
            }
            this.code = modifiers.code
        }
    }

    /** Does this key match another MinimalKey */
    public match(keyevent: MinimalKey) {
        if (this.key !== keyevent.key) return false
        for (const [_, attr] of modifiers.entries()) {
            if (this[attr] !== keyevent[attr]) return false
        }
        return true
    }

    public translate(keytranslatemap: { [inkey: string]: string }): MinimalKey {
        let newkey = keytranslatemap[this.key]
        if (newkey === undefined || this.translated) newkey = this.key
        const result = new MinimalKey(newkey, {
            altKey: this.altKey,
            ctrlKey: this.ctrlKey,
            metaKey: this.metaKey,
            shiftKey: this.shiftKey,
            repeat: this.repeat,
            keyup: this.keyup,
            keydown: this.keydown,
            code: this.code,
            // type: this.type,
        })
        result.translated = true
        return result
    }

    public toMapstr() {
        let str = ""
        let needsBrackets = this.key.length > 1

        for (const [letter, attr] of modifiers.entries()) {
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

export type KeyEventLike = MinimalKey | KeyboardEvent

// }}}

// {{{ parser and completions

type MapTarget = string | ((...args: any[]) => any)
type KeyMap = Map<MinimalKey[], MapTarget>

export interface ParserResponse {
    keys?: MinimalKey[]
    value?: string
    exstr?: string
    isMatch?: boolean
    numericPrefix?: number
    cancelKeyups?: string[]
    cancelRepeats?: string[]
    trieNode?: Map<string, any>
}

function splitNumericPrefix(
    keyseq: MinimalKey[],
): [MinimalKey[], MinimalKey[]] {
    // If the first key is in 1:9, partition all numbers until you reach a non-number.
    if (
        !hasModifiers(keyseq[0]) &&
        [1, 2, 3, 4, 5, 6, 7, 8, 9].includes(Number(keyseq[0].key))
    ) {
        const prefix = [keyseq[0]]
        for (const ke of keyseq.slice(1)) {
            if (
                !hasModifiers(ke) &&
                [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].includes(Number(ke.key))
            )
                prefix.push(ke)
            else break
        }
        const rest = keyseq.slice(prefix.length)
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

export function parse(keyseq: MinimalKey[], map: KeyMap): ParserResponse {
    // Remove bare modifiers
    keyseq = stripOnlyModifiers(keyseq)

    // If the keyseq is now empty, abort.
    if (keyseq.length === 0) return { keys: [], isMatch: false }

    // Split into numeric prefix and non-numeric suffix
    let numericPrefix: MinimalKey[]
    ;[numericPrefix, keyseq] = splitNumericPrefix(keyseq)

    // If keyseq is a prefix of a key in map, proceed, else try dropping keys
    // from keyseq until it is empty or is a prefix.
    let possibleMappings = completions(keyseq, map)
    while (possibleMappings.size === 0 && keyseq.length > 0) {
        keyseq.shift()
        numericPrefix = []
        possibleMappings = completions(keyseq, map)
    }

    if (possibleMappings.size > 0) {
        // Check if any of the mappings is a perfect match (this will only
        // happen if some sequences in the KeyMap are prefixes of other seqs).
        try {
            const perfect = find(
                possibleMappings,
                ([k, _v]) => k.length === keyseq.length,
            )
            return {
                value: perfect[1],
                exstr: perfect[1] + numericPrefixToExstrSuffix(numericPrefix),
                isMatch: true,
                numericPrefix: numericPrefix.length
                    ? Number(numericPrefix.map(ke => ke.key).join(""))
                    : undefined,
                keys: [],
            }
        } catch (e) {
            if (!(e instanceof RangeError)) throw e
        }
    }

    // keyseq is the longest suffix of keyseq that is the prefix of a
    // command, numericPrefix is a numeric prefix of that. We want to
    // preserve that whole thing, so concat them back together before
    // returning.
    return { keys: numericPrefix.concat(keyseq), isMatch: keyseq.length > 0 }
}

// Kinda winging it
// MinimalKey would eventually be replaced with pure strings also (probably)
// I'm now thinking we might want to store extra, non-trie-key info
//   eg "repeat OR not repeat" - that can't be encoded and matched (because keyevents will be one or the other)
//   so MinimalKey might instead have encodedKey, allowRepeat, consumeKeyup, consumeRepeats, ... whatever else
// Using MinimalKey to get something working for now
//

// I changed parsing to use a start node (so if you type "gg", the second "g" will already be at the "00g" node)
// Not entirely sure why I felt the need, but it does basically work, except you'll have to repair numeric prefixes
// I added parent keys for trie nodes, so you can walk back to the root to figure out what to display in the mode indicator
// So yes, that's two broken things for essentially no gain? hehe
export function parseTrie(keyseq: MinimalKey[], trie: Map<string, any>, startNode?: Map<string, any>): ParserResponse {
    // keyseq = keyseq.filter(k => modifierKeys.has(k.slice(2)))
    keyseq = stripOnlyModifiers(keyseq)
    if (keyseq.length === 0) return { keys: [], isMatch: false, trieNode: startNode || trie }

    // const numericEndIdx = keyseq.findIndex(k => !/^[0-9]$/.test(k[2]))
    // let numericPrefix = keyseq.slice(0, numericEndIdx === -1 ? 0 : numericEndIdx)
    // keyseq = keyseq.slice(numericPrefix.length)

    let numericPrefix: MinimalKey[]
    ;[numericPrefix, keyseq] = splitNumericPrefix(keyseq)

    // figure startNode could replace keyseq, but would require more tinkering to get that to work
    // controller_content would need to pass the startNode of the last non-terminating match
    // and keyseq would need to start relative to that instead of the root node
    // ... so you wouldn't replace keyseq, no, although you may change it from an array to a single key event?
    let cursor: Map<string, any> = startNode || trie
    let keys: MinimalKey[] = []
    let cancelKeyups: string[] = []
    let cancelRepeats: string[] = []
    // let perfect = false
    for (const minKey of keyseq) {
        const key = keyEventToString(minKey)
        let next = cursor.get(key)
        // When introducing keyups you'll have to handle them differently
        if (next === undefined) {
            // if keyup or repeat, ignore, probably filter out of keys for returning
            /*
            if (isKeyUp(key) || isRepeat(key)) {
                continue
            }
            cursor = next
             */

            // if keydown, then we try again from the trie root
            numericPrefix = []
            next = trie.get(key)
            if (next === undefined) {
                // Shall I let root <U-...> binds work? This might be better (IDK)
                // If we're "consuming" keyups and repeats do we still need this guard?

                // if (minKey.keyup || minKey.repeat) continue

                next = trie
                keys = []
                cancelKeyups = []
                cancelRepeats = []
            } else {
                keys = [minKey]
            }
        } else {
            keys.push(minKey)
        }
        cursor = next

        if (!minKey.keyup && cursor.has("consumeKeyup") && minKey.code) {
            cancelKeyups.push(minKey.code)
        }
        if (!minKey.keyup && cursor.has("consumeRepeats") && minKey.code) {
            cancelRepeats.push(minKey.code)
        }

        if (cursor.has("command")) {
            break
        }
        // if (typeof cursor === "string") {
        //     perfect = true
        //     break
        // }
    }
    // const numericPrefixStr = numericPrefix.reduce((acc, k) => acc + k[2], "")
    const numericPrefixStr = numericPrefix.map(k => k.key).join("")
    if (cursor.has("command")) {
        return {
            value: cursor.get("command"),
            exstr: cursor.get("command") + (numericPrefix.length ? " " + numericPrefixStr : ""),
            isMatch: true,
            numericPrefix: numericPrefix.length ? Number(numericPrefixStr) : undefined,
            keys: numericPrefix.concat(keys),
            cancelKeyups,
            cancelRepeats,
            trieNode: cursor,
        }
    }
    return {
        isMatch: keys.length > 0,
        keys: numericPrefix.concat(keys),
        cancelRepeats,
        cancelKeyups,
        trieNode: cursor,
    }
}

/** True if seq1 is a prefix or equal to seq2 */
function prefixes(seq1: MinimalKey[], seq2: MinimalKey[]) {
    if (seq1.length > seq2.length) {
        return false
    } else {
        for (const [key1, key2] of izip(seq1, seq2)) {
            if (!key2.match(key1)) return false
        }
        return true
    }
}

/** returns the fragment of `map` that keyseq is a valid prefix of. */
export function completions(keyseq: MinimalKey[], map: KeyMap): KeyMap {
    return new Map(
        filter(map.entries(), ([ks, _maptarget]) => prefixes(keyseq, ks)),
    )
}

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
            return [new MinimalKey(expandAliases(key), modifiers), remainder]
        } catch (e) {
            // No valid bracketExpr
            return [new MinimalKey("<"), inputStr.slice(1)]
        }
    } else {
        // No end bracket to match == no valid bracketExpr
        return [new MinimalKey("<"), inputStr.slice(1)]
    }
}

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
export function mapstrToKeyseq(mapstr: string): MinimalKey[] {
    const keyseq: MinimalKey[] = []
    let key: MinimalKey
    // Reduce mapstr by one character or one bracket expression per iteration
    while (mapstr.length) {
        if (mapstr[0] === "<") {
            ;[key, mapstr] = bracketexprToKey(mapstr)
            keyseq.push(key)
        } else {
            keyseq.push(new MinimalKey(mapstr[0]))
            mapstr = mapstr.slice(1)
        }
    }
    return keyseq
}

export function canonicaliseMapstr(mapstr: string): string {
    return mapstrToKeyseq(mapstr)
        .map(k => k.toMapstr())
        .join("")
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

let KEYTRIE_CACHE = {}
/**
 *  Encode keybinds as strings to use as the keys for nested maps.
 *  Key events can be similarly encoded to walk the trie.
 */
export function keyTrie(conf) {
    if (KEYTRIE_CACHE[conf]) return KEYTRIE_CACHE[conf]
    // Eventually we'd replace keymaps altogether I suppose
    const keymap = keyMap(conf)

    const iter = keymap.entries()
    const root = new Map()

    // Trie keys are encoded key strings, values are nodes or an excmd
    while (true) {
        const next = iter.next()
        if (next.done) break;
        const [keyseq, excmd] = next.value

        let cursor = root
        // Hmm, I dunno if this helps much really.
        // let heldKeys: string[] = []

        for (const minKey of keyseq) {
            const enc = keyEventToString(minKey)

            // This lot's probably going to break keyup binds for now (might not do it this way anyway)
            // Key ups and repeats point to same node while key is held (unless keybind says not to - not implemented)
            // We want <D-x> I think, to avoid this (although repeats should still be ignored for <D-x>)
            // if (keyseq[i].keyup) {
            //     heldKeys = heldKeys.filter(key => key !== keyseq[i].key)
            // } else { // if (keyseq[i] IS NOT <D-...> flavour) { ...
            //     heldKeys.push(enc)
            // }

            if (!cursor.has(enc)) cursor.set(enc, new Map())
            cursor.get(enc).set("parent", cursor)

            // Allow non-repeats to trigger repeat binds... neat that's worked.
            if (keyseq[i].repeat) {
                cursor.set(removeFlagsFromEncodedKeystr(enc, "repeat"), cursor.get(enc))
            }

            cursor = cursor.get(enc)

            // Held key repeats/keyups point to same node (elegant? stupid? time will tell)
            // for (const heldKey of heldKeys) {
            //     cursor.set(addFlagsToEncodedKeystr(heldKey, "keyup"), cursor)
            //     cursor.set(addFlagsToEncodedKeystr(heldKey, "repeat"), cursor)
            // }

            // if (typeof cursor === "string") continue; // Shadowed bind

            // shadowed bind - we could actually allow this you know... would that be useful though?
            if (cursor.has("command")) continue

            // Do need a way to allow repeats mind you
            // - No repeats (only thing that'll work now)
            // - Only repeats (any use case for binding to a repeat-only keyevent though?)
            // - Either repeats or no repeats
            if (!minKey.keyup) {
                // So... that might make <R-j> work for example to keep scrolling
                // But I'm not sure tbh
                if (!minKey.repeat) {
                    cursor.set("consumeRepeats", true)
                }
                if (!minKey.keydown) {
                    cursor.set("consumeKeyup", true)
                }
            }
        }
        cursor.set("command", excmd)
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
        // type: keyEvent.type,
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
