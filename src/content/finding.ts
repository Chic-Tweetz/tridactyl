// import * as config from "@src/lib/config"
// import * as DOM from "@src/lib/dom"
// import { browserBg, activeTabId } from "@src/lib/webext"
// import state from "@src/state"
// import * as State from "@src/state"
// import { compute as scrollCompute } from "compute-scroll-into-view"
import { clear } from "@src/commandline_frame"
import { showAlternateInput } from "@src/content/commandline_content"
import { getThemedCssText, getThemedStylesheet } from "@src/content/styling"

/**
 * what a monster this has become!
 *
 * examples of pages which have caused the size of this file to increase:
 * - https://catppuccin.com/palette/
 *      - random runs of whitespace due to the format of the html in <p>s, must be squashed to 1 space
 *      - rgb/hsl/oklch text are all within elements with display: "contents"; set, which the isSubstantial function missed
 * - github.com
 *      - shadow doms with nothing but a text node inside (date/time tags)
 * - stackoverflow
 *      - TODO: <pre> code snippets - we should be respecting newlines here but we aren't
 *                                    try searching for ^. and see the whole <pre> is one block
 *                                    confusing... i split by newlines when matching and it didn't fix it
 *                                    well, "fix" it... this is possibly a non-issue... maybe... 
 *
 * find text in the page, using regex (not browser.find.find)
 *
 * first find all text, splitting it into "blocks"
 * by walking the dom, checking element types and styles
 * broadly, inline elements/styles -> same block, block -> new block
 *
 * we walk shadows (& same-origin iframes)
 * ultimately stopped using a TreeWalker because of having to deal with shadows, but maybe would still be the right choice
 *
 * after collecting text blocks, their combined text is normalised
 * this involves:
 * - either keeping or removing newlines depending on the element/whitepsace style (<pre> keeps them)
 * - squashing runs of spaces into 1 (again depending on whitespace rule)
 * - normalising accented chars to non-accented é -> e
 * - normalising punctuation, including ellipses to three dots... which the built-in search doesn't actually do it turns out
 * - String.normalize("NFKC") is also used, apparently some ligatures can take up multiple unicode chars or... something
 *
 * this is in an effort to aim for parity with the built-in browser ctrl+f
 *
 * there are many annoying edge cases like slots, display: contents,
 * long runs of whitespace from the html layout
 * probably many issues yet to be found
 *
 * normalised text is tested against the search query, as a regular expression
 *
 * Ranges for matched text are fed to the highlight api, with an extra highlight registry in every iframe
 * we also try to inject style into shadow doms so the highlights work everywhere
 *
 * Because this is intended to work as the search query is typed (incsearch),
 * there are some simple "if this time-slice > max-time-slice then await setTimeout..." checks
 * with abort controllers to cancel previous searches when a new one begins
 *
 * these could/should(?) likely be replaced with equivalent async generators
 */

// Unlimited highlights can slow us down (particularly for searches like ".")
const MAX_HIGHLIGHTS = 1000

// not sure all these are even used, let alone all necessary
// but may consider making a Finder class or something
// so it would be nice to contain all these things to a single instance of a Finder
interface SearchState {
    searchAbortController: AbortController
    walkingAbortController: AbortController
    buildingSearchBlocks: boolean
    searchQuery: RegExp | string
    matches: Range[]
    searchBlocks: any[]
    activeMatchIdx: number
    uniqueMatchesMap: Map<Node, Set<number>>
    clearSearchBlocksTimer: number
    matchesPerFrame: any[]
    styledRoots: WeakSet<Document | DocumentFragment | ShadowRoot | Node>
    reverse: boolean
    fromView: boolean
}

const searchState: SearchState = {
    searchAbortController: new AbortController(),
    walkingAbortController: new AbortController(),
    buildingSearchBlocks: false,
    searchQuery: null,
    matches: [],
    searchBlocks: [],
    activeMatchIdx: -1,
    uniqueMatchesMap: new Map(),
    clearSearchBlocksTimer: null,
    matchesPerFrame: [],
    styledRoots: new WeakSet(),
    reverse: false,
    fromView: false,
}

export function getSearchBlocks() {
    return searchState.searchBlocks
}
// As much as possible, this Range is used as opposed to creating new live Ranges.
// Doing it this way fixed a nasty performance issue. Favour StaticRanges!
const reuseRange = document.createRange()

// May/probably should switch to async generators, but this is how I'm keeping everything responsive while searching
// awaiting timeouts if time since last check is > SLICE_MS, in "block building" and searching
const SLICE_MS = 8
let sliceEnd = performance.now() + SLICE_MS

// iframes need their own highlight registries
const frames = new Set()

// These appears to be unused
const normalHighlightObjects = []

// Add an input to the cmdilne iframe to call our search oninput
// this isn't the only option for incsearch, but I thought I'd try it
// because it could be useful to hide inputs in the iframe for other reasons
// like IME vimperator hinting https://github.com/tridactyl/tridactyl/discussions/5337
// (this is a bit janky)
export function searchbar(reverse = false, searchFromView = true) {
    showAlternateInput(
        str => jumpToMatch(str, { reverse, searchFromView }),
        () => focusHighlight(searchState.activeMatchIdx, true),
        () => removeHighlighting(),
        "find",
    )
}

// I've renamed/wrapped some functions to match the original finding.ts API
// but now I'm confused about what does what :)
export function jumpToMatch(searchQuery, option) {
    searchState.fromView = option.searchFromView || false
    searchState.reverse = option.reverse || false
    return searchRe(searchQuery)
}

// search from view should jump to first visible match from previous search I suppose?
// searchFromView isn't going to work yet
export function jumpToNextMatch(
    n: number,
    searchFromView = false,
    focus = false,
) {
    if (searchFromView) return jumpToNextFromView(n, focus)
    //return gotoMatch(searchState.activeMatchIdx + n)
    let idx = searchState.activeMatchIdx + n
    if (idx < 0) {
        idx = searchState.matches.length + n
    } else if (idx >= searchState.matches.length) {
        idx %= searchState.matches.length
    }
    focusHighlight(idx, focus)
}

export function focusHighlight(idx: number, focus = false) {
    const range = searchState.matches[idx]
    if (!range) return
    searchState.activeMatchIdx = idx
    setActiveRange(range, focus)
    highlightAround(idx)
}

// TODO: figure out: do we need to search backwards from the bottom-right
// or the top-left as with forward search?
// this searches from the bottom-right so on-screen matches will count
export function jumpToNextFromView(n: number = 1, focus = true) {
    const curr = searchState.matches[searchState.activeMatchIdx]
    if (isRangeInView(curr)) {
        jumpToNextMatch(n, false, true)
        return
    }

    let idx
    if (n > 0) {
        let firstInView = searchState.matches.findIndex(
            range => compareRangetoView(range) >= 0,
        )
        if (firstInView >= 0) {
            idx = firstInView + n - 1
        } else {
            idx = n - 1
        }
    } else {
        let lastInView = (searchState.matches as any).findLastIndex(
            range => compareRangetoView(range) <= 0,
        )
        if (lastInView >= 0) {
            idx = lastInView + n + 1
        } else {
            idx = n + 1
        }
    }
    focusHighlight(idx, focus)
}

export function highlightAround(idx: number) {
    highlightMatchSlice(idx - MAX_HIGHLIGHTS / 2, idx + MAX_HIGHLIGHTS / 2)
}

export function removeHighlighting() {
    clearHighlights()
    clearActiveHighlight()
}

export function currentMatchRange() {
    return searchState.matches[searchState.activeMatchIdx]
}

export function stop() {
    searchState.searchAbortController.abort()
    searchState.walkingAbortController.abort()
}

// we need to nullify our search blocks for dynamic pages
function clearBlocksCache() {
    if (searchState.searchAbortController.signal.aborted) {
        searchState.searchBlocks = []
        return true
    } else {
        clearBlocksCacheAfterMs(3000)
        return false
    }
}

function clearBlocksCacheAfterMs(afterMs = 5000) {
    clearTimeout(searchState.clearSearchBlocksTimer)
    searchState.clearSearchBlocksTimer = setTimeout(clearBlocksCache, afterMs)
}

// Add highlight registries to a frame if one doesn't exist, return them either way
// this no longer really goes with the highlighting method i use now
// where i replace the entire set each time
function getOrCreateHighlights(win = window) {
    if (frames.has(win))
        return {
            highlights: (win.CSS as any).highlights.get("tridactyl-find"),
            activeHighlight: (win.CSS as any).highlights.get(
                "tridactyl-find-active",
            ),
        }

    const hl = new (win as any).Highlight()
    const hla = new (win as any).Highlight()

    hl.priority = 1
    hla.priority = 2
    ;(win.CSS as any).highlights.set("tridactyl-find", hl)
    ;(win.CSS as any).highlights.set("tridactyl-find-active", hla)

    return { highlights: hl, activeHighlight: hla }
}

function getComputedHighlightCss() {
    const comp = getComputedStyle(document.documentElement)
    return (
        `::highlight(tridactyl-find) {` +
        `background-color: ${comp.getPropertyValue("--tridactyl-search-highlight-bg")};` +
        `color: ${comp.getPropertyValue("--tridactyl-search-highlight-fg")};` +
        `}` +
        `::highlight(tridactyl-find-active) {` +
        `background-color: ${comp.getPropertyValue("--tridactyl-search-active-highlight-bg")};` +
        `color: ${comp.getPropertyValue("--tridactyl-search-active-highlight-fg")};` +
        `}`
    )
}

let shadowStyleSheet = null
function styleShadow(shadowRoot: ShadowRoot) {
    if (searchState.styledRoots.has(shadowRoot)) return
    try {
        if (!shadowStyleSheet) {
            shadowStyleSheet = new CSSStyleSheet()
            shadowStyleSheet.replaceSync(getComputedHighlightCss())
        }
        // I wish it could be easier to style shadow DOMs >:|
        // window.eval can be blocked and so can shadowRoot.adoptedStyleSheets
        window.eval(`(root,sheet)=>root.adoptedStyleSheets.push(sheet)`)(
            shadowRoot,
            shadowStyleSheet,
        )
        searchState.styledRoots.add(shadowRoot)
    } catch (e) {
        // something's blocked by CSP, but we can still add a <style> element
        const style = document.createElement("style")
        style.textContent = getComputedHighlightCss()
        shadowRoot.appendChild(style)
        searchState.styledRoots.add(shadowRoot)
    }
}

// This should be part of the normal .CSS files
// we should attempt to share the stylesheet with shadow roots
// failing that, we should either inject styles as we already do
// or we should use overlays (perhaps choose using a config setting)
export function addHighlightStyles(
    root: Node | Document | DocumentFragment | ShadowRoot = document,
    referenceNode?: Node | HTMLElement,
) {
    if (searchState.styledRoots.has(root as any)) return
    const win = (root as Document).defaultView

    getOrCreateHighlights(win)

    const style = document.createElement("style")
    style.innerText = getThemedCssText()

    // we should only create and insert a <style> element if we can't inherit a stylesheet
    // also the top window should have the sytles by default through a .css file
    const maybeHead = (root as Document).head
    if (maybeHead) maybeHead.appendChild(style)
    else {
        const firstChild =
            (root as any).body?.children[0] || (root as any).children[0]

        // does this make sense
        if (!firstChild && referenceNode) {
            if (referenceNode.nodeType !== Node.ELEMENT_NODE) {
                referenceNode = referenceNode.parentElement
            }
            ;(referenceNode as HTMLElement)?.insertAdjacentElement(
                "beforebegin",
                style,
            )
        } else {
            ;(root as any).prepend(style)
        }
    }
    searchState.styledRoots.add(root)
}

// could use a weak set here instead of only remembering the last root
let lastStyledRoot = null
// Add a range to the "tridactyl-find" highlights, adding the css styles if necessary
// this is the main performance hit by far
// maybe we could only show a maximum number of highlights around the active highlight
function highlightRange(range: Range) {
    const root = range.startContainer.getRootNode()
    if (root !== lastStyledRoot) {
        addHighlightStyles(root, range.startContainer)
        lastStyledRoot = root
    }

    const win = range.startContainer.ownerDocument.defaultView
    const highlights = getOrCreateHighlights(win).highlights

    // might it be faster to create a new Highlight() each time
    // initialised with a batch of ranges?
    highlights.add(range)
}

// just checking
export function overlayAllMatches() {
    document.querySelectorAll("#TridactylFindHost").forEach(el => el.remove())
    const host = document.createElement("div")
    host.id = "TridactylFindHost"
    host.style.position = "absolute"
    host.style.top = "0"
    host.style.left = "0"
    for (const staticRange of searchState.matches) {
        const rects = staticRangeClientRects(staticRange)
        for (const rect of rects) {
            const overlay = document.createElement("div")
            overlay.style.position = "absolute"
            overlay.style.left = `${rect.left + window.scrollX}px`
            overlay.style.top = `${rect.top + window.scrollY}px`
            overlay.style.width = `${rect.width}px`
            overlay.style.height = `${rect.height}px`
            overlay.style.backgroundColor = "rgba(62,104,215,0.5)"
            overlay.style.pointerEvents = "none"
            host.appendChild(overlay)
        }
    }
    document.documentElement.appendChild(host)
}

// We do need a real range to get client rects, I just don't want too many live ranges hanging about before GC
function setReuseRange(staticRange: StaticRange) {
    reuseRange.setStart(staticRange.startContainer, staticRange.startOffset)
    reuseRange.setEnd(staticRange.endContainer, staticRange.endOffset)
    return reuseRange
}

function staticRangeBoundingRect(staticRange: StaticRange) {
    reuseRange.setStart(staticRange.startContainer, staticRange.startOffset)
    reuseRange.setEnd(staticRange.endContainer, staticRange.endOffset)
    return reuseRange.getBoundingClientRect()
}

function staticRangeClientRects(staticRange: StaticRange) {
    reuseRange.setStart(staticRange.startContainer, staticRange.startOffset)
    reuseRange.setEnd(staticRange.endContainer, staticRange.endOffset)
    return reuseRange.getClientRects()
}

function areHighlightsVisible() {
    const iter = frames.values()
    let frame = iter.next()
    while (!frame.done) {
        if ((frame.value.CSS as any).highlights.get("tridactyl-find").size > 0)
            return true
    }
    return false
}

export function highlightAllMatches() {
    highlightMatchSlice(0, searchState.matches.length)
}

// this is MUCH MUCH faster than adding a single range at a time
// perhaps batch ranges to be highlighted as you search then call this with requestAnimationFrame or something
// limit it to some number of highlights around the active highlight
// move the highlight slice as you move through matches (unless total highlights <= max highlights)
//
// to is exclusive
//
// this can force us to wait for it to finish if MAX_HIGHLIGHTS is large
export function highlightMatchSlice(from = 0, to = searchState.matches.length) {
    for (let i = 0; i < searchState.matchesPerFrame.length; ++i) {
        let { frame, startIndex } = searchState.matchesPerFrame[i]
        startIndex = Math.max(startIndex, from)

        const endIndex = Math.min(
            to,
            searchState.matchesPerFrame[i + 1]?.startIndex ||
                searchState.matches.length,
        )

        if (startIndex >= endIndex) continue

        const matches = searchState.matches.slice(startIndex, endIndex)

        const hl = new (frame as any).Highlight(
            ...searchState.matches.slice(startIndex, endIndex),
        )

        hl.priority = 1
        frames.add(frame)
        ;(frame.CSS as any).highlights.set("tridactyl-find", hl)
    }
}

export function getMatches() {
    return searchState.matches
}

function clearHighlights() {
    // normalHighlightObjects.forEach(hl => {
    //     hl.clear()
    // })
    frames.forEach(frame => {
        ;((frame as any).CSS as any).highlights.get("tridactyl-find")?.clear()
    })
}

function clearActiveHighlight() {
    // activeHighlightObjects.forEach(hl => {
    //     hl.clear()
    // })
    frames.forEach(frame => {
        ;((frame as any).CSS as any).highlights
            .get("tridactyl-find-active")
            ?.clear()
    })
}

async function searchRe(...query: string[]) {
    searchState.searchAbortController.abort()

    let flags = "gi"
    let doubleHyphen = false
    let i = 0
    while (query[i] && query[i].startsWith("-") && !doubleHyphen) {
        const argFlags = query[i].slice(1)

        for (const flag of argFlags) {
            // negate default global and case insensitivity with capital letters
            if (flag === "G") {
                flags = flags.replace("g", "")
            } else if (flag === "I") {
                flags = flags.replace("i", "")
            } else if (argFlags === "-") {
                doubleHyphen = true
                break
            } else {
                // honestly do any other regex flags make sense in this context anyway
                flags += flag
            }
        }
        ++i
    }
    let queryString = query.slice(i).join(" ")

    // smart case sensitivity
    if (/[A-Z]/.test(queryString)) {
        flags = flags.replace("i", "")
    }

    if (!queryString || queryString === "") {
        removeHighlighting()
        return []
    }

    // BUT WAIT this isn't VIM syntax! Do VIM syntax instead
    // could attempt to get flags like this /query/flags
    const regexSyntax = /(?<!\\)\/(?!.*(?<!\\)\/)([a-zA-Z]+)$/
    const regexSyntaxFlags = regexSyntax.exec(queryString)

    if (regexSyntaxFlags) {
        let reflags = regexSyntaxFlags[1]
        //        reflags = reflags.replaceAll(/[^igsmyuIG]/);
        if (reflags.includes("G")) {
            flags = flags.replace("g", "")
            reflags = reflags.replace("G", "")
        }
        if (reflags.includes("I")) {
            flags = flags.replace("i", "")
            reflags = reflags.replace("I", "")
        }

        if (reflags.includes("g")) {
            reflags = reflags.replace("g", "")
        }
        if (reflags.includes("i")) {
            reflags = reflags.replace("i", "")
        }
        queryString = queryString.slice(0, regexSyntaxFlags.index)
        flags += reflags
    }

    let re
    try {
        re = RegExp(queryString, flags)
    } catch (e) {
        // Invalid regex (but that's okay, we're probably still typing)
        return []
    }

    const abortController = new AbortController()
    searchState.searchAbortController = abortController
    searchState.matches = []
    searchState.matchesPerFrame = []

    // Surely we can prevent duplicate matches without this...
    searchState.uniqueMatchesMap = new Map()
    searchState.searchQuery = re

    let foundFirst = false
    let foundLast = false // for reverse search

    const matches = searchState.matches
    const framesWithMatches = searchState.matchesPerFrame

    // Perhaps adding this will sort out that issue
    addHighlightStyles(document)
    let lastBlockFrame = null
    let lastStyledBlockRoot = document
    let blockIdx = 0

    return new Promise((resolve, _reject) => {
        const searchBlocks = async () => {
            while (blockIdx < searchState.searchBlocks.length) {
                if (abortController.signal.aborted) {
                    resolve(matches)
                }

                const blockRoot =
                    searchState.searchBlocks[blockIdx].nodes[0].getRootNode()
                const blockFrame =
                    searchState.searchBlocks[blockIdx].nodes[0].ownerDocument
                        .defaultView

                // pretty sure we can't revisit iframes so just storing last should be fine
                if (blockFrame !== lastBlockFrame) {
                    lastBlockFrame = blockFrame
                    framesWithMatches.push({
                        frame: blockFrame,
                        startIndex: matches.length,
                    })
                }

                const blockMatches = await searchBlockText(
                    searchState.searchBlocks[blockIdx],
                    re,
                )

                if (blockMatches.length > 0) {
                    if (lastStyledBlockRoot !== blockRoot) {
                        lastStyledBlockRoot = blockRoot
                        styleShadow(blockRoot)
                    }

                    matches.push(...blockMatches)

                    // if reverse, rect bottom < innerHeight
                    // probably want to check left/right too
                    // this (adding reverse/from view) is more complex than expected! making a mess!
                    if (
                        (!foundFirst && !searchState.reverse) ||
                        (!foundLast &&
                            searchState.reverse &&
                            searchState.fromView)
                    ) {
                        let first
                        if (!searchState.fromView && !searchState.reverse)
                            first = 0
                        else {
                            if (searchState.reverse) {
                                first = (blockMatches as any).findLastIndex(
                                    range => compareRangetoView(range) <= 0,
                                )
                            } else {
                                first = blockMatches.findIndex(
                                    range => compareRangetoView(range) >= 0,
                                )
                            }
                        }

                        if (first >= 0) {
                            foundFirst = true
                            if (!searchState.reverse) {
                                clearHighlights()
                                searchState.activeMatchIdx =
                                    matches.length - blockMatches.length + first
                                focusHighlight(
                                    searchState.activeMatchIdx,
                                    false,
                                )
                            } else {
                                searchState.activeMatchIdx =
                                    matches.length - blockMatches.length + first
                            }
                        } else {
                            if (searchState.reverse && foundFirst) {
                                foundLast = true
                                focusHighlight(
                                    searchState.activeMatchIdx,
                                    false,
                                )
                            }
                        }
                    }
                }

                ++blockIdx
            }

            if (abortController.signal.aborted) {
                resolve(matches)
                return
            }

            if (searchState.buildingSearchBlocks) {
                onNextBlockBuilt(searchBlocks)
                return
            }

            abortController.abort()
            if (searchState.matches.length === 0) {
                removeHighlighting()
            } else {
                // sort this mess out!
                if (searchState.reverse && !searchState.fromView) {
                    searchState.activeMatchIdx = searchState.matches.length - 1
                    focusHighlight(searchState.activeMatchIdx)
                } else if (!foundFirst) {
                    if (searchState.reverse) {
                        searchState.activeMatchIdx =
                            searchState.matches.length - 1
                        focusHighlight(searchState.activeMatchIdx)
                    } else {
                        searchState.activeMatchIdx = 0
                        focusHighlight(searchState.activeMatchIdx)
                    }
                }
                highlightAround(searchState.activeMatchIdx)
            }
            resolve(matches)
        }

        if (
            searchState.searchBlocks.length === 0 &&
            !searchState.buildingSearchBlocks
        ) {
            onNextBlockBuilt(searchBlocks)
            buildSearchBlocks(document.body)
        } else {
            searchBlocks()
        }
    })
}

// find regex matches within a single one of our blocks
async function searchBlockText(block, regex) {
    const abortController = searchState.searchAbortController

    const { nodes, normalisedText } = block
    const text = normalisedText.normalised
    const getRawIndex = normalisedText.getRawIndex
    const matches = []

    // Avoid horrible terrible bad regex mistakes by splitting long strings up
    const CHUNK_SIZE = 1024 // powers of 2 are more cool and gooder

    let lastSubstantialIdx = -1

    for (let offset = 0; offset < text.length; offset += CHUNK_SIZE) {
        const chunk = text.slice(offset, offset + CHUNK_SIZE)
        regex.lastIndex = 0
        let match

        while ((match = regex.exec(chunk)) !== null) {
            // time-slicing, yielding every 8ms atm
            if (performance.now() > sliceEnd) {
                await new Promise(setTimeout as any)
                sliceEnd = performance.now() + SLICE_MS
                if (abortController.signal.aborted) {
                    return matches
                }
            }

            // compute absolute indices in the original text
            const normStart = offset + match.index
            const rawStart = getRawIndex(normStart)

            const normEnd = normStart + match[0].length - 1
            const rawEnd = getRawIndex(normEnd) + 1

            let startNodeIdx = 0
            let endNodeIdx = 0

            let remainingStart = rawStart
            let remainingEnd = rawEnd

            // Find start node + offset
            while (remainingStart >= nodes[startNodeIdx].length) {
                remainingStart -= nodes[startNodeIdx].length
                startNodeIdx++
            }
            const startOffset = remainingStart

            // Find end node + offset
            while (remainingEnd > nodes[endNodeIdx].length) {
                remainingEnd -= nodes[endNodeIdx].length
                endNodeIdx = Math.min(endNodeIdx + 1, nodes.length - 1)
            }
            const endOffset = remainingEnd

            if (!nodes[startNodeIdx].isConnected) {
                continue
            }

            // const range = document.createRange()
            const range = reuseRange
            range.setStart(nodes[startNodeIdx], startOffset)
            range.setEnd(nodes[endNodeIdx], endOffset)

            if (startNodeIdx === lastSubstantialIdx || isSubstantial(range)) {
                lastSubstantialIdx = startNodeIdx

                // shall i prevent duplicates? Sure
                // can happen because I change … to ... (anything else?)
                // there may be a better way to solve this (like just not doing that?)
                const nodeMatches = (
                    searchState.uniqueMatchesMap as any
                ).getOrInsert(range.startContainer, new Set())
                if (nodeMatches.has(range.startOffset)) {
                    continue
                } else {
                    nodeMatches.add(range.startOffset)
                }

                // matches.push(range)
                matches.push(new StaticRange(range))
            }

            // prevent zero-length infinite loops
            if (match[0].length === 0) {
                regex.lastIndex++
            }
        }
    }
    return matches
}

// using callbacks so we can search for text as we build search blocks
// generally building search blocks is pretty quick so maybe we could
// simplify and just wait for it to finish instead
let nextBlockWaiters = []
function onNextBlockBuilt(callback) {
    nextBlockWaiters.push(callback)
}

function blockBuilt() {
    nextBlockWaiters.forEach(callback => callback())
    nextBlockWaiters = []
}

// group nodes into true "blocks" - where text nodes are inline within a block
// block text is normalised so we can search for á with a and such
// a block is currently represented as an array containing the block's full range,
// all the nodes in the block, and the normalised text
async function buildSearchBlocks(startNode = document.body) {
    searchState.buildingSearchBlocks = true
    const blocks = []
    searchState.searchBlocks = blocks

    let currBlock = null
    let currBlockNodes = []

    const textNodeCallback = node => {
        const { block, whiteSpace } = getBlockOwner(node)
        if (currBlock !== block) {
            if (currBlockNodes.length > 0) {
                blocks.push({
                    nodes: currBlockNodes,
                    normalisedText: stringNormaliser(
                        currBlockNodes.map(n => n.nodeValue).join(""),
                        whiteSpace,
                        2, // magic number currently, maybe config setting?
                    ),
                })
                blockBuilt()
            }

            currBlock = block
            currBlockNodes = [node]

            try {
                reuseRange.selectNodeContents(node)
            } catch (e) {
                currBlock = null
                currBlockNodes = []
            }
        } else if (currBlock !== null) {
            currBlockNodes.push(node)
        }
    }

    await walk_iterative(startNode, textNodeCallback)

    searchState.buildingSearchBlocks = false

    // In case some async stuff causes a miss or something
    if (nextBlockWaiters.length) blockBuilt()

    clearBlocksCacheAfterMs(3000)

    return searchState.searchBlocks
}

// like walking with a TreeWalker but we can go into (same-origin) iframes and shadow DOMs
// callback is called for text nodes specifically
// was recursive, made an iterative version... can probably lose the _iterative suffix now it's the only one
async function walk_iterative(startNode, callback) {
    searchState.walkingAbortController.abort()
    searchState.walkingAbortController = new AbortController()
    const abortController = searchState.walkingAbortController

    const stack = [startNode]
    // Shadows & slots make it hard to not revisit nodes so going the easy route of keeping track of nodes visited
    const walked = new Set()
    // const calledback = new Set() // temporary, checking for duplicate nodes passed to callback()
    const push = node => {
        if (!walked.has(node)) {
            walked.add(node)
            stack.push(node)
            return true
        }
        return false
    }

    // for searching specifically we don't want invisible nodes
    // if walk_iterative was repurposed for general walking, probably would give it a filter parameter
    const skipTags = new Set([
        "SCRIPT",
        "STYLE",
        "LINK",
        "META",
        "NOSCRIPT",
        "TEMPLATE",
    ])

    while (stack.length) {
        if (performance.now() > sliceEnd) {
            await new Promise(setTimeout as any)
            sliceEnd = performance.now() + SLICE_MS
            if (abortController.signal.aborted) {
                return
            }
        }
        const node = stack.pop()

        if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim()) {
            if (!node.parentElement) {
                // Not a big fan of this :) but it does make highlights work for shadows with only text nodes
                const s = document.createElement("span")
                node.replaceWith(s)
                s.append(node)
                stack.push(node) // Ignoring the walked set with this push seeing as we've definitely already walked it
            } else if (
                !skipTags.has(node.parentElement.tagName) &&
                isSubstantial(node.parentElement)
            ) {
                callback(node)
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === "IFRAME" && node.contentDocument?.body) {
                push(node.contentDocument.body)
                continue
            }
            const children = getComposedChildren(node)

            for (let i = children.length - 1; i >= 0; --i) {
                push(children[i])
            }
        }
    }

    clearBlocksCacheAfterMs(3000)

    // could return the walked set?
    // That way this could still be useful if you don't pass a callback
}

// figure out if a node should be inline with its siblings
// now also returns the white-space rule so we know whether to replace "\n" with " "
// I think it should return a bool though, we don't need to know the actual rule elsewhere do we?
export function getBlockOwner(node) {
    let el = node.parentElement
    let whiteSpace: string | null = null

    while (el) {
        const cs = getComputedStyle(el)
        const disp = cs.display

        // capture white-space if not already found
        if (!whiteSpace) {
            whiteSpace = cs.whiteSpace
        }

        if (
            disp === "block" ||
            disp === "list-item" ||
            disp === "flex" ||
            disp === "grid" ||
            disp === "table" ||
            disp === "table-cell" ||
            disp === "flow-root"
        ) {
            return { block: el, whiteSpace }
        }

        if (disp === "none" || cs.visibility === "hidden") {
            return { block: null, whiteSpace }
        }

        el = el.parentElement
    }

    return { block: node.ownerDocument.body, whiteSpace }
}

// untangle slots and shadows so we can walk everything
// it might nice to keep track of shadows as we go for styling actually
export function getComposedChildren(elem) {
    const out = []

    // 1. slot assigned nodes
    if (elem.tagName === "SLOT") {
        const assigned = elem.assignedNodes({ flatten: true })
        if (assigned.length) {
            out.push(...assigned)
            return out
        }
        out.push(...elem.childNodes)
        return out
    }

    // 2. shadow root
    const shadow = elem.openOrClosedShadowRoot
    if (shadow) {
        out.push(...shadow.childNodes)
    }

    // 3. normal children (skip assignedSlot duplicates)
    for (const child of elem.childNodes) {
        if (!child.assignedSlot) out.push(child)
    }

    return out
}

// potentially useful but not used currently
// this would probably go to lib/dom.ts (along with some other things here)
/* function getComposedParent(node) {
    if (!node) return null

    // 1. Assigned slot (slotted content)
    if (node.assignedSlot) {
        return node.assignedSlot
    }

    // 2. Normal DOM parent
    if (node.parentNode) {
        return node.parentNode
    }

    // 3. Shadow root → host
    const root = node.getRootNode()
    if (root instanceof ShadowRoot) {
        return root.host
    }

    // 4. Iframe document → iframe element (same-origin only)
    if (node.ownerDocument && node.ownerDocument.defaultView) {
        try {
            return node.ownerDocument.defaultView.frameElement || null
        } catch (e) {
            // Cross-origin: cannot escape
            return null
        }
    }

    return null
}*/

// not quite dom.ts' isVisible or isSubstantial
function isSubstantial(thing) {
    if (thing instanceof Element) {
        while (typeof thing.getBoundingClientRect !== "function") {
            thing = thing.parentElement
        }
    }
    // Was only doing this and calling getComputedStyle if we had rects, but display: contents is annoying!
    let element
    if (thing instanceof Range) {
        element = thing.startContainer
        if (element.nodeType !== Node.ELEMENT_NODE) {
            element = element.parentElement
        }
    } else {
        element = thing
    }

    // Can be pure text node in shadow dom (no parent el but a client rect)
    // example: github's timestamps
    // I was wrapping them in spans but don't fancy messing with the DOM that much
    if (!element) {
        return (thing as Node)?.nodeType === Node.TEXT_NODE
    }
    const computedStyle = getComputedStyle(element)

    // TODO: test this makes sense...
    // if a display: contents; element has only text node chlidren, might need to check the element's parent
    if (computedStyle.display === "contents") {
        return [...element.childNodes].some(node => {
            switch (node.nodeType) {
                case Node.ELEMENT_NODE: return isSubstantial(node as Element)
                case Node.TEXT_NODE: return node.textContent.trim().length > 0 // might not be visible though?
                default: return false
            }
        })
    }

    // something to do with shadow DOMs(?) - there might be no clientRects for us
    const clientRect = thing.getClientRects()[0]
        ? thing.getBoundingClientRect()
        : null

    // I was excluding small letters like "i" and "l" with 4px, sooo, 0px it is
    // Now checking that rect is currently within the entire page bounds (not tested)
    switch (true) {
        case !clientRect:
        case clientRect.width <= 1: // or === 0 if you want to be sure
        case clientRect.height <= 1:
            return false
    }

    // remove elements that are barely within the viewport, tiny, or invisible
    // I'm sure the widthMatters and heightMatters are important but I don't understand them
    switch (true) {
        case computedStyle.visibility !== "visible":
        case computedStyle.display === "none":
            return false
    }

    return true
}

// Scrolling needs some smarts I can't think no good
// - there was an import in the original finding.ts that might be what i'm after
// scrollCompute, have a look at that
function scrollRangeIntoView(range) {
    range.startContainer.parentElement?.scrollIntoView()
    let win = range.startContainer.ownerDocument.defaultView
    let rect = staticRangeBoundingRect(range) as any

    // Step 1: scroll inside the iframe/window where the match lives
    {
        const targetY =
            rect.top + win.scrollY - (win.innerHeight - rect.height) / 2

        win.scrollTo({ top: targetY })
    }

    // Step 2: bubble up through parent frames
    while (win.frameElement) {
        const iframe = win.frameElement
        const parentWin = win.parent

        const iframeRect = iframe.getBoundingClientRect()

        // Convert rect to parent coordinates
        const rectInParent = {
            top: iframeRect.top + rect.top,
            height: rect.height,
        }

        const targetY =
            rectInParent.top +
            parentWin.scrollY -
            (parentWin.innerHeight - rectInParent.height) / 2

        parentWin.scrollTo({ top: targetY })

        // Move up
        win = parentWin
        rect = rectInParent
    }
}

// Hey this doesn't check left/right ... that's what I get for asking an LLM for help
// TODO: add those left/right checks in
function isRangeInView(range) {
    let win = range.startContainer.ownerDocument.defaultView
    let rect: DOMRect | { top: number, bottom: number, height: number, left?: number, right?: number } = staticRangeBoundingRect(range)

    // Step 1: check visibility inside the window where the match lives
    if (rect.bottom <= 0 || rect.top >= win.innerHeight) {
        return false
    }

    // Step 2: bubble up through parent frames
    while (win.frameElement) {
        const iframe = win.frameElement
        const parentWin = win.parent

        const iframeRect = iframe.getBoundingClientRect()

        // Convert rect to parent coordinates
        rect = {
            top: iframeRect.top + rect.top,
            bottom: iframeRect.top + rect.bottom,
            height: rect.height,
        }

        // Check visibility in parent window
        if (rect.bottom <= 0 || rect.top >= parentWin.innerHeight) {
            return false
        }

        win = parentWin
    }

    return true
}

// TODO: find a page with some same-origin iframes so you can check it works at all!
// rewrite of isRangeInView to let us know in which way a range is out of view (or not)
// returns 0 if range is in view
// -1 if range is above or left of view (or compared to its parent iframe(s))
// 1 if range is below or right of view
function compareRangetoView(range) {
    let win = range.startContainer.ownerDocument.defaultView
    let rect: DOMRect | { top: number, bottom: number, height: number, left?: number, right?: number } = staticRangeBoundingRect(range)

    let iframeRect
    let iframeCompare = 0
    while (win.frameElement) {
        const iframe = win.frameElement
        const parentWin = win.parent

        iframeRect = iframe.getBoundingClientRect()

        // get absolute rect relative to top window view
        rect = {
            top: iframeRect.top + rect.top,
            bottom: iframeRect.top + rect.bottom,
            height: rect.height,
        }

        // haven't tested this!
        if (rect.bottom <= iframeRect.top || rect.right <= iframeRect.left) {
            iframeCompare = -1
            break
        } else if (
            rect.top >= iframeRect.bottom ||
            rect.left >= iframeRect.right
        ) {
            iframeCompare = 1
            break
        }

        win = parentWin
    }

    if (iframeRect && iframeCompare === 0) {
        // is iframe itself before or after view?
        if (iframeRect.bottom <= 0 || iframeRect.right <= 0) return -1
        if (
            iframeRect.top >= window.innerHeight ||
            iframeRect.left >= window.innerWidth
        )
            return 1
        return 0
    }

    if (rect.bottom <= 0 || rect.right <= 0) return -1
    if (rect.top >= window.innerHeight || rect.left >= window.innerWidth)
        return 1
    return 0
}

function setActiveRange(range, focus = false) {
    scrollRangeIntoView(range)

    clearActiveHighlight()

    const win = range.startContainer.ownerDocument.defaultView

    const activeHighlight = getOrCreateHighlights(win).activeHighlight

    activeHighlight.clear()
    activeHighlight.add(range)

    // mainly this is so we can match default browser search behaviour
    if (focus && range.startContainer.parentElement)
        range.startContainer.parentElement.focus()
}

// seems this one's no longer used (must've been from before I tried to match the old finding.ts behaviour)
function gotoMatch(idx: number) {
    if (searchState.matches.length === 0) return null
    if (!areHighlightsVisible()) highlightAllMatches()

    idx = idx % searchState.matches.length
    if (idx < 0) idx = searchState.matches.length + idx

    searchState.activeMatchIdx = idx

    const range = searchState.matches[idx]

    setActiveRange(range)
    return searchState.matches[idx]
}

/* function next(n: number = 1) {
    return gotoMatch(searchState.activeMatchIdx + n)
}

function prev(n: number = 1) {
    return gotoMatch(searchState.activeMatchIdx - n)
}*/

// Levels maybe better off as flags
// levels 1, 2 and 3 correspond to:
// Replace lookalike punctuation chars, strip accents, full NFKC normalisation
// whiteSpace rule decides whether newline chars \n will be converted to spaces (make it a bool?)
// some changes could change the size of the string so we also return a map of normalised indices to raw indices
// the index map will normally be i -> i (unchanged) so we check whether we need it
// now using getRawIndex(i) which can be either i=>i or i=>map[i]
export function stringNormaliser(str: string, whiteSpaceRule: string, level) {
    const NORMALISE_LEVELS = {
        none: 0,
        punctuation: 1,
        accents: 2,
        full: 3,
    }
    // let rawIndex = 0
    let normIndex = 0

    const normChars = []
    const map = [] // map[normIndex] = rawIndex

    let unchanged = true
    let useIdxMap = false

    const pushNoIndex = (ch, _rawPos) => {
        normChars.push(ch)
    }

    const pushWithIndex = (ch, rawPos) => {
        normChars.push(ch)
        // map[normIndex] = rawPos
        map.push(rawPos)
    }

    let push = (_ch, _rawPos) => undefined

    // avoiding some extra work if it's not necessary
    const pushAllCharsBefore = idx => {
        normChars.push(...str.slice(0, idx))
    }

    const pushAllIndicesBefore = idx => {
        for (let i = 0; i < idx; ++i) {
            map.push(i)
        }
    }

    let squashingWhitespace = false
    // Exhuastive "whitespace is real" rules list here? Probably not.
    const isRealWhitespace = ["pre", "pre-wrap", "pre-line", "break-spaces"].includes(whiteSpaceRule)

    // Fake leading whitespace should be stripped entirely
    if (!isRealWhitespace && /\s/.test(str[0])) {
        squashingWhitespace = true
    }

    for (let i = 0; i < str.length; i++) {
        const rawChar = str[i]
        let out = rawChar

        // Messing with whitespace is necessary, but the ways we change it might be worth exposing as options
        // we're supporting flags with the /query/xyz syntax, so we could add our own in there
        // also the "levels" of normalisation that we're not actually changing could be set in the query

        // even if newlines are "real"... would you rather have to type "\n" (or "\s") than " "?
        // default ctrl-f would use " "
        if (!isRealWhitespace && /\s/.test(rawChar)) {
            if (!squashingWhitespace) {
                out = " "
                squashingWhitespace = true
            } else {
                // Squash multiple whitespace chars to one space
                out = "" 
            }
        } else {
            squashingWhitespace = false
        }

        // 1. NFKD accent stripping
        if (level >= NORMALISE_LEVELS.accents) {
            const decomposed = out.normalize("NFKD")
            const base = decomposed.replace(/[\u0300-\u036f]/g, "")
            out = base
        }

        // 2. punctuation normalisation
        if (level >= NORMALISE_LEVELS.punctuation) {
            out = out
                .replace(/[‘’‚‛]/g, "'")
                .replace(/[“”„‟]/g, '"')
                .replace(/[‐‑‒–—―]/g, "-")
                .replace(/[…]/g, "...") // native finding does NOT match ... to … so this one's debatable
        }

        // I have not tested this one at all :)
        // 3. NFKC compatibility (ligatures etc.)
        if (level >= NORMALISE_LEVELS.full) {
            out = out.normalize("NFKC")
        }

        if (unchanged && out !== rawChar) {
            unchanged = false
            push = pushNoIndex
            pushAllCharsBefore(i)
        }

        if (!useIdxMap && rawChar.length !== out.length) {
            useIdxMap = true
            push = pushWithIndex
            pushAllIndicesBefore(i)
        }

        // out may now be multiple characters (e.g. "…" → "...") so push every char and the index of the original char
        for (const ch of out) {
            push(ch, i)
            ++normIndex
        }
    }

    const getRawIndex = useIdxMap ? i => map[i] : i => i

    return {
        normalised: unchanged ? str : normChars.join(""),
        getRawIndex,
    }
}
