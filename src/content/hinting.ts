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
import { contentState } from "@src/content/state_content"
import * as config from "@src/lib/config"
import Logger from "@src/lib/logging"
import * as R from "ramda"

/** @hidden */
const logger = new Logger("hinting")
import * as keyseq from "@src/lib/keyseq"

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
    readonly hintHost = document.createElement("div")
    readonly highlightHost = document.createElement("div")
    readonly outlineHost = document.createElement("div")
    readonly hintsBase: Hint[] = []

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
    ) {
        this.hintHost.classList.add("TridactylHintHost", "cleanslate")
        this.highlightHost.classList.add(
            "TridactylHintHighlightHost",
            "cleanslate",
        )
        this.outlineHost.classList.add("TridactylHintOutlineHost", "cleanslate")

        // hinthost alignment (eg: bsky.app has a 15px offset for some reason)
        const docElRect = document.documentElement.getBoundingClientRect()
        this.hintHost.style.cssText = `
        top: ${-scrollY - docElRect.y}px !important;
        left: ${-scrollX - docElRect.x}px !important;
        `
        this.highlightHost.style.cssText = `
        top: ${-docElRect.y}px !important;
        left: ${-docElRect.x}px !important;
        `
        this.outlineHost.style.cssText = `
        top: ${-docElRect.y}px !important;
        left: ${-docElRect.x}px !important;
        `
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
        return this.filteredHints.filter(h => !h.flag.hidden)
    }

    /**
     * Remove hinting elements and classes from the DOM
     */
    cleanUpHints() {
        // Undo any alterations of the hinted elements
        for (const hint of this.hints) {
            hint.hidden = true
        }

        // Remove all hints from the DOM.
        this.hintHost.remove()
        this.highlightHost.remove()
        this.outlineHost.remove()

        if (modeState.filterMode === "text") hidecmdline()
    }

    resolveHinting() {
        this.cleanUpHints()

        if (this.rapid) {
            this.resolve(this.selectedHints.map(h => h.result))
        } else
            this.resolve(
                this.selectedHints[0] ? this.selectedHints[0].result : "",
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
        let parent = this.focusedHint.target.parentElement
        while (parent) {
            if (parent.classList.contains("TridactylHintElem")) {
                const focus = this.activeHints.find(h => h.target === parent)
                if (!focus) return
                this.focusedHint.focused = false
                this.focusedHint = focus
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

        // All done!
    }
}

/** @hidden*/
let modeState: HintState

interface Hintables {
    elements: Element[]
    hintclasses?: string[]
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

/** For each hintable element, add a hint
 * @hidden
 * */
export function hintPage(
    hintableElements: Hintables[],
    onSelect: HintSelectedCallback,
    resolve: (x?) => void = () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    reject: (x?) => void = () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    rapid = false,
) {
    reset() // Tidy up in case any previous hinting wasn't exited cleanly
    const buildHints: HintBuilder = defaultHintBuilder()
    const filterHints: HintFilter = defaultHintFilter()
    contentState.mode = "hint"
    modeState = new HintState(filterHints, resolve, reject, rapid)

    if (!rapid) {
        buildHints(hintableElements, hint => {
            modeState.cleanUpHints()
            hint.result = onSelect(hint.target)
            modeState.selectedHints.push(hint)
            reset()
        })
    } else {
        buildHints(hintableElements, hint => {
            hint.result = onSelect(hint.target)
            modeState.selectedHints.push(hint)
            modeState.textfilter = [""]
            modeState.filterMode = "flags"
            modeState.showFlags()
            if (
                modeState.selectedHints.length > 1 &&
                config.get("hintshift") === "true"
            ) {
                modeState.shiftHints()
            }
        })
    }

    if (!modeState.hints.length) {
        // No more hints to display
        reset()
        return
    }

    // There are multiple hints. Normally we would just show all of them, but
    // we try to be clever here. Automatically select the first one if all the
    // conditions are true:
    //  - it is <a>
    //  - its href is not empty (does not point to the page itself)
    //  - its href is not javascript
    //  - all the remaining hints
    //      - are either _not_ <a>
    //      - or their href points to the sampe place as first one

    const firstTarget = modeState.hints[0].target

    const firstTargetIsSelectable = (): boolean =>
        firstTarget instanceof HTMLAnchorElement &&
        firstTarget.href !== "" &&
        !firstTarget.href.startsWith("javascript:")

    const allTargetsAreEqual = (): boolean =>
        undefined ===
        modeState.hints.find(
            h =>
                !(h.target instanceof HTMLAnchorElement) ||
                h.target.href !== (firstTarget as HTMLAnchorElement).href,
        )

    if (
        (modeState.hints.length == 1 ||
            (firstTargetIsSelectable() && allTargetsAreEqual())) &&
        config.get("hintautoselect") === "true"
    ) {
        // There is just a single link or all the links point to the same
        // place. Select it unless `hintautoselect` is set to `false`.
        modeState.cleanUpHints()
        modeState.hints[0].select()
        reset()
        return
    }

    // Just focus first link
    modeState.focusedHint = modeState.hints[0]
    modeState.focusedHint.focused = true

    document.documentElement.appendChild(modeState.highlightHost)
    document.documentElement.appendChild(modeState.outlineHost)
    document.documentElement.appendChild(modeState.hintHost)

    modeState.deOverlap()
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
    }
}

/** @hidden */
function defaultHintChars() {
    if (config.get("hintnames") === "numeric") {
        return "1234567890"
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
        default:
            yield* hintnames_short(n, hintchars)
    }
}

/** @hidden */
type HintSelectedCallback = (x: any) => any

/** Place a flag by each hintworthy element
@hidden */
class Hint {
    public readonly flag = document.createElement("span")
    public readonly highlight = document.createElement("div")
    public readonly outline = document.createElement("div")
    public readonly rect: ClientRect = null
    public result: any = null

    public width = 0
    public height = 0
    private _x = 0
    private _y = 0

    constructor(
        public readonly target: Element,
        public name: string,
        public readonly filterData: any,
        private readonly onSelect: HintSelectedCallback,
        classes?: string[],
    ) {
        // We need to compute the offset for elements that are in an iframe
        let offsetTop = 0
        let offsetLeft = 0
        const pad = 4
        if (target.ownerDocument !== document) {
            const iframe = DOM.getAllDocumentFrames().find(
                frame => frame.contentDocument === target.ownerDocument,
            )
            const rect = iframe.getClientRects()[0]
            offsetTop += rect.top
            offsetLeft += rect.left
        }

        // Find the first visible client rect of the target
        const clientRects = target.getClientRects()
        let rect = clientRects[0]
        for (const recti of clientRects) {
            if (recti.bottom + offsetTop > 0 && recti.right + offsetLeft > 0) {
                rect = recti
                break
            }
        }

        // Overlays for multiple client rects
        for (const recti of clientRects) {
            if (recti === rect) continue

            const extraRect = document.createElement("div")

            extraRect.style.cssText = `
                position: absolute !important;
                background: inherit !important;
                outline: inherit !important;

                top: ${recti.top - rect.top}px !important;
                left: ${recti.left - rect.left}px !important;
                width: ${recti.width}px !important;
                height: ${recti.height}px !important;
            `

            this.highlight.appendChild(extraRect)
            this.outline.appendChild(extraRect.cloneNode(true))
        }

        this.rect = {
            top: rect.top + offsetTop,
            bottom: rect.bottom + offsetTop,
            left: rect.left + offsetLeft,
            right: rect.right + offsetLeft,
            width: rect.width,
            height: rect.height,
        }

        // multiple spans per span
        // this.flag.textContent = name
        // instead, we'll give each char a span and a class so they can be styled later
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

        this.highlight.classList.add("TridactylHintHighlight")
        this.outline.classList.add("TridactylHintOutline")

        const top = rect.top > 0 ? this.rect.top : offsetTop + pad
        const left = rect.left > 0 ? this.rect.left : offsetLeft + pad
        this.x = window.scrollX + left
        this.y = window.scrollY + top

        modeState.highlightHost.appendChild(this.highlight)
        modeState.outlineHost.appendChild(this.outline)
        modeState.hintHost.appendChild(this.flag)
        this.hidden = false
    }

    public static isHintable(target: Element): boolean {
        return target.getClientRects().length > 0
    }

    setName(n: string) {
        this.name = n
        this.flag.textContent = this.name
    }

    // These styles would be better with pseudo selectors. Can we do custom ones?
    // If not, do a state machine.
    set hidden(hide: boolean) {
        this.flag.hidden = hide
        if (hide) {
            this.focused = false
            this.target.classList.remove("TridactylHintElem")
            this.highlight.setAttribute("hidden", "")
            this.outline.setAttribute("hidden", "")
        } else {
            this.target.classList.add("TridactylHintElem")
            this.highlight.removeAttribute("hidden")
            this.outline.removeAttribute("hidden")
        }
    }

    set focused(focus: boolean) {
        if (focus) {
            this.target.classList.add("TridactylHintActive")
            this.target.classList.remove("TridactylHintElem")

            this.highlight.classList.add("TridactylHintHighlightActive")
            this.highlight.classList.remove("TridactylHintHighlight")
            this.outline.classList.add("TridactylHintOutlineActive")
            this.outline.classList.remove("TridactylHintOutline")

            this.flag.classList.add("TridactylHintSpanActive")
        } else {
            this.target.classList.add("TridactylHintElem")
            this.target.classList.remove("TridactylHintActive")

            this.highlight.classList.add("TridactylHintHighlight")
            this.highlight.classList.remove("TridactylHintHighlightActive")
            this.outline.classList.add("TridactylHintOutline")
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

    private updatePosition() {
        this.flag.style.cssText = `
        top: ${this._y}px !important;
        left: ${this._x}px !important;
        `

        this.highlight.style.cssText = `
        top: ${this.rect.top}px !important;
        left: ${this.rect.left}px !important;
        height: ${this.rect.height}px !important;
        width: ${this.rect.width}px !important;
        `

        this.outline.style.cssText = this.highlight.style.cssText
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
        // match every part of key splited by space.
        return key.split(/\s+/).every(keyi => str.includes(keyi))
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
        if (!h.name.startsWith(fstr)) h.hidden = true
        else {
            if (!foundMatch) {
                h.focused = true
                modeState.focusedHint = h
                foundMatch = true
            }
            // style the typed characters
            addTypedCharClass(h, fstr.length)
            h.hidden = false
            active.push(h)
        }
    }
    if (active.length === 1 && config.get("hintautoselect") === "true") {
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
        }
    }

    // Start with all hints
    let active = modeState.hints

    // Filter down (renaming as required)
    for (const run of partitionquery(query)) {
        if (run.isHintChar) {
            // Filter by label
            active = active.filter(hint => hint.name.startsWith(run.str))
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
            hint.hidden = false
            hint.flag.textContent = hint.name
        } else {
            hint.hidden = true
        }
    }

    // Focus first hint
    if (active.length) {
        modeState.focusedHint = active[0]
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
function reset() {
    if (modeState) {
        modeState.cleanUpHints()
        modeState.resolveHinting()
    }
    modeState = undefined
    contentState.mode = "normal"
}

function popKey() {
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

        fillcmdline_nofocus("hint/" + modeState.textfilter.join("/"))
    } else {
        modeState.filter = modeState.filter.slice(0, -1)
        modeState.filterFunc(modeState.filter)
    }
}

/** Add key to filtstr and filter */
function pushKey(key) {
    if (modeState.filterMode === "text") {
        const originalFilter = modeState.textfilter.map(s => s)

        const findex = modeState.textfilter.length - 1
        modeState.textfilter[findex] += key

        filterByText(modeState.textfilter)

        if (
            modeState &&
            !modeState.activeHints.length &&
            modeState.textfilter[findex].length
        ) {
            modeState.textfilter = originalFilter.concat([key])
            filterByText(modeState.textfilter)
        }

        if (modeState && !modeState.activeHints.length) {
            modeState.textfilter = originalFilter
            filterByText(originalFilter)
        }

        fillcmdline_nofocus("hint/" + modeState.textfilter.join("/"))
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
    }
}

/** I like to display the search string(s) for filterByText with this
 */
function fillcmdline_nofocus(text: string) {
    browser.runtime.sendMessage({
        type: "controller_background",
        command: "acceptExCmd",
        args: ["fillcmdline_nofocus " + text],
    })
}

function hidecmdline() {
    browser.runtime.sendMessage({
        type: "controller_background",
        command: "acceptExCmd",
        args: ["hidecmdline"],
    })
}

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
export function hintables(
    selectors = DOM.HINTTAGS_selectors,
    withjs = false,
    includeInvisible = false,
) {
    const visibleFilter = DOM.isVisibleFilter(includeInvisible)
    const elems = changeHintablesToLargestChild(
        DOM.getElemsBySelector(selectors, []).filter(visibleFilter),
    )
    const hintables: Hintables[] = [{ elements: elems }]
    if (withjs) {
        hintables.push({
            elements: changeHintablesToLargestChild(
                Array.from(DOM.hintworthy_js_elems).filter(
                    el => visibleFilter(el) && !elems.includes(el),
                ),
            ),
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
function changeHintablesToLargestChild(elements: Element[]): Element[] {
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
        if (isElementLargerThan(largestChild, element)) {
            elements[index] = largestChild
        }
    })
    return elements
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
    return DOM.getElemsBySelector(DOM.HINTTAGS_saveable, [
        DOM.isVisibleFilter(includeInvisible),
    ])
}

/** Get array of images in the viewport, or all images if includeInvisible is true
 * @hidden
 */
export function hintableImages(includeInvisible = false) {
    return DOM.getElemsBySelector(DOM.HINTTAGS_img_selectors, [
        DOM.isVisibleFilter(includeInvisible),
    ])
}

/** Get array of selectable elements that display a text matching either plain
 * text or RegExp rule
 * @hidden
 */
export function hintByText(match: string | RegExp) {
    return DOM.getElemsBySelector(DOM.HINTTAGS_filter_by_text_selectors, [
        DOM.isVisible,
        hintByTextFilter(match),
    ])
}

/** Add class to typed hint chars so they can be styled however.
 *  @hidden
 */
function addTypedCharClass(hint: Hint, charCount: number) {
    for (let i = 0; i < charCount; ++i) {
        hint.flag.children[i].className = "TridactylHintSpanCharTyped"
    }
    for (let i = charCount; i < hint.flag.children.length; ++i) {
        hint.flag.children[i].className = ""
    }
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
    hidecmdline()
}

/** Switch from hinting by flag chars to searching text within the hints.
 *  I've added a separate textfilter, an array rather than a single string
 *  - each string in the array will be searched for in turn, so you don't have to
 *    search for an exact match
 *  I've used the same function to switch to the mode as to pass the string array
 *  (maybe not the best choice)
 */
function filterByText(match?: string[] | undefined) {
    if (modeState.filterMode !== "text") {
        modeState.filterMode = "text"
        modeState.textfilter = match || [""]

        modeState.activeHints.forEach(h => {
            if (!DOM.isVisible(h.target)) h.hidden = true
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

        fillcmdline_nofocus("hint/" + modeState.textfilter.join("/"))
    }

    if (!match) return

    modeState.focusedHint.focused = false

    const active = []
    let shortestText = Number.MAX_SAFE_INTEGER
    let focus = modeState.focusedHint

    for (const hint of modeState.hints) {
        const el = hint.target
        let text
        if (el instanceof HTMLInputElement) {
            text = el.value.trim()
        } else {
            text = el.textContent.trim()
        }

        if (!text || text === "") {
            hint.hidden = true
        } else if (
            match.every(str => text.toUpperCase().includes(str.toUpperCase()))
        ) {
            hint.hidden = false
            active.push(hint)
            if (shortestText > text.length) {
                shortestText = text.length
                focus = hint
            }
        } else {
            hint.hidden = true
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
    return DOM.getElemsBySelector(DOM.HINTTAGS_killable_selectors, [
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
        modeState.hints.forEach(h => (h.hidden = false))
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

/** @hidden */
export function parser(keys: keyseq.MinimalKey[]) {
    const parsed = keyseq.parse(
        keys,
        keyseq.mapstrMapToKeyMap(
            new Map(
                (Object.entries(config.get("hintmaps")) as any).filter(
                    ([_key, value]) => value != "",
                ),
            ),
        ),
    )
    if (parsed.isMatch === true) {
        return parsed
    }
    // Ignore modifiers since they can't match text
    const simplekeys = keys.filter(key => !keyseq.hasModifiers(key))
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
    return modeState.hints.map(h => ({ target: h.target, flag: h.flag }))
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
        if (!predicate(h.target, h.flag)) h.hidden = true
        else {
            h.hidden = false
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
    }
}
