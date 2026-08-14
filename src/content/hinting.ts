/** # Hint mode functions
 *
 * This file contains functions to interact with hint mode.
 *
 * If you want to bind them to keyboard shortcuts, be sure to prefix them with "hint.". For example, if you want to bind control-[ to `reset`, use:
 *
 * ```
 * bind --mode=hint <C-[> hint.reset
 * ```
 *
 * Contrary to the main tridactyl help page, this one doesn't tell you whether a specific function is bound to something. For now, you'll have to make do with `:bind` and `:viewconfig`.
 *
 * @packageDocumentation
 */
/** ignore this line */

/** Hint links.

    TODO:

    important
        Connect to input system
        Gluing into tridactyl
    unimportant
        Frames
        Redraw on reflow
*/

import * as DOM from "@src/lib/dom"
import { log } from "@src/lib/math"
import {
    permutationsWithReplacement,
    islice,
    izip,
    map,
} from "@src/lib/itertools"
import { contentState, addContentStateChangedListener } from "@src/content/state_content"
import * as config from "@src/lib/config"
import Logger from "@src/lib/logging"
import * as R from "ramda"

/** @hidden */
const logger = new Logger("hinting")
import * as keyseq from "@src/lib/keyseq"
import * as HUD from "@src/content/hud"

/** Calclate the distance between two segments.
 * @hidden
 * */
function distance(l1: number, r1: number, l2: number, r2: number): number {
    if (l1 < r2 && r1 > l2) {
        return 0
    } else {
        return Math.min(Math.abs(l1 - r2), Math.abs(l2 - r1))
    }
}

/** Simple container for the state of a single frame's hints.
 * @hidden
 * */
class HintState {
    public focusedHint: Hint
    readonly hud = document.createElement("div")
    readonly hudTranslate = document.createElement("div")
    readonly hintHost = document.createElement("div")
    readonly highlightHost: Element | null = null
    readonly outlineHost: Element | null = null

    public selectedHints: Hint[] = []
    public filter = ""
    public textfilter = [""]
    public hintchars = ""
    public filterMode = "flags"
    private filteredHints: Hint[] = []

    constructor(
        public filterFunc: HintFilter,
        public resolve: (x) => void,
        public reject: (x) => void,
        public rapid: boolean,
        private readonly cancelResult: unknown = "",
    ) {
        this.hud.classList.add("TridactylHud", "cleanslate")
        this.hudTranslate.classList.add("TridactylHudTranslation")
        this.hintHost.classList.add("TridactylHintHost")

        const hintstyles = config.get("hintstyles")
        if (hintstyles.overlay !== "none") {
            this.highlightHost = document.createElement("div")
            this.highlightHost.classList.add("TridactylHintHighlightHost")
        }
        if (hintstyles.overlayoutline !== "none") {
            this.outlineHost = document.createElement("div")
            this.outlineHost.classList.add("TridactylHintOutlineHost")
        }
        // we can completely avoid adding classes to the hint elems
        renderState.useHintClass =
            hintstyles.bg === "all" ||
            hintstyles.outline === "all" ||
            hintstyles.fg === "all"
        renderState.useActiveHintClass =
            renderState.useHintClass ||
            hintstyles.bg === "active" ||
            hintstyles.outline === "active" ||
            hintstyles.fg === "active"

        this.hudTranslate.style.translate = `${-window.scrollX}px ${-window.scrollY}px`
    }

    get hints() {
        return this.filteredHints
    }

    removeHiddenHints() {
        this.filteredHints = this.activeHints
    }

    hideFlags() {
        this.hintHost.style.setProperty("display", "none", "important")
    }

    showFlags() {
        this.hintHost.style.removeProperty("display")
    }

    get activeHints() {
        return this.filteredHints.filter(h => !h.hidden)
    }

    /**
     * Remove hinting elements and classes from the DOM
     */
    cleanUpHints() {
        if (this.filteredHints.length === 0) return
        // Remove all hints from the DOM.
        HUD.removeElement(this.hud)

        // Undo any alterations of the hinted elements
        for (const hint of this.hints) {
            hint.hidden = true
        }

        this.filteredHints = []
    }

    resolveHinting() {
        this.cleanUpHints()

        if (this.rapid) {
            this.resolve(this.selectedHints.map(h => h.result))
        } else
            this.resolve(
                this.selectedHints[0] ? this.selectedHints[0].result : this.cancelResult,
            )
    }

    // move overlapping hints around
    deOverlap() {
        this.hints.sort((a, b) => a.y - b.y)
        const visited: Hint[] = []
        for (const h of this.hints) {
            for (const vh of visited) {
                if (h.overlapsWith(vh)) {
                    if (vh.x + vh.width < h.rect.right) h.x = vh.x + vh.width
                    else h.y = vh.y + vh.height
                }
            }
            visited.push(h)
        }
    }

    changeFocusedHintIndex(offset) {
        const activeHints = this.activeHints
        if (!activeHints.length) {
            return
        }

        // Get the index of the currently focused hint
        const focusedIndex = activeHints.indexOf(this.focusedHint)

        // Unfocus the currently focused hint
        this.focusedHint.focused = false

        // Focus the next hint, accounting for negative wraparound
        const nextFocusedIndex =
            (focusedIndex + offset + activeHints.length) % activeHints.length
        this.focusedHint = activeHints[nextFocusedIndex]
        this.focusedHint.focused = true
    }

    focusFirstParentHint() {
        let parent = this.focusedHint.target.deref()?.parentElement
        while (parent) {
            const parentHint = this.hints.find(h => h.target.deref() === parent)
            if (parentHint) {
                this.focusedHint.focused = false
                this.focusedHint = parentHint
                this.focusedHint.focused = true
                break
            }
            parent = parent.parentElement
        }
    }

    changeFocusedHintTop() {
        const focusedRect = this.focusedHint.rect

        // Get all hints from the top area
        const topHints = this.activeHints.filter(
            h =>
                h.rect.top < focusedRect.top &&
                h.rect.bottom < focusedRect.bottom,
        )
        if (!topHints.length) {
            return
        }

        // Find the next top hint
        const nextFocusedHint = topHints.reduce((a, b) => {
            const aDistance = distance(
                a.rect.left,
                a.rect.right,
                focusedRect.left,
                focusedRect.right,
            )
            const bDistance = distance(
                b.rect.left,
                b.rect.right,
                focusedRect.left,
                focusedRect.right,
            )
            if (aDistance < bDistance) {
                return a
            } else if (aDistance > bDistance) {
                return b
            } else {
                if (a.rect.bottom < b.rect.bottom) {
                    return b
                } else {
                    return a
                }
            }
        })

        // Unfocus the currently focused hint
        this.focusedHint.focused = false

        // Focus the next hint
        this.focusedHint = nextFocusedHint
        this.focusedHint.focused = true
    }

    changeFocusedHintBottom() {
        const focusedRect = this.focusedHint.rect

        // Get all hints from the bottom area
        const bottomHints = this.activeHints.filter(
            h =>
                h.rect.top > focusedRect.top &&
                h.rect.bottom > focusedRect.bottom,
        )
        if (!bottomHints.length) {
            return
        }

        // Find the next bottom hint
        const nextFocusedHint = bottomHints.reduce((a, b) => {
            const aDistance = distance(
                a.rect.left,
                a.rect.right,
                focusedRect.left,
                focusedRect.right,
            )
            const bDistance = distance(
                b.rect.left,
                b.rect.right,
                focusedRect.left,
                focusedRect.right,
            )
            if (aDistance < bDistance) {
                return a
            } else if (aDistance > bDistance) {
                return b
            } else {
                if (a.rect.top > b.rect.top) {
                    return b
                } else {
                    return a
                }
            }
        })

        // Unfocus the currently focused hint
        this.focusedHint.focused = false

        // Focus the next hint
        this.focusedHint = nextFocusedHint
        this.focusedHint.focused = true
    }

    changeFocusedHintLeft() {
        const focusedRect = this.focusedHint.rect

        // Get all hints from the left area
        const leftHints = this.activeHints.filter(
            h =>
                h.rect.left < focusedRect.left &&
                h.rect.right < focusedRect.right,
        )
        if (!leftHints.length) {
            return
        }

        // Find the next left hint
        const nextFocusedHint = leftHints.reduce((a, b) => {
            const aDistance = distance(
                a.rect.top,
                a.rect.bottom,
                focusedRect.top,
                focusedRect.bottom,
            )
            const bDistance = distance(
                b.rect.top,
                b.rect.bottom,
                focusedRect.top,
                focusedRect.bottom,
            )
            if (aDistance < bDistance) {
                return a
            } else if (aDistance > bDistance) {
                return b
            } else {
                if (a.rect.right < b.rect.right) {
                    return b
                } else {
                    return a
                }
            }
        })

        // Unfocus the currently focused hint
        this.focusedHint.focused = false

        // Focus the next hint
        this.focusedHint = nextFocusedHint
        this.focusedHint.focused = true
    }

    changeFocusedHintRight() {
        const focusedRect = this.focusedHint.rect

        // Get all hints from the right area
        const rightHints = this.activeHints.filter(
            h =>
                h.rect.left > focusedRect.left &&
                h.rect.right > focusedRect.right,
        )
        if (!rightHints.length) {
            return
        }

        // Find the next right hint
        const nextFocusedHint = rightHints.reduce((a, b) => {
            const aDistance = distance(
                a.rect.top,
                a.rect.bottom,
                focusedRect.top,
                focusedRect.bottom,
            )
            const bDistance = distance(
                b.rect.top,
                b.rect.bottom,
                focusedRect.top,
                focusedRect.bottom,
            )
            if (aDistance < bDistance) {
                return a
            } else if (aDistance > bDistance) {
                return b
            } else {
                if (a.rect.left > b.rect.left) {
                    return b
                } else {
                    return a
                }
            }
        })

        // Unfocus the currently focused hint
        this.focusedHint.focused = false

        // Focus the next hint
        this.focusedHint = nextFocusedHint
        this.focusedHint.focused = true
    }

    // Attempt to make the next hint the same as the previous one
    shiftHints() {
        // Pages often have their "interesting" hints separated by the same
        // amount of "uninteresting" hints. We can use this to try to predict
        // what the next interesting hint will be and provide the same hint
        // name as the previous one, so that the user can keep on pressing the
        // same key in order to select all interesting hints.

        // To do this, compute the number of hints between the last selected
        // hint and the hint selected before it
        const lastIndex = this.hints.indexOf(
            this.selectedHints[this.selectedHints.length - 1],
        )
        const prevIndex = this.hints.indexOf(
            this.selectedHints[this.selectedHints.length - 2],
        )
        const distance = lastIndex - prevIndex

        if (distance > 0) {
            // Then, shift the hint names "forward". This requires saving the
            // last N hints (the ones that will end up at the beginning of the
            // hint array).
            const savedNames = []
            for (let i = 0; i < distance; ++i) {
                savedNames.push(this.hints[this.hints.length - 1 - i].name)
            }

            // Actually shift the names.
            for (let i = this.hints.length - 1; i >= distance; --i) {
                this.hints[i].setName(this.hints[i - distance].name)
            }

            // Set the names that should go at the beginning
            for (let i = savedNames.length - 1; i >= 0; --i) {
                this.hints[i].setName(savedNames[i])
            }
        } else if (distance < 0) {
            // Then, shift the hint names "backward". This requires saving the
            // first N hints (the ones that will end up at the end of the hint
            // array).
            const savedNames = []
            for (let i = 0; i < Math.abs(distance); ++i) {
                savedNames.push(this.hints[i].name)
            }

            // Actually shift the names.
            for (let i = 0; i < this.hints.length + distance; ++i) {
                this.hints[i].setName(this.hints[i - distance].name)
            }

            // Set the names that should go at the end
            for (let i = 0; i < savedNames.length; ++i) {
                this.hints[this.hints.length + distance + i].setName(
                    savedNames[i],
                )
            }
        }
        this.changeFocusedHintIndex(distance)

        // All done!
    }
}

/** @hidden*/
export let modeState: HintState

interface Hintables {
    elements: Element[]
    hintclasses?: string[]
}

// Creating/removing elements tends to be in DocumentFragments or the entire HUD element
// but perhaps we can batch class changes in an animation frame request
const renderState = {
    useHintClass: false,
    useActiveHintClass: false,
    isRenderQueued: false,
    hintsVisibility: [],
    updateHintPositions: false,
    pushHintsVisibility: hint => {
        renderState.hintsVisibility.push(hint)
        render()
    },
    reposition: () => {
        renderState.updateHintPositions = true
        render()
    },
}

function render() {
    if (renderState.isRenderQueued) return
    renderState.isRenderQueued = true
    requestAnimationFrame(() => {
        if (renderState.updateHintPositions) {
            modeState?.highlightHost?.remove()
            modeState?.outlineHost?.remove()
            modeState?.highlightHost?.replaceChildren()
            modeState?.outlineHost?.replaceChildren()

            for (const hint of modeState.activeHints) {
                hint.calculateGeometry()
            }

            if (modeState.focusedHint) modeState.focusedHint.focused = true
        }

        if (renderState.hintsVisibility.length) {
            for (const hint of renderState.hintsVisibility) {
                hint.flag.hidden = hint.hidden
                if (hint.hidden) {
                    if (renderState.useHintClass)
                        hint.target.deref()?.classList?.remove("TridactylHintElem")
                    hint.highlight?.setAttribute("hidden", "")
                    hint.outline?.setAttribute("hidden", "")
                } else {
                    if (renderState.useHintClass)
                        hint.target.deref()?.classList?.add("TridactylHintElem")
                    hint.highlight?.removeAttribute("hidden")
                    hint.outline?.removeAttribute("hidden")
                }
            }
            renderState.hintsVisibility = []
        }

        if (renderState.updateHintPositions) {
            if (modeState.outlineHost)
                modeState.hudTranslate.prepend(modeState.outlineHost)
            if (modeState.highlightHost)
                modeState.hudTranslate.prepend(modeState.highlightHost)
            modeState.deOverlap()
            renderState.updateHintPositions = false
        }

        renderState.isRenderQueued = false
    })
}

/**
  A convenient javascript interface to hint on specified html elements.
  The return value is a promise resolving to the selected element,
  or an AsyncIterator resolving to the selected elements in rapid mode.

  Example usage:

  `tri.hinting_content.hintElements(...).then(element => {tri.dom.simulateClick(element))`

  `for (await e of tri.hinting_content.hintElements(..., {rapid: true}){tri.dom.simulateClick(e)})`

  @param elements a iterator yield html elements
  @param option a option object. The `option.rapid` specify whether hint in rapid mode. Default value is false. The `option.callback` is executed when a hint is selected if specified. The default callback is a no-op.

  @returns promise resolve to the selected element, or a async iterator in rapid mode.
 */
export function hintElements(elements: Element[], option = {}) {
    const hintable = toHintablesArray(Array.from(elements))
    const rapid = option["rapid"] ?? false
    const callback =
        typeof option["callback"] === "function" ? option["callback"] : x => x
    if (!rapid) {
        return new Promise((resolve, reject) => {
            hintPage(hintable, x => x, resolve, reject, rapid)
        }).then(x => {
            callback(x)
            return x
        })
    } else {
        const endDefer = deferCreate()
        const endPromise = endDefer.promise.catch(error => error)
        let onSelect = deferCreate()
        const key = Symbol("select-result")
        const hintCallback = element => {
            callback(element)
            onSelect.resolve({ [key]: element })
            onSelect = deferCreate()
        }
        const wrap = async function* () {
            while (true) {
                const first = await Promise.race([onSelect.promise, endPromise])
                if (first && typeof first === "object" && key in first) {
                    yield first[key]
                } else return await endPromise
            }
        }
        const result = wrap()
        hintPage(
            hintable,
            hintCallback,
            endDefer.resolve,
            endDefer.reject,
            rapid,
        )
        return result
    }
    function deferCreate() {
        const defer = {
            resolve: null,
            reject: null,
            promise: null,
        }
        defer.promise = new Promise((ok, no) => {
            defer.resolve = ok
            defer.reject = no
        })
        return defer
    }
}

const repositionDebounced = (() => {
    let timeout = null
    return function() {
        clearTimeout(timeout)
        timeout = setTimeout(reposition, 200)
    }
})()

/** For each hintable element, add a hint
 * @hidden
 * */
export function hintPage(
    hintableElements: Hintables[],
    onSelect: HintSelectedCallback,
    resolve: (x?) => void = () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    reject: (x?) => void = () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    rapid: boolean | "rehint" = false,
    cancelResult: unknown = "",
) {
    reset() // Tidy up in case any previous hinting wasn't exited cleanly
    const buildHints: HintBuilder = defaultHintBuilder()
    const filterHints: HintFilter = defaultHintFilter()
    contentState.mode = "hint"
    if (rapid === "rehint") rapid = false
    modeState = new HintState(filterHints, resolve, reject, rapid, cancelResult)

    if (!rapid) {
        buildHints(hintableElements, hint => {
            const state = modeState
            state.cleanUpHints()
            hint.result = onSelect(hint.target.deref())
            state.selectedHints.push(hint)
            if (modeState === state) reset()
        })
    } else {
        buildHints(hintableElements, hint => {
            const state = modeState
            hint.result = onSelect(hint.target.deref())
            state.selectedHints.push(hint)
            state.textfilter = [""]
            state.filterMode = "flags"
            state.showFlags()
            if (
                state.selectedHints.length > 1 &&
                config.get("hintshift") === "true"
            ) {
                state.shiftHints()
            }
            removeFilteredCharClass(state)
            setTimeout(reposition, 250)
        })
    }

    if (!modeState.hints.length) {
        // No more hints to display
        reset()
        return
    }
    modeState.hints.forEach(hint => (hint.hidden = false))

    // There are multiple hints. Normally we would just show all of them, but
    // we try to be clever here. Automatically select the first one if all the
    // conditions are true:
    //  - it is <a>
    //  - its href is not empty (does not point to the page itself)
    //  - its href is not javascript
    //  - all the remaining hints
    //      - are either _not_ <a>
    //      - or their href points to the sampe place as first one

    const firstTarget = modeState.hints[0].target.deref()

    const firstTargetIsSelectable = (): boolean =>
        firstTarget instanceof HTMLAnchorElement &&
        firstTarget.href !== "" &&
        !firstTarget.href.startsWith("javascript:")

    const allTargetsAreEqual = (): boolean =>
        undefined ===
        modeState.hints.find(
            h =>
                !(h.target.deref() instanceof HTMLAnchorElement) ||
                (h.target.deref() as HTMLAnchorElement).href !== (firstTarget as HTMLAnchorElement).href,
        )

    if (
        (modeState.hints.length == 1 ||
            (firstTargetIsSelectable() && allTargetsAreEqual())) &&
        config.get("hintautoselect") === "true"
    ) {
        // There is just a single link or all the links point to the same
        // place. Select it unless `hintautoselect` is set to `false`.
        const state = modeState
        state.hints[0].select()
        state.cleanUpHints()
        if (modeState === state) reset()
        return
    }

    // Just focus first link
    modeState.focusedHint = modeState.hints[0]
    modeState.focusedHint.focused = true

    if (modeState.highlightHost)
        modeState.hudTranslate.appendChild(modeState.highlightHost)
    if (modeState.outlineHost)
        modeState.hudTranslate.appendChild(modeState.outlineHost)
    modeState.hudTranslate.appendChild(modeState.hintHost)
    modeState.hud.appendChild(modeState.hudTranslate)

    HUD.addElement(modeState.hud, { popover: true })

    // document.documentElement.appendChild(modeState.hud)
    // const hud = modeState.hud as any
    // if (typeof hud.showPopover === "function") {
    //     hud.setAttribute("popover", "manual")
    //     hud.showPopover()
    // }

    modeState.deOverlap()
    window.removeEventListener("scroll", updateHudOffset)
    window.addEventListener("scroll", updateHudOffset)
    window.removeEventListener("resize", repositionDebounced)
    window.addEventListener("resize", repositionDebounced)
}

function updateHudOffset() {
    window.requestAnimationFrame(() => {
        modeState.hudTranslate.style.translate = `${-window.scrollX}px ${-window.scrollY}px`
    })
    repositionDebounced()
}

/** @hidden */
function defaultHintBuilder() {
    switch (config.get("hintfiltermode")) {
        case "simple":
            return buildHintsSimple
        case "vimperator":
            return buildHintsVimperator
        case "vimperator-reflow":
            return buildHintsVimperator
        case "words":
            return buildHintsWordsDeterministic
        default:
            return buildHintsSimple
    }
}

/** @hidden */
function defaultHintFilter() {
    switch (config.get("hintfiltermode")) {
        case "simple":
            return filterHintsSimple
        case "vimperator":
            return filterHintsVimperator
        case "vimperator-reflow":
            return fstr => filterHintsVimperator(fstr, true)
        case "words":
            return filterHintsWords
    }
}

/** @hidden */
function defaultHintChars() {
    if (config.get("hintnames") === "numeric") {
        return "1234567890"
    }
    if (config.get("hintnames") === "words") {
        return "abcdefghijklmnopqrstuvwxyz" // protect users from changing hintchars and not being able to type the words
    }
    return config.get("hintchars")
}

/** An infinite stream of hints

@hidden
    Earlier hints prefix later hints
*/
function* hintnames_simple(
    hintchars = defaultHintChars(),
): IterableIterator<string> {
    for (let taglen = 1; true; taglen++) {
        yield* map(permutationsWithReplacement(hintchars, taglen), e =>
            e.join(""),
        )
    }
}

/** Shorter hints

    Hints that are prefixes of other hints are a bit annoying because you have
    to select them with Enter or Space. This function returns a stream of hint
    names without any prefixing while keeping the lengths as short as possible,
    by skipping a certain number of the shortest hints from a full stream with
    prefixing.

    Let h be hintchars.length and n be the total number of hints. If n <= h,
    then no hint names need to be skipped. Beyond that, each skipped hint name
    increases the total number of accessible prefix-free hint names by h - 1:
    that hint is lost, but h more are opened up (that hint with each individual
    hint character appended to it in turn).

    The order in which the hints are generated guarantees that when a hint is
    skipped, the ones that are opened up are next in line in the sequence.

    Therefore, the necessary number of skips is the ceiling of the number of
    extra hint names we need, n - h, divided by the number that each skip gives
    us, h - 1.

    @hidden
*/
function* hintnames_short(
    n: number,
    hintchars = defaultHintChars(),
): IterableIterator<string> {
    const source = hintnames_simple(hintchars)
    const num2skip = Math.max(
        0,
        Math.ceil((n - hintchars.length) / (hintchars.length - 1)),
    )
    yield* islice(source, num2skip, n + num2skip)
}

/** Uniform length hintnames
 * @hidden
 * */
function* hintnames_uniform(
    n: number,
    hintchars = defaultHintChars(),
): IterableIterator<string> {
    if (n <= hintchars.length) yield* islice(hintchars[Symbol.iterator](), n)
    else {
        // else calculate required length of each tag
        const taglen = Math.ceil(log(n, hintchars.length))
        // And return first n permutations
        yield* map(
            islice(permutationsWithReplacement(hintchars, taglen), n),
            perm => perm.join(""),
        )
    }
}
/** @hidden */
function* hintnames_numeric(n: number): IterableIterator<string> {
    for (let i = 1; i <= n; i++) {
        yield String(i)
    }
}

/** Common short English words for word hint names.
 * @hidden */
const HINT_WORDS = [
    "ace", "age", "ago", "aid", "aim", "air", "all", "and", "ant", "any",
    "ape", "arc", "ark", "arm", "art", "ash", "ask", "ate", "axe", "bad",
    "bag", "ban", "bar", "bat", "bay", "bed", "bee", "bet", "big", "bin",
    "bit", "bow", "box", "boy", "bud", "bug", "bun", "bus", "but", "cab",
    "can", "cap", "car", "cat", "cop", "cow", "cry", "cub", "cup", "cur",
    "cut", "dab", "dad", "dam", "day", "den", "dew", "did", "dig", "dim",
    "dip", "dog", "dot", "dry", "dub", "dud", "due", "dug", "dye", "ear",
    "eat", "eel", "egg", "ego", "elm", "emu", "end", "era", "eve", "ewe",
    "eye", "fad", "fan", "far", "fat", "fax", "fed", "fee", "fen", "few",
    "fig", "fin", "fir", "fit", "fix", "fly", "fob", "foe", "fog", "fop",
    "for", "fox", "fry", "fun", "fur", "gag", "gap", "gas", "gay", "gel",
    "gem", "get", "gin", "gnu", "god", "got", "gum", "gun", "gut", "guy",
    "gym", "had", "ham", "has", "hat", "hay", "hen", "her", "hew", "hex",
    "hid", "him", "hip", "his", "hit", "hob", "hog", "hop", "hot", "how",
    "hub", "hue", "hug", "hum", "hut", "ice", "icy", "ill", "imp", "ink",
    "inn", "ion", "ire", "irk", "ivy", "jab", "jag", "jam", "jar", "jaw",
    "jay", "jet", "jig", "job", "jog", "jot", "joy", "jug", "jut", "keg",
    "ken", "key", "kid", "kin", "kit", "lab", "lad", "lag", "lap", "law",
    "lay", "lea", "led", "leg", "let", "lid", "lie", "lip", "lit", "log",
    "lot", "low", "lug", "mad", "man", "map", "mar", "mat", "maw", "max",
    "may", "men", "met", "mid", "mix", "mob", "mod", "mom", "mop", "mow",
    "mud", "mug", "nab", "nag", "nap", "net", "new", "nil", "nip", "nit",
    "nod", "nor", "not", "now", "nun", "nut", "oak", "oar", "oat", "odd",
    "ode", "off", "oft", "oil", "old", "one", "opt", "orb", "ore", "our",
    "out", "owe", "owl", "own", "pad", "pal", "pan", "pap", "par", "pat",
    "paw", "pay", "pea", "peg", "pen", "pep", "per", "pet", "pie", "pig",
    "pin", "pit", "ply", "pod", "pop", "pot", "pow", "pro", "pry", "pub",
    "pug", "pun", "pup", "pus", "put", "rag", "ram", "ran", "rap", "rat",
    "raw", "ray", "red", "ref", "rib", "rid", "rig", "rim", "rip", "rob",
    "rod", "roe", "rot", "row", "rub", "rug", "rum", "run", "rut", "rye",
    "sac", "sad", "sag", "sap", "sat", "saw", "say", "sea", "set", "sew",
    "she", "shy", "sin", "sip", "sir", "sis", "sit", "six", "ski", "sky",
    "sly", "sob", "sod", "son", "sop", "sot", "sow", "soy", "spa", "spy",
    "sty", "sub", "sue", "sum", "sun", "sup", "tab", "tad", "tag", "tan",
    "tap", "tar", "tat", "tax", "tea", "ten", "the", "thy", "tie", "tin",
    "tip", "toe", "ton", "too", "top", "tot", "tow", "toy", "try", "tub",
    "tug", "tun", "two", "urn", "use", "van", "vat", "vet", "vex", "via",
    "vie", "vim", "vow", "wad", "wag", "war", "was", "wax", "way", "web",
    "wed", "wet", "who", "why", "wig", "win", "wit", "woe", "wok", "won",
    "woo", "wow", "yak", "yam", "yap", "yaw", "yea", "yes", "yet", "yew",
    "yin", "you", "zap", "zed", "zen", "zig", "zip", "zoo",
]

/** Fisher-Yates shuffle an array (copy). @hidden */
function shuffleArray<T>(arr: T[]): T[] {
    const a = arr.slice()
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
}

/** Random hintnames from a built-in word list.
 * @hidden */
function* hintnames_words(n: number): IterableIterator<string> {
    const shuffled = shuffleArray(HINT_WORDS)
    const wordCount = Math.max(1, Math.ceil(log(n, shuffled.length)))
    yield* map(
        islice(permutationsWithReplacement(shuffled, wordCount), n),
        // Keep neighbouring hints from sharing the same first word.
        words => words.reverse().join(""),
    )
}

/** @hidden */
function* hintnames(
    n: number,
    hintchars = defaultHintChars(),
): IterableIterator<string> {
    switch (config.get("hintnames")) {
        case "numeric":
            yield* hintnames_numeric(n)
        case "uniform":
            yield* hintnames_uniform(n, hintchars)
        case "words":
            yield* hintnames_words(n)
        default:
            yield* hintnames_short(n, hintchars)
    }
}

/** @hidden */
type HintSelectedCallback = (x: any) => any

/** Place a flag by each hintworthy element
@hidden */
class Hint {
    public readonly target: WeakRef<Element>
    public readonly flag = document.createElement("span")
    public highlight: HTMLElement | null = null
    public outline: HTMLElement | null = null
    public rect: Omit<ClientRect, "x" | "y" | "toJSON"> = null
    public result: any = null
    private unfilteredName: string

    public width = 0
    public height = 0
    private _x = 0
    private _y = 0

    private _hidden = true
    private _active = true
    private _noRects = false

    constructor(
        target: Element,
        public name: string,
        public readonly filterData: any,
        private readonly onSelect: HintSelectedCallback,
        classes?: string[],
        clientRects?: DOMRectList,
    ) {
        this.target = new WeakRef(target)
        this.unfilteredName = name
        this.calculateGeometry(clientRects)

        // A span for each char so typed chars can be styled differently
        for (const ch of name) {
            const charspan = document.createElement("span")
            charspan.textContent = ch
            this.flag.appendChild(charspan)
        }

        this.flag.className = "TridactylHint"
        if (config.get("hintuppercase") === "true") {
            this.flag.classList.add("TridactylHintUppercase")
        }
        this.flag.classList.add("TridactylHint" + target.tagName)
        classes?.forEach(f => this.flag.classList.add(f))

        modeState.hintHost.appendChild(this.flag)
    }

    public static isHintable(target: Element): boolean {
        return target.getClientRects().length > 0
    }

    setName(n: string) {
        this.unfilteredName = n
        this.name = n
        this.flag.textContent = ""
        for (const ch of n) {
            const charspan = document.createElement("span")
            charspan.textContent = ch
            this.flag.appendChild(charspan)
        }
    }

    restoreName() {
        if (this.name !== this.unfilteredName) this.setName(this.unfilteredName)
    }

    // These styles would be better with pseudo selectors. Can we do custom ones?
    // If not, do a state machine.
    set hidden(hide: boolean) {
        if (hide === this._hidden) return
        this._hidden = hide
        // this.flag.hidden = hide // Hide these in the render loop as well
        if (hide) this.focused = false
        renderState.pushHintsVisibility(this)

        /*
        // Dead elements (e.g. elements that were in a removed iframe) cause errors
        // when accessing their properties.
        // Example: bing.com image search. Click an image to bring up an iframe popup.
        // Hint with that iframe open and select the close button.
        // iframe is removed, but we try to clean up hints that were for elements inside it.
        if (hide) {
            this.focused = false
            this.target.deref()?.classList?.remove("TridactylHintElem")
            this.highlight?.setAttribute("hidden", "")
            this.outline?.setAttribute("hidden", "")
        } else {
            this.target.deref()?.classList?.add("TridactylHintElem")
            this.highlight?.removeAttribute("hidden")
            this.outline?.removeAttribute("hidden")
        }
        */
    }

    get hidden() {
        return this._hidden
    }

    set active(active: boolean) {
        if (this._active !== active) {
            this._active = active
            this.hidden = this._noRects ? true : !active
        }
    }

    get active() {
        return this._active
    }

    set noRects(noRects: boolean) {
        if (this._noRects !== noRects) {
            this._noRects = noRects
            this.hidden = !this._active ? true : noRects
        }
    }

    set focused(focus: boolean) {
        if (focus) {
            if (renderState.useActiveHintClass)
                this.target.deref()?.classList?.add("TridactylHintActive")

            if (renderState.useHintClass)
                this.target.deref()?.classList?.remove("TridactylHintElem")

            if (this.highlight)
                this.highlight.classList.add("TridactylHintHighlightActive")

            if (this.outline)
                this.outline.classList.add("TridactylHintOutlineActive")

            this.flag.classList.add("TridactylHintSpanActive")
        } else {
            if (renderState.useHintClass)
                this.target.deref()?.classList?.add("TridactylHintElem")

            if (renderState.useActiveHintClass)
                this.target.deref()?.classList?.remove("TridactylHintActive")

            if (this.highlight)
                this.highlight.classList.remove("TridactylHintHighlightActive")

            if (this.outline)
                this.outline.classList.remove("TridactylHintOutlineActive")

            this.flag.classList.remove("TridactylHintSpanActive")
        }
    }

    select() {
        this.onSelect(this)
    }

    set x(X: number) {
        this._x = X
        this.updatePosition()
    }

    get x() {
        return this._x
    }

    set y(Y: number) {
        this._y = Y
        this.updatePosition()
    }

    get y() {
        return this._y
    }

    public overlapsWith(h: Hint) {
        if (h.width == 0) h.width = h.flag.getClientRects()[0].width
        if (h.height == 0) h.height = h.flag.getClientRects()[0].height
        if (this.width == 0) this.width = this.flag.getClientRects()[0].width
        if (this.height == 0) this.height = this.flag.getClientRects()[0].height
        return (
            this.x < h.x + h.width &&
            this.x + this.width > h.x &&
            this.y < h.y + h.height &&
            this.y + this.height > h.y
        )
    }

    public calculateGeometry(cachedRects?: DOMRectList) {

        const target = this.target.deref()
        if (!target) {
            this.noRects = true
            return
        }
        // We need to compute the offset for elements that are in an iframe
        let offsetTop = 0
        let offsetLeft = 0
        const pad = 4
        if (target.ownerDocument !== document) {
            const iframe = DOM.getAllDocumentFrames(document, true).find(
                frame => frame.contentDocument === target.ownerDocument,
            )
            const rect = iframe.getClientRects()[0]
            offsetTop += rect.top
            offsetLeft += rect.left
        }

        // Find the first visible client rect of the target
        const clientRects = cachedRects || target.getClientRects()
        let rect = clientRects[0]
        if (!rect) {
            this.noRects = true
            return
        }
        this.noRects = false
        for (const recti of clientRects) {
            if (recti.bottom + offsetTop > 0 && recti.right + offsetLeft > 0) {
                rect = recti
                break
            }
        }

        this.rect = {
            top: rect.top + offsetTop,
            bottom: rect.bottom + offsetTop,
            left: rect.left + offsetLeft,
            right: rect.right + offsetLeft,
            width: rect.width,
            height: rect.height,
        }

        const top = rect.top > 0 ? this.rect.top : offsetTop + pad
        const left = rect.left > 0 ? this.rect.left : offsetLeft + pad
        this.x = window.scrollX + left
        this.y = window.scrollY + top

        // Add optional overlays
        if (modeState.highlightHost || modeState.outlineHost) {
            const mainRect = document.createElement("div")
            // Add all rectangles for highlights / outlines
            for (const recti of clientRects) {
                let rectElem
                let inset
                if (recti === rect) {
                    rectElem = mainRect
                    inset = `${ window.scrollY + this.rect.top }px ${ window.scrollX + this.rect.left }px`
                } else {
                    // Position extra rects relative to the main rect
                    rectElem = document.createElement("div")
                    mainRect.appendChild(rectElem)
                    inset = `${ recti.top - rect.top }px ${ recti.left - rect.left }px`
                }

                rectElem.style.cssText = `
                    inset: ${ inset } !important;
                    width: ${ recti.width }px !important;
                    height: ${ recti.height }px !important;
                `
            }

            if (!this._active)
                mainRect.setAttribute("hidden", "")

            if (modeState.highlightHost) {
                this.highlight?.remove()
                this.highlight = mainRect
                this.highlight.className = "TridactylHintHighlight"
                modeState.highlightHost.appendChild(this.highlight)
            }

            if (modeState.outlineHost) {
                this.outline?.remove()
                this.outline = this.highlight ? (this.highlight as any).cloneNode(true) : mainRect
                this.outline.className = "TridactylHintOutline"
                modeState.outlineHost.appendChild(this.outline)
            }
        }
    }

    private updatePosition() {
        this.flag.style.cssText = `
        top: ${this._y}px !important;
        left: ${this._x}px !important;
        `
    }
}

/** @hidden */
type HintBuilder = (
    hintables: Hintables[],
    onSelect: HintSelectedCallback,
) => void

/** @hidden */
function buildHintsSimple(
    hintablesArray: Hintables[],
    onSelect: HintSelectedCallback,
) {
    // Get rects in one loop, create elements in a different loop
    // maybe reduces layout thrashing
    // but no probably not because everything's added to a DocumentFragment first I remember now
    // might still be nice to cache rects (maybe before this even - we get them in DOM.isVisible too)
    const hintablesfiltered = hintablesArray.map(h => ({
        elements: h.elements
            .map(el => ({
                el,
                rects: el.getClientRects(),
            }))
            .filter(({ rects }) => rects.length > 0),
        hintclasses: h.hintclasses,
    }))
    const totalhints = hintablesfiltered.reduce(
        (n, h) => n + h.elements.length,
        0,
    )

    // can modeState.hints.length be not 0 here?
    const allnames = Array.from(
        hintnames(totalhints + modeState.hints.length),
    ).slice(modeState.hints.length)

    for (const hintables of hintablesfiltered) {
        const names = allnames.slice(modeState.hints.length)
        for (const [{ el, rects }, name] of izip(hintables.elements, names)) {
            logger.debug({ el, name })
            modeState.hintchars += name
            modeState.hints.push(
                new Hint(
                    el,
                    name,
                    null,
                    onSelect,
                    hintables.hintclasses,
                    rects,
                ),
            )
        }
    }
}

// const deterministicRandomFromSelector = (()=>{
//     const seed = Math.random()
//     return function(selector) {
//         let hash = seed

//         for (let i = 0; i < selector.length; i++) {
//             hash = (hash * 31 + selector.charCodeAt(i)) >>> 0
//         }

//         return hash / 2**32
//     }
// })()

/* eslint-disable no-bitwise */
const deterministicRandomFromSelector = (() => {
    const seed = Math.random() * 0xffffffff >>> 0

    return function(selector) {
        let hash = 0x811c9dc5 ^ seed

        for (let i = 0; i < selector.length; i++) {
            hash ^= selector.charCodeAt(i)
            hash = (hash * 0x01000193) >>> 0
        }

        return hash / 2**32
    }
})()
/* eslint-enable no-bitwise */

/** @hidden */
function buildHintsWordsDeterministic(
    hintablesArray: Hintables[],
    onSelect: HintSelectedCallback,
) {
    const hintablesfiltered = hintablesArray.map(h => ({ elements: h.elements.filter(el => Hint.isHintable(el)), hintclasses: h.hintclasses }))

    const suffixChars = config.get("hintchars")

    const usednames: Map<number, number | string[]> = new Map()

    const allwordindices = hintablesfiltered
        .flatMap(hintables => hintables.elements.map(el => {
            const idx = Math.floor(deterministicRandomFromSelector(
                DOM.getSelector(el as HTMLElement)
            ) * HINT_WORDS.length)

            const used = usednames.get(idx)
            if (!used) usednames.set(idx, 1)
            else usednames.set(idx, used as number + 1)
            return idx
            })
        )

    for (const [idx] of usednames) {
        const count = usednames.get(idx) as number
        if (count === 1) usednames.set(idx, [""])
        else usednames.set(idx, Array.from(
            hintnames_short(count, suffixChars),
        ))
    }

    const allnames = allwordindices
        .map(idx => HINT_WORDS[idx] + (usednames.get(idx) as string[]).pop())

    for (const hintables of hintablesfiltered) {
        const names = allnames.slice(modeState.hints.length)
        for (const [el, name] of izip(hintables.elements, names)) {
            logger.debug({ el, name })
            modeState.hintchars += name
            modeState.hints.push(
                new Hint(el, name, null, onSelect, hintables.hintclasses),
            )
        }
    }
}

/** Helper for vimperator hinting.

    Allow customize vimperator hinting filter by overriding functions of the
    helper object.
 */
export const vimpHelper = {
    filterableTextFilter: null,
    sanitiseHintText: function sanitiseHintText(str) {
        // Clean up hint text
        // strip out hintchars from hint text
        if (vimpHelper.filterableTextFilter === null) {
            // escape the hintchars string so that strange things don't happen
            // when special characters are used as hintchars (for example, ']')
            const escapedHintChars = defaultHintChars().replace(
                /^\^|[-\\\]]/g,
                "\\$&",
            )
            const filterableTextFilter = new RegExp(
                "[" + escapedHintChars + "]",
                "g",
            )
            vimpHelper.filterableTextFilter = filterableTextFilter
        }
        return str.replace(vimpHelper.filterableTextFilter, "")
    },

    matchHint: function matchHint(str, key) {
        // Match a hint key to hint text
        return str.includes(key)
    },
}

/** @hidden */
function buildHintsVimperator(
    hintablesArray: Hintables[],
    onSelect: HintSelectedCallback,
) {
    const hintablesfiltered = hintablesArray.map(h => ({
        elements: h.elements.filter(el => Hint.isHintable(el)),
        hintclasses: h.hintclasses,
    }))
    const totalhints = hintablesfiltered.reduce(
        (n, h) => n + h.elements.length,
        0,
    )
    const allnames = Array.from(
        hintnames(totalhints + modeState.hints.length),
    ).slice(modeState.hints.length)

    for (const hintables of hintablesfiltered) {
        const names = allnames.slice(modeState.hints.length)
        for (const [el, name] of izip(hintables.elements, names)) {
            let ft = elementFilterableText(el)
            ft = vimpHelper.sanitiseHintText(ft)
            logger.debug({ el, name, ft })
            modeState.hintchars += name + ft
            modeState.hints.push(
                new Hint(el, name, ft, onSelect, hintables.hintclasses),
            )
        }
    }
}

/** @hidden */
function elementFilterableText(el: Element): string {
    const nodename = el.nodeName.toLowerCase()
    let text: string
    if (nodename === "input") {
        text = (el as HTMLInputElement).value
    } else if (0 < el.textContent.length) {
        text = el.textContent
    } else if (el.hasAttribute("title")) {
        text = el.getAttribute("title")
    } else {
        text = el.innerHTML
    }
    // Truncate very long text values
    return text.slice(0, 2048).toLowerCase() || ""
}

/** Apply a class to hint tag chars that have been typed so they can be styled.
@hidden */
function addFilteredCharClass(hint: Hint, fstr: string) {
    for (let i = 0; i < fstr.length; ++i) {
        hint.flag.children[i].className = "TridactylHintCharPressed"
    }
    for (let i = fstr.length; i < hint.flag.children.length; ++i) {
        hint.flag.children[i].className = ""
    }
}

/** Remove the filtered char class from all hints - for resetting the style when rapid hinting
@hidden */
function removeFilteredCharClass(state = modeState) {
    const pressed = state.hintHost.querySelectorAll(".TridactylHintCharPressed");
    for (const el of pressed) {
        el.classList.remove("TridactylHintCharPressed");
    }
}

/** @hidden */
type HintFilter = (s: string) => void

/** Show only hints prefixed by fstr. Focus first match
@hidden */
function filterHintsSimple(fstr) {
    const active: Hint[] = []
    let foundMatch

    // Fix bug where sometimes a bigger number would be selected (e.g. 10 rather than 1)
    // such that smaller numbers couldn't be selected
    const hints =
        config.get("hintnames") == "numeric"
            ? R.sortBy(R.pipe(R.prop("name"), parseInt), modeState.hints)
            : modeState.hints

    for (const h of hints) {
        if (!h.name.startsWith(fstr)) h.active = false
        else {
            if (!foundMatch) {
                h.focused = true
                modeState.focusedHint = h
                foundMatch = true
            }
            h.active = true
            addFilteredCharClass(h, fstr)
            active.push(h)
        }
    }
    if (active.length === 1 && config.get("hintautoselect") === "true") {
        selectFocusedHint()
    }
}

/** @hidden */
function filterHintsWords(fstr) {
    const active: Hint[] = []
    let foundMatch

    // Fix bug where sometimes a bigger number would be selected (e.g. 10 rather than 1)
    // such that smaller numbers couldn't be selected
    const hints =
        config.get("hintnames") == "numeric"
            ? R.sortBy(R.pipe(R.prop("name"), parseInt), modeState.hints)
            : modeState.hints

    for (const h of hints) {
        if (!h.name.startsWith(fstr)) h.active = false
        else {
            if (!foundMatch) {
                h.focused = true
                modeState.focusedHint = h
                foundMatch = true
            }
            h.active = true
            addFilteredCharClass(h, fstr)
            active.push(h)
        }
    }
    if (active.length && fstr.length === active[0].name.length) {
        selectFocusedHint()
    }
}

/** Partition the filter string into hintchars and content filter strings.
    Apply each part in sequence, reducing the list of active hints.

    Update display after all filtering, adjusting labels if appropriate.

    Consider: This is a poster child for separating data and display. If they
    weren't so tied here we could do a neat dynamic programming thing and just
    throw the data at a reactalike.

    @hidden
*/
function filterHintsVimperator(query: string, reflow = false) {
    /** Partition a query into a tagged array of substrings */
    function partitionquery(
        query,
    ): Array<{ str: string; isHintChar: boolean }> {
        const peek = a => a[a.length - 1]
        const hintChars = defaultHintChars()

        // For each char, either add it to the existing run if there is one and
        // it's a matching type or start a new run
        const runs = []
        for (const char of query) {
            const isHintChar = hintChars.includes(char)
            if (!peek(runs) || peek(runs).isHintChar !== isHintChar) {
                runs.push({ str: char, isHintChar })
            } else {
                peek(runs).str += char
            }
        }
        return runs
    }

    function rename(hints) {
        const names = hintnames(hints.length)
        for (const [hint, name] of izip(hints, names)) {
            hint.name = name
            hint.flag.textContent = ""
            for (const ch of hint.name) {
                const charspan = document.createElement("span")
                charspan.textContent = ch
                hint.flag.appendChild(charspan)
            }
        }
    }

    // Start with all hints
    let active = modeState.hints
    if (reflow) active.forEach(hint => hint.restoreName())

    // Filter down (renaming as required)
    for (const run of partitionquery(query)) {
        if (run.isHintChar) {
            // Filter by label
            active = active.filter(hint => hint.name.startsWith(run.str))
            active.forEach(hint => addFilteredCharClass(hint, run.str))
        } else {
            // By text
            active = active.filter(hint =>
                vimpHelper.matchHint(hint.filterData, run.str),
            )

            if (reflow) rename(active)
        }
    }

    // Update display
    // Unfocus the focused hint - must be before hiding the hint
    if (modeState.focusedHint) {
        modeState.focusedHint.focused = false
        modeState.focusedHint = undefined
    }

    // Set hidden state of the hints
    for (const hint of modeState.hints) {
        if (active.includes(hint)) {
            hint.active = true
        } else {
            hint.active = false
        }
    }

    // Focus exact name or first hint
    if (active.length) {
        modeState.focusedHint = active.find(h => h.name === query) || active[0]
        modeState.focusedHint.focused = true
    }

    // Select focused hint if it's the only match unless turned off in config
    if (active.length === 1 && config.get("hintautoselect") === "true") {
        selectFocusedHint(true)
    }
}

/**
 * Remove all hints, reset STATE.
 **/
function cleanup() {
    if (contentState.mode === "hint") {
        contentState.mode = DOM.isTextEditable(document.activeElement) ? "insert" : "normal"
        contentState.suffix = ""
    }
    const state = modeState
    if (state) {
        modeState = undefined
        state.cleanUpHints()
        window.removeEventListener("scroll", updateHudOffset)
        window.removeEventListener("resize", repositionDebounced)
    }
    return state
}

function reset() {
    cleanup()?.resolveHinting()
    contentState.mode = "normal"
}

addContentStateChangedListener((property, oldMode) => {
    const state = property === "mode" && oldMode === "hint" ? cleanup() : undefined
    if (state) queueMicrotask(() => state.resolveHinting())
})

function popKey() {
    if (modeState.focusedHint) {
        modeState.focusedHint.focused = false
    }
    if (modeState.filterMode === "text") {
        const findex = modeState.textfilter.length - 1
        if (modeState.textfilter[findex].length > 1) {
            modeState.textfilter[findex] = modeState.textfilter[findex].slice(
                0,
                -1,
            )
        } else if (modeState.textfilter.length > 1) {
            modeState.textfilter.pop()
        } else {
            modeState.textfilter = [""]
        }

        filterByText(modeState.textfilter)

        // fillcmdline_nofocus("hint/" + modeState.textfilter.join("/"))
        contentState.suffix = modeState.textfilter.join("/")
    } else {
        modeState.filter = modeState.filter.slice(0, -1)
        modeState.filterFunc(modeState.filter)
        contentState.suffix = modeState?.filter || ""
    }

    reposition()
}

/** Add key to filtstr and filter */
function pushKey(key) {
    if (modeState.filterMode === "text") {
        const originalFilter = modeState.textfilter.map(s => s)
        const numBefore = modeState.activeHints.length

        const findex = modeState.textfilter.length - 1
        modeState.textfilter[findex] += key

        filterByText(modeState.textfilter)

        if (
            !modeState.activeHints.length &&
            modeState.textfilter[findex].length
        ) {
            modeState.textfilter = originalFilter.concat([key])
            filterByText(modeState.textfilter)
        }

        if (
            modeState.activeHints.length === numBefore ||
            modeState.activeHints.length === 0
        ) {
            modeState.textfilter = originalFilter
            filterByText(originalFilter)
        }

        // fillcmdline_nofocus("hint/" + modeState.textfilter.join("/"))
        contentState.suffix = modeState.textfilter.join("/")
    } else {
        // The new key can be used to filter the hints
        const originalFilter = modeState.filter
        modeState.filter += key
        modeState.filterFunc(modeState.filter)

        if (modeState && !modeState.activeHints.length) {
            // There are no more active hints, undo the change to the filter
            modeState.filter = originalFilter
            modeState.filterFunc(modeState.filter)
        }
        contentState.suffix = modeState?.filter || ""
    }
}

/** I like to display the search string(s) for filterByText with this
 */
// function fillcmdline_nofocus(text: string) {
//     browser.runtime.sendMessage({
//         type: "controller_background",
//         command: "acceptExCmd",
//         args: ["fillcmdline_nofocus " + text],
//     })
// }

// function hidecmdline() {
//     browser.runtime.sendMessage({
//         type: "controller_background",
//         command: "acceptExCmd",
//         args: ["hidecmdline"],
//     })
// }

/** Covert to char and pushKey(). This is needed because ex commands ignore whitespace. */
function pushKeyCodePoint(codepoint) {
    // Codepoints can be hex or base-10
    // We know we're not running in old browsers so this is safe
    // eslint-disable-next-line radix
    const key = String.fromCodePoint(parseInt(codepoint, 0))
    return pushKey(key)
}

/** Just run pushKey(" "). This is needed because ex commands ignore whitespace. */
function pushSpace() {
    return pushKey(" ")
}

/** Array of hintable elements in viewport

    Elements are hintable if
        1. they can be meaningfully selected, clicked, etc
        2. they're visible (unless includeInvisible is true)
            1. Within viewport
            2. Not hidden by another element

    @hidden
*/
export async function hintables(
    selectors = DOM.hintSelectors(),
    withjs = false,
    includeInvisible = false,
) {
    const jsElems = withjs
        ? Array.from(
              new Set([
                  ...DOM.getPrunedHintworthyJSElems(),
                  ...DOM.getElemsBySelector("*", [
                      el => Boolean((el as HTMLElement).onclick),
                  ]),
              ]),
          )
        : []
    const visibleJSElems = withjs && !includeInvisible
        ? DOM.getVisibleElemsBySelector(null, [], jsElems)
        : jsElems
    const elems = changeHintablesToLargestChild(
        includeInvisible
            ? DOM.getElemsBySelector(selectors, [])
            : ((await DOM.getVisibleElemsBySelector(selectors))),
        includeInvisible,
    )
    const hintables: Hintables[] = [{ elements: elems }]
    if (withjs) {
        DOM.getElemsBySelector("*", [
            el => {
                if ((el as any).onclick) {
                    DOM.addHintworthyJSElem(el)
                    return true
                }
                return false
            },
        ])

        hintables.push({
            elements: changeHintablesToLargestChild(
                await visibleJSElems,
                includeInvisible,
            ).filter(el => !elems.includes(el)),
            hintclasses: ["TridactylJSHint"],
        })
    }
    return hintables
}

/**
 * Changes html elements in an array to their largest child,
 * if it is larger than the element in the array.
 * @hidden
 */
function changeHintablesToLargestChild(elements: Element[], includeInvisible: boolean): Element[] {
    const hideObscured = config.get("hinthideobscured") === "true"
    elements.forEach((element, index) => {
        if (element.childNodes.length === 0) return
        let largestChild: Element
        // Find largest child.
        element.childNodes.forEach(c => {
            const currentChild = c as Element
            if (
                !largestChild ||
                isElementLargerThan(currentChild, largestChild)
            ) {
                largestChild = currentChild
            }
        })
        // Change element if child is larger
        if (
            isElementLargerThan(largestChild, element) &&
            (includeInvisible ||
                (DOM.isPainted(largestChild as HTMLElement) &&
                    (!hideObscured || DOM.isUnobscured(largestChild))))
        ) {
            elements[index] = largestChild
        }
    })
    return Array.from(new Set(elements))
}

/**
 * Returns true if e1 is larger than e2, otherwise false.
 * @hidden
 */
function isElementLargerThan(e1: Element, e2: Element): boolean {
    if (typeof e1.getBoundingClientRect !== "function") {
        return false
    } else if (typeof e2.getBoundingClientRect !== "function") {
        return true
    }
    const e1BR = e1.getBoundingClientRect()
    const e2BR = e2.getBoundingClientRect()
    return e1BR.height > e2BR.height && e1BR.width > e2BR.width
}

/** Returns elements that point to a saveable resource
 * @hidden
 */
export function saveableElements(includeInvisible = false) {
    return DOM.getElemsBySelector(DOM.hintSelectors("saveable"), [
        DOM.isVisibleFilter(includeInvisible),
    ])
}

/** Get array of images in the viewport, or all images if includeInvisible is true
 * @hidden
 */
export function hintableImages(includeInvisible = false) {
    return DOM.getElemsBySelector(DOM.hintSelectors("img"), [
        DOM.isVisibleFilter(includeInvisible),
    ])
}

/** Get array of selectable elements that display a text matching either plain
 * text or RegExp rule
 * @hidden
 */
export function hintByText(match: string | RegExp) {
    return DOM.getElemsAndStyleShadowHints(
        DOM.hintSelectors("filterbytext"),
        [DOM.isVisible, hintByTextFilter(match)],
    )
}

/** As I've added filterByText, I need a way to move back to hint char selection
 *  seems you can still select hints which were filtered by text
 *  should removeHiddenHints() not handle that? (and do I even care?)
 */
function filterByTag() {
    modeState.filterMode = "flags"
    modeState.filter = ""
    modeState.removeHiddenHints()
    modeState.showFlags()
}

/** Switch from hinting by flag chars to searching text within the hints.
 *  I've added a separate textfilter, an array rather than a single string
 *  - each string in the array will be searched for in turn, so you don't have to
 *    search for an exact match
 *  I've used the same function to switch to the mode as to pass the string array
 *  (maybe not the best choice)
 *
 *  TODO: reuse vimperator filtering
 */
function filterByText(match?: string[]) {
    if (modeState.filterMode !== "text") {
        modeState.filterMode = "text"
        modeState.textfilter = match || [""]

        modeState.activeHints.forEach(h => {
            if (!h.target.deref() || !DOM.isVisible(h.target.deref())) h.active = false
        })

        if (!modeState.activeHints.length) {
            reset()
            return
        }

        modeState.removeHiddenHints()

        if (!modeState.hints.includes(modeState.focusedHint)) {
            // Unfocus the currently focused hint
            modeState.focusedHint.focused = false

            // Focus the next hint
            modeState.focusedHint = modeState.hints[0]
            modeState.focusedHint.focused = true
        }
        hideFlags()

        // fillcmdline_nofocus("hint/" + modeState.textfilter.join("/"))
        contentState.suffix = modeState.textfilter.join("/")
    }

    if (!match) return

    modeState.focusedHint.focused = false

    const active = []
    let shortestText = Number.MAX_SAFE_INTEGER
    let focus = modeState.focusedHint

    for (const hint of modeState.hints) {
        const el = hint.target.deref()
        if (!el) {
            hint.active = false
            continue
        }
        let text
        if (el instanceof HTMLInputElement) {
            text = el.value.trim()
        } else {
            text = el.textContent.trim()
        }

        if (!text || text === "") {
            hint.active = false
        } else if (
            match.every(str => text.toUpperCase().includes(str.toUpperCase()))
        ) {
            hint.active = true
            active.push(hint)
            if (shortestText > text.length) {
                shortestText = text.length
                focus = hint
            }
        } else {
            hint.active = false
        }
    }

    modeState.focusedHint = focus
    modeState.focusedHint.focused = true
}

/** Return a predicate that checks whether an element matches a given text hinting filter
 * @hidden
 */
export function hintByTextFilter(match: string | RegExp): HintSelectedCallback {
    return hint => {
        let text
        if (hint instanceof HTMLInputElement) {
            text = hint.value
        } else {
            text = hint.textContent
        }
        if (match instanceof RegExp) {
            return text.match(match) !== null
        } else {
            return text.toUpperCase().includes(match.toUpperCase())
        }
    }
}

/** Array of items that can be killed with hint kill
@hidden
 */
export function killables(includeInvisible = false) {
    return DOM.getElemsBySelector(DOM.hintSelectors("killable"), [
        DOM.isVisibleFilter(includeInvisible),
    ])
}

// Multiple dispatch? who needs it
/** Returns an array of hintable objects from an array of elements
 * @hidden
 * */
export function toHintablesArray(
    hintablesOrElements: Element[] | Hintables[],
): Hintables[] {
    if (!hintablesOrElements.length) return []
    if ("className" in hintablesOrElements[0])
        return [{ elements: hintablesOrElements } as Hintables]
    if ("elements" in hintablesOrElements[0])
        return hintablesOrElements as Hintables[]
    return []
}

function selectFocusedHint(delay = false) {
    logger.debug("Selecting hint.", contentState.mode)
    const focused = modeState.focusedHint
    const selectFocusedHintInternal = () => {
        modeState.filter = ""
        contentState.suffix = ""
        modeState.hints.forEach(h => {
            h.restoreName()
            h.active = true
        })
        focused.select()
    }
    if (delay) setTimeout(selectFocusedHintInternal, config.get("hintdelay"))
    else selectFocusedHintInternal()
}

function pushSpaceOrSelectFocusedHint() {
    if (modeState.filterMode === "text") pushSpace()
    else selectFocusedHint()
}

function focusNextHint() {
    logger.debug("Focusing next hint")
    modeState.changeFocusedHintIndex(1)
}

function focusPreviousHint() {
    logger.debug("Focusing previous hint")
    modeState.changeFocusedHintIndex(-1)
}

function focusTopHint() {
    logger.debug("Focusing top hint")
    modeState.changeFocusedHintTop()
}

function focusBottomHint() {
    logger.debug("Focusing bottom hint")
    modeState.changeFocusedHintBottom()
}

function focusLeftHint() {
    logger.debug("Focusing left hint")
    modeState.changeFocusedHintLeft()
}

function focusRightHint() {
    logger.debug("Focusing right hint")
    modeState.changeFocusedHintRight()
}

function focusParentHint() {
    logger.debug("Focusing first parent hint")
    modeState.focusFirstParentHint()
}

function reposition() {
    logger.debug("Recalculating hint positions")
    renderState.reposition()
}

/** @hidden */
export function parser(keys: keyseq.MinimalKey[]) {
    const parsed = keyseq.parse(
        keys,
        keyseq.keyTrie("hintmaps"),
        false,
    )

    if (parsed.isMatch === true) {
        return parsed
    }
    // Ignore keyups & modifiers since they can't match text
    const simplekeys = keys.filter(key => !key.keyup && !keyseq.hasModifiers(key))
    let exstr
    if (simplekeys.length > 1) {
        exstr = simplekeys.reduce(
            (acc, key) => `hint.pushKey ${key.key};`,
            "composite ",
        )
    } else if (simplekeys.length === 1) {
        exstr = `hint.pushKeyCodePoint ${simplekeys[0].key.codePointAt(0)}`
    } else {
        return { keys: [], isMatch: false }
    }
    return { exstr, value: exstr, isMatch: true }
}

function getHints(): { target: Element; flag: Element }[] {
    return modeState.hints.map(h => ({ target: h.target.deref(), flag: h.flag }))
}

function hideFlags() {
    modeState.hideFlags()
}

function showFlags() {
    modeState.showFlags()
}

/** my first though for typing hint textcontent to filter hints, a general filter function
 *  removeFiltered prevents hints from being selectable and stops filtered hints being
 *  considered for any further filtering
 *  removeFiltered can't be undone, ie you won't be able to unhide filtered hints
 *
 *  a thought I had is that you could store filter strings with their functions
 *  so modeState.filter would be an array of objects containing the filter string & func
 *  [{ text: "...", func: (hint)=>{...}}]
 *  such that each element of the array could be used to filter from the base hints,
 *  even if you change to arbitrary filter predicates along the way
 *  ... but the thing is, I'm either using the flag chars, or the text right now
 *
 *  conceivably you could have other predicates (eg odd/even hints have different colours,
 *  one key filters one colour, another the other... I've tried that btw it's pretty
 *  inefficient! And not that intuitive! But easy to implement)
 *  so that kind of thing could be useful in some cases...
 *
 *  don't know why I wrote all that in this comment but it can stay for now
 *
 *  originally only passed target to the predicate, but sometimes you might want to know
 *  about the flag? IDK ... feel like you might want the rectangle info as well...
 *  you know, if you're going to the trouble of calling this function, you'd probably
 *  be after some flexibility
 */
function filterHints(
    predicate: (el: Element, flag: Element) => boolean,
    autoSelect: boolean | undefined,
    removeFiltered: boolean | undefined,
): void {
    autoSelect = autoSelect || true
    removeFiltered = removeFiltered || true

    const hints = modeState.hints
    const active: Hint[] = []

    for (const h of hints) {
        const el = h.target.deref()
        if (!el || !predicate(el, h.flag)) h.active = false
        else {
            h.active = true
            active.push(h)
        }
    }

    if (active.length > 0) {
        modeState.focusedHint.focused = false
        modeState.focusedHint = active[0]
        modeState.focusedHint.focused = true
    } else {
        reset()
        return
    }

    if (active.length === 1 && autoSelect === true) {
        selectFocusedHint()
    }

    if (removeFiltered) modeState.removeHiddenHints()
}

/** @hidden*/
export function getHintCommands() {
    return {
        reset,
        focusPreviousHint,
        focusNextHint,
        focusTopHint,
        focusBottomHint,
        focusLeftHint,
        focusRightHint,
        focusParentHint,
        selectFocusedHint,
        pushKey,
        pushSpace,
        pushSpaceOrSelectFocusedHint,
        pushKeyCodePoint,
        popKey,
        getHints,
        filterHints,
        filterByText,
        filterByTag,
        hideFlags,
        showFlags,
        reposition,
    }
}
