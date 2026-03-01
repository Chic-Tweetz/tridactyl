// import * as config from "@src/lib/config"
// import * as DOM from "@src/lib/dom"
// import { browserBg, activeTabId } from "@src/lib/webext"
// import state from "@src/state"
// import * as State from "@src/state"
// import { compute as scrollCompute } from "compute-scroll-into-view"
import { showAlternateInput } from "./commandline_content"


// nasty performance hit if you do a bunch of searches
// memory usage seems to climb (is it our match ranges?)
// so something's not being garbage collected somewhere? I guess
// try doing like 20+ searches for .
// then do a hint and see how long it takes to register the hint keypresses - very odd

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
    onBlockBuilt: ([]) => Promise<void> | void
    onLastBlockBuilt: () => Promise<void> | void
    activeMatchIdx: number
    fromView: boolean
    foundFirst: boolean
    uniqueMatchesMap: Map<Node, Set<number>>
    onAllNodesWalked: () => Promise<void> | void
    clearSearchBlocksTimer: number
}

const searchState: SearchState = {
    searchAbortController: new AbortController(),
    walkingAbortController: new AbortController(),
    buildingSearchBlocks: false,
    searchQuery: null,
    matches: [],
    searchBlocks: [],
    onBlockBuilt: () => undefined,
    onLastBlockBuilt: () => undefined,
    activeMatchIdx: -1,
    fromView: false,
    foundFirst: false,
    uniqueMatchesMap: new Map(),
    onAllNodesWalked: () => undefined,
    clearSearchBlocksTimer: null,
}

// Currently we yield every 8ms when searching/building our search blocks, keeps everything responsive
const SLICE_MS = 8
let sliceEnd = performance.now() + SLICE_MS

// iframes get their own highlight registries
const framesToHighlights = new Map()
// all highlight registries stored in these arrays for easy disabling
const normalHighlightObjects = []
const activeHighlightObjects = []

// Add an input to the cmdilne iframe to call our search oninput
// this isn't the only option for incsearch, but I thought I'd try it
// because it could be useful to hide inputs in the iframe for other reasons
// like IME vimperator hinting https://github.com/tridactyl/tridactyl/discussions/5337
export function searchbar() {
    showAlternateInput(
        str => searchRe(str),
        () => focusHighlight(searchState.activeMatchIdx, true),
        () => removeHighlighting(),
        "find",
    )
}

// I've renamed/wrapped some functions to match the original finding.ts API
// but now I'm confused about what does what :)
export function jumpToMatch(searchQuery, option) {
    if (option.searchFromView) {
        console.log("just making the linter happy right now")
    }
    return searchRe(searchQuery)
}

export function jumpToNextMatch(n: number, _searchFromView = false) {
    return gotoMatch(searchState.activeMatchIdx + n)
}

export function focusHighlight(index: number, focus = false) {
    const range = searchState.matches[index]
    if (range) setActiveRange(range, focus)
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

function clearBlocksCache() {
    if (searchState.searchAbortController.signal.aborted) {
        console.log("search blocks cleared")
        searchState.searchBlocks = []
        return true
    } else {
        console.log("search blocks not cleared: abortSignal not present")
        clearBlocksCacheAfterMs(3000)
        return false
    }
}

function clearBlocksCacheAfterMs(afterMs = 5000) {
    clearTimeout(searchState.clearSearchBlocksTimer)
    searchState.clearSearchBlocksTimer = setTimeout(clearBlocksCache, afterMs)
}

// Add highlight registries to a frame
function getOrCreateHighlights(win = window) {
    if (framesToHighlights.get(win)) return framesToHighlights.get(win)
    const hl = new (win as any).Highlight()
    const hla = new (win as any).Highlight()
    hl.priority = 1
    hla.priority = 2
    ;(win.CSS as any).highlights.set("tridactyl-find", hl)
    ;(win.CSS as any).highlights.set("tridactyl-find-active", hla)

    framesToHighlights.set(win, {
        highlights: hl,
        activeHighlight: hla,
    })

    normalHighlightObjects.push(hl)
    activeHighlightObjects.push(hla)
    return framesToHighlights.get(win)
}

// This should be part of the normal .CSS files
// we should attempt to share the stylesheet with shadow roots
// failing that, we should either inject styles as we already do
// or we should use overlays (perhaps choose using a config setting)
function addHighlightStyles(addto: Node = document.head) {
    const root: Document | DocumentFragment | ShadowRoot =
        addto.getRootNode() as any
    const win = addto.ownerDocument.defaultView

    getOrCreateHighlights(win)

    if (!root.querySelector) {
        console.warn("This Root Has No queryrryyryr", root, addto)
    }
    if (root.querySelector(".TridactylHighlights")) return
    const style = document.createElement("style")
    style.textContent = `
::highlight(tridactyl-find) {
  background-color: rgba(62,104,215,1);
  color: rgb(200,211,245);
}

::highlight(tridactyl-find-active) {
  background-color: rgba(255,150,108,1);
  color: rgb(27,29,43);
}

input.TridactylFindInput:focus {
    outline: none;
    display: inline-flex;
    color: var(--tridactyl-cmdl-fg);
}

input.TridactylFindInput {
    font-family: monospace;
    border: 1px solid rgb(50,150,200);
}

input.TridactylFindInput::before {
    content: "/";
}

.loader {
    width: 12px;
    height: 12px;
    border: 2px solid #11e85c;
    border-bottom-color: transparent;
    border-radius: 50%;
    display: inline-flex;
    box-sizing: border-box;
    animation: rotation 1s linear infinite;
    }

    @keyframes rotation {
    0% {
        transform: rotate(0deg);
    }
    100% {
        transform: rotate(360deg);
    }
}
    
.loader.blocks {
    border: 2px solid rgb(255, 140, 0);
    border-bottom-color: transparent;
    border-radius: 50%;
}`

    style.className = "TridactylHighlights"

    const maybeHead = root.querySelector("head")
    if (maybeHead) maybeHead.appendChild(style)
    else {
        const firstChild = (root as any).body?.children[0] || root.children
        if (!firstChild) {
            ;(addto as any).prepend(style)
        } else {
            root.prepend(style)
        }
    }
}

let lastStyledRoot = null
// Add a range to the "tridactyl-find" highlights, adding the css styles if necessary
function highlightRange(range: Range) {
    const root = range.startContainer.getRootNode()
    if (root !== lastStyledRoot) {
        addHighlightStyles(range.startContainer)
        lastStyledRoot = root
    }

    const win = range.startContainer.ownerDocument.defaultView
    const highlights = getOrCreateHighlights(win).highlights

    highlights.add(range)
}

function areHighlightsVisible() {
    return !normalHighlightObjects.every(hl => hl.size === 0)
}

function highlightAllMatches() {
    clearHighlights()
    searchState.matches.forEach(match => {
        highlightRange(match)
    })
}

function clearHighlights() {
    normalHighlightObjects.forEach(hl => {
        hl.clear()
    })
}

function clearActiveHighlight() {
    activeHighlightObjects.forEach(hl => {
        hl.clear()
    })
}

/* function abortSearch() {
    searchState.searchAbortController.abort()
}

function abortWalking() {
    searchState.walkingAbortController.abort()
}*/

async function searchRe(...query: string[]) {
    searchState.searchAbortController.abort()

    // let searchFromView = true
    // let reverse = false

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

    console.log(re, "new search")

    const abortController = new AbortController()
    searchState.searchAbortController = abortController
    searchState.matches = []

    // Surely we can prevent duplicate matches without this...
    searchState.uniqueMatchesMap = new Map()
    searchState.foundFirst = false
    searchState.searchQuery = re

    const matches = searchState.matches;

    let blockIdx = 0

    const searchBlocks = async () => {
        while (blockIdx < searchState.searchBlocks.length) {
            console.log(re, blockIdx)
            if (abortController.signal.aborted) {
                console.log("SEARCH ABORTED")
                return
            }
            matches.push(...(await searchBlockText(
                searchState.searchBlocks[blockIdx],
                re,
            )))
            ++blockIdx
        }
        if (abortController.signal.aborted) return;

        if (searchState.buildingSearchBlocks) {
            onNextBlockBuilt(searchBlocks)
            return
        }
        
        abortController.abort("Search complete.")
        if (searchState.matches.length === 0) {
            removeHighlighting()
        }
    }

    if (
        searchState.searchBlocks.length === 0 &&
        !searchState.buildingSearchBlocks
    ) {
        console.log("building search blocks")

        searchState.onAllNodesWalked = () => clearBlocksCacheAfterMs(3000)

        onNextBlockBuilt(searchBlocks)
        buildSearchBlocks(document.body)
    } else {
        searchBlocks()
    }

    // It'd probably be better to return once all matches are found
    // perhaps use a deferred promise for the two mid-build possibilities
    // yeah really doesn't make sense to return this yet does it
    return matches
}

// const tempSearched = new Set()
// const tempBlocksSearched = new Set()

async function searchBlockText(block, regex) {
    const abortController = searchState.searchAbortController

    const [_fullRange, nodes, normalisedText] = block
    const text = normalisedText.normalised
    // const rawIdxMap = normalisedText.map
    const getRawIndex = normalisedText.getRawIndex
    const matches = []

/*     if (tempBlocksSearched.has(block)) console.error("DUPLICATE BLOCK!")
    tempBlocksSearched.add(block) */

    // well then... we truly don't search duplicate nodes
    // so how are we getting duplicate matches...
/*     for (const node of nodes) {
        if (tempSearched.has(node)) {
            console.error("duplicate search node!", node)
        } else {
            tempSearched.add(node)
        }
    } */

    // Might want to instead split into an arbitrary chunk size
    // const lines = text.split(/\r?\n/);

    // Avoid horrible terrible bad regex mistakes by splitting long strings up
    const CHUNK_SIZE = 1024 // powers of 2 are more cool and gooder

    let lastSubstantialIdx = -1
    // let lineOffset = 0 // running offset into original text

    // console.log("Block search", block, lines, regex);

    for (let offset = 0; offset < text.length; offset += CHUNK_SIZE) {
        const chunk = text.slice(offset, offset + CHUNK_SIZE)
        regex.lastIndex = 0
        let match

        while ((match = regex.exec(chunk)) !== null) {
            // time-slicing
            if (performance.now() > sliceEnd) {
                await new Promise(setTimeout as any)
                sliceEnd = performance.now() + SLICE_MS
                if (abortController.signal.aborted) {
                    console.log("ABORTED", regex)
                    return matches
                }
            }

            // compute absolute indices in the original text
            const normStart = offset + match.index
            // const rawStart = rawIdxMap[normStart]
            const rawStart = getRawIndex(normStart)

            const normEnd = normStart + match[0].length - 1
            // const rawEnd = rawIdxMap[normEnd] + 1
            const rawEnd = getRawIndex(normEnd) + 1

            // ---- your existing node-mapping logic ----

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

            // skip disconnected nodes, we can't see them
            if (!nodes[startNodeIdx].isConnected) {
                continue
            }

            // Build the range
            const range = document.createRange()
            range.setStart(nodes[startNodeIdx], startOffset)
            range.setEnd(nodes[endNodeIdx], endOffset)

            if (startNodeIdx === lastSubstantialIdx || isSubstantial(range)) {
                lastSubstantialIdx = startNodeIdx

/*                 const nodeMatches = (
                    searchState.uniqueMatchesMap as any
                ).getOrInsert(range.startContainer, new Set())
                if (nodeMatches.has(range.startOffset)) {
                    // riiiight
                    // so we're getting multiple matches for .
                    // on chars we've embiggened
                    // the single char ... to three char ...
                    // gets the same match for each .

                    console.error("Duplicate Match Found!", range.toString(), range, block)

                    continue
                } else {
                    nodeMatches.add(range.startOffset)
}*/

                matches.push(range)
                // we're all synchronous since the last aborted check, think this one can go
                if (!abortController.signal.aborted) {
                    if (
                        !searchState.foundFirst &&
                        ((searchState.fromView === true &&
                            isRangeInView(range)) ||
                            !searchState.fromView)
                    ) {
                        clearHighlights()
                        searchState.foundFirst = true
                        searchState.activeMatchIdx =
                            matches.length + searchState.matches.length - 1
                        setActiveRange(range)
                    }
                    highlightRange(range)
                }
            }

            // prevent zero-length infinite loops
            if (match[0].length === 0) {
                regex.lastIndex++
            }
        }

        // advance offset by line length + 1 (newline)
        // offset += chunk.length + 1;
    }
    return matches
}

let nextBlockWaiters = []
function onNextBlockBuilt(callback) {
    nextBlockWaiters.push(callback)
}

function blockBuilt() {
    nextBlockWaiters.forEach(callback => callback())
    nextBlockWaiters = []
}

async function buildSearchBlocks(startNode = document.body) {
    searchState.buildingSearchBlocks = true
    const blocks = []
    searchState.searchBlocks = blocks

    let currBlock = null
    let currBlockNodes = []
    let currRange = null

    const textNodeCallback = node => {
        const { block, whiteSpace } = getBlockOwner(node)
        if (currBlock !== block) {
            if (currBlockNodes.length > 0) {
                blocks.push([
                    currRange,
                    currBlockNodes,
                    stringNormaliser(
                        currBlockNodes.map(n => n.nodeValue).join(""),
                        whiteSpace,
                        2,
                    ),
                ])
                blockBuilt()
            }

            currBlock = block
            currBlockNodes = [node]
            currRange = document.createRange()
            try {
                // can be blocked: "insecure"
                currRange.selectNodeContents(node)
            } catch (e) {
                currBlock = null
                currBlockNodes = []
            }
        } else if (currRange !== null && currBlock !== null) {
            currBlockNodes.push(node)
            currRange.setEnd(node, node.length)
        }
    }

    await walk_iterative(startNode, textNodeCallback)

    searchState.buildingSearchBlocks = false

    console.log("blocks all built")

    // In case some async stuff causes a miss or something
    if (nextBlockWaiters.length) blockBuilt()

    clearBlocksCacheAfterMs(3000)

    return searchState.searchBlocks
}

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
        }
    }
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
                console.log("Walking aborted!")
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
                // could also filter out visibility:hidden or display:none parent elements here
                // let's just check here with a temporary set...
/*                 if (calledback.has(node)) console.error("Callback Duplicate!", node)
                calledback.add(node)*/
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
    // Kind of mixing callbacks and promises in a way that makes me suspect it's a smell :)
    searchState.onAllNodesWalked()
}

function getBlockOwner(node) {
    let el = node.parentElement
    let whiteSpace = null

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

function getComposedChildren(elem) {
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

function isSubstantial(thing) {
    if (thing instanceof Element) {
        while (typeof thing.getBoundingClientRect !== "function") {
            thing = thing.parentElement
        }
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
    if (!element) {
        return true
    }

    // remove elements that are barely within the viewport, tiny, or invisible
    // Only call getComputedStyle when necessary
    const computedStyle = getComputedStyle(element)
    // I'm sure the widthMatters and heightMatters are important but I don't understand them
    switch (true) {
        case computedStyle.visibility !== "visible":
        case computedStyle.display === "none":
            return false
    }

    return true
}

// Scrolling needs some smarts I can't think no good
function scrollRangeIntoView(range) {
    range.startContainer.parentElement?.scrollIntoView()
    let win = range.startContainer.ownerDocument.defaultView
    let rect = range.getBoundingClientRect()

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
function isRangeInView(range) {
    let win = range.startContainer.ownerDocument.defaultView
    let rect = range.getBoundingClientRect()

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

function setActiveRange(range, focus = false) {
    scrollRangeIntoView(range)
    // if (!isRangeInView(range)) {
    //     scrollRangeIntoView(range);
    // }

    // Didn't seem to work
    // findActiveHighlightObjects.forEach(hl => hl.clear());
    clearActiveHighlight()

    const win = range.startContainer.ownerDocument.defaultView
    const activeHighlight = getOrCreateHighlights(win).activeHighlight

    activeHighlight.clear()
    activeHighlight.add(range)

    // mainly this is so we can match default browser search behaviour
    if (focus && range.startContainer.parentElement)
        range.startContainer.parentElement.focus()
}

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
// the index map will normally be i -> i (unchanged) so we could check whether we need to use it
// maybe replace it with a function getRawIndex(i) which could be either i=>i or i=>map[i]
function stringNormaliser(str: string, whiteSpaceRule: string, level) {
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
    const pushAllCharsBefore = (idx) => {
        normChars.push(...str.slice(0, idx))
    }

    const pushAllIndicesBefore = (idx) => {
        for (let i = 0; i < idx; ++i) {
            map.push(i)
        }
    }

    for (let i = 0; i < str.length; i++) {
        const rawChar = str[i]
        let out = rawChar

        if (rawChar === "\n") {
            if (
                whiteSpaceRule === "pre" ||
                whiteSpaceRule === "pre-wrap" ||
                whiteSpaceRule === "pre-line" ||
                whiteSpaceRule === "break-spaces"
            ) {
                out = "\n" // real line break
            } else {
                out = " " // collapsed whitespace
            }
        }

        // 1. NFKD accent stripping
        if (level >= NORMALISE_LEVELS.accents) {
            const decomposed = rawChar.normalize("NFKD")
            const base = decomposed.replace(/[\u0300-\u036f]/g, "")
            out = base
        }

        // 2. punctuation normalisation
        // now we do one char at a time we can probably swap this regex for a simple string replace yea?
        if (level >= NORMALISE_LEVELS.punctuation) {
            out = out
                .replace(/[‘’‚‛]/g, "'")
                .replace(/[“”„‟]/g, '"')
                .replace(/[‐‑‒–—―]/g, "-")
                .replace(/[…]/g, "...") // native finding does NOT match ... to … so this one's debatable
        }

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
            useIdxMap = true;
            push = pushWithIndex
            pushAllIndicesBefore(i)
        }

        // out may now be multiple characters (e.g. "…" → "...") so push every char and the index of the original char
        for (const ch of out) {
            push(ch, i)
            ++normIndex
        }
    }

    const getRawIndex = useIdxMap ?  i => map[i] : i => i

    return {
        normalised: unchanged ? str : normChars.join(""),
        // map, // normalisedIndex → rawIndex
        getRawIndex,
    }
}
