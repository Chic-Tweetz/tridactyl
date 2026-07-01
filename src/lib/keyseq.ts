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
    noShadow?: boolean
    noCancel?: boolean // allow page to see the key event
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
    ["N", "noShadow"],
    ["!", "noCancel"],
])

const bindModifiers = new Map([
    ["R", "repeat"],
    ["U", "keyup"],
    ["D", "keydown"],
    ["P", "press"],
    ["N", "noShadow"],
    ["!", "noCancel"],
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
    press?: boolean
    noShadow?: boolean // allow binds which are prefixes of other binds (eg ":bind <N-g> ..." && ":bind gg", where "N" means "noShadow")
    noCancel?: boolean

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
            press: this.press,
            noShadow: this.noShadow,
            noCancel: this.noCancel,
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
    cancelKeyupsContextual?: string[]
    cancelRepeats?: string[]
    trieNode?: Map<string, any>
    didReset?: boolean
    actions?: string[]
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
        return [prefix.filter(mk => !mk.keyup), rest]
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
export function parse(keyseq: MinimalKey[], trie: Map<string, any>): ParserResponse {
    keyseq = stripOnlyModifiers(keyseq)
    if (keyseq.length === 0) return { keys: [], isMatch: false, trieNode: trie, actions: [] }

    let numericPrefix: MinimalKey[]
    [numericPrefix, keyseq] = splitNumericPrefix(keyseq)

    let cursor: Map<string, any> = trie
    let keys: MinimalKey[] = []

    let didReset = false
    let isMatch = false

    // let perfect = false
    for (const minKey of keyseq) {
        const key = keyEventToString(minKey)
        let next = cursor.get(key)
        // When introducing keyups you'll have to handle them differently
        if (next === undefined) {
            didReset = true
            // if keydown and not explicitly cancelling keyups, then we try again from the trie root
            // if (!minKey.keyup) numericPrefix = []
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

    const numericPrefixStr = numericPrefix.map(k => k.key).join("")
    if (cursor.has("command")) {
        return {
            value: cursor.get("command"),
            exstr: cursor.get("command") + (numericPrefix.length ? " " + numericPrefixStr : ""),
            isMatch,
            numericPrefix: numericPrefix.length ? Number(numericPrefixStr) : undefined,
            keys: cursor.has("noShadow") ? keys : numericPrefix.concat(keys),
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
 *  TODO: sort out inherits/conflicting binds
 *      - if you do a :bind <D-j> ... in normal mode, the visual mode "j" bind will have the "consumeRepeats" property too
 *        I think that's because both binds are created and we overwrite the command with whichever comes last
 *      - what rules should I enforce for that though? We should know that "<D-x>" "<R-x>" and "x" conflict
 *            but whatever priority you give those, you'd still want any inherited key to be overwritten
 *            eg ":bind <D-j> ..." should be overwritten by ":bind --mode=visual j ..."
 *               ":bind j ..."     should be overwritten by ":bind --mode=visual <D-j> ..."
 *            that means you need to do some special config logic here I think :(
 */
export function keyTrie(conf) {
    if (KEYTRIE_CACHE[conf]) return KEYTRIE_CACHE[conf]
    // Eventually we'd replace keymaps altogether I suppose
    // const keymap = keyMap(conf)

    const unwrapInherits = (conf) => {
        // Prevent infinite inherit loops (just in case)
        const mapNames = new Set([conf])

        let confs = [config.get(conf)];

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

    // Unique values only, so we can reset inherited keydown nodes
    const keymaps = unwrapInherits(conf)

    const root = new Map()

    while (keymaps.length) {
        const keymap = keymaps.pop()
        const inheritDepth = keymaps.length
        const iter = (keymap as KeyMap).entries()

        // Trie keys are encoded key strings, values are nodes
        while (true) {
            const next = iter.next()
            if (next.done) break;
            const [keyseq, excmd] = next.value

            let cursor = root

            for (const minKey of keyseq) {
                let enc = keyEventToString(minKey)

                // TODO: separate repeat keyevent property from stickyRepeat node property
                // TODO: separate ALL node properties from keyevent properties
                // <R-x> binds create MinimalKeys with the repeat property, but that's just because I'm lazy
                enc = removeFlagsFromEncodedKeystr(enc, "repeat")

                // TODO: decide on node property priorities/incompatibilities
                //  - should a <P-x> node take priority over an x node? (I think so)
                //  - some things are obviously incompatible: <DU-x>
                //    though that could essentially be interpreted as <P-x> or <D-x><U-x>
                // TODO: improve shadow detection and warning to consider various keydown types
                //  - :bind g ... shadows :bind gg ...
                //  - :bind <D-g> ... also shadows gg and the cmdline should show a warning

                // "Reset" inherited nodes on conflicting keydown binds
                // child nodes are NOT removed
                // This was added due to this specific scenario:
                // :bind <D-j> smoothscrollstart
                // :bind --mode=visual j extendline
                // (visual mode's j wasn't allowed to repeat)
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

                // Repeats:
                // By default, treat as normal keydown
                // Add equivalent repeat triekey pointing to same node
                // <D-x> or <P-x> will prevent repeats so we don't need to add any extra logic
                // eg ":bind <D-x>x" ... won't trigger if holding x, but ":bind xx ..." will
                if (!minKey.keyup) {
                    cursor.set(addFlagsToEncodedKeystr(enc, "repeat"), cursor.get(enc))
                }

                cursor = cursor.get(enc)

                // Usually we'll want to skip shadowed binds
                // The noShadow property lets shadowed binds be triggered
                // ":bind <N-g> one" ":bing gg two" will both work
                if (cursor.has("command") && nodeHasProperty(cursor, "noShadow")) continue

                // TODO: Again, separate node properties from keyevent properties.
                //  - MinimalKey.press is meaningless for key events, it represents means <P-x> type binds
                //    (that means "ignore repeats and keyups for this key press")
                //  - <P-x>/press is another bit of a misnomer, consider something else!
                //  - Similarly, MinimalKey.keydown / <D-x> just means "ignore repeats while x is held"

                // TODO: here's where priorities should be enforced
                //  - should we be adding ignoreKeyupContextual to a node with ignoreKeyupExplicit?
                //    I think not. Added a check for that.
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

                    // TODO: separate node properties from keyevent properties
                    //  - MinimalKey.repeat has one meaning for key events and another for <R-x> binds
                    //  - <R-x> means "while the key is held, keep executing the bind"
                    //    add it to the end of a sequence: ":bind ab<R-c> ..."
                    if (minKey.repeat && minKey === keyseq[keyseq.length - 1] && keyseq.length > 1) {
                        addPropertyToNode(cursor, "stickyRepeat", "noShadow")

                        // stickyRepeats need to let repeats through (obviously!)
                        // but also must let keyups through so the sticky node is
                        // exited when releasing the key
                        removePropertyFromNode(cursor, "ignoreRepeats", "ignoreKeyupExplicit", "ignoreKeyupContextual")

                        // Make repeats point to the same node so holding
                        // the key keeps matching and executing the command
                        cursor.set(addFlagsToEncodedKeystr(enc, "repeat", cursor), cursor)
                    }
                }
                // Key event passthrough (page receives event, suggest careful use with :bindurl)
                if (minKey.noCancel) {
                    addPropertyToNode(cursor, "noCancel")
                }
            }

            cursor.set("command", excmd)

            // noShadow binds, eg :bind <N-g> ...
            // will trigger without blocking gg
            if (keyseq[keyseq.length - 1].noShadow) {
                addPropertyToNode(cursor, "noShadow")
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
