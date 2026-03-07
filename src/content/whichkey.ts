/**
 * Add a whichkey style popup to the page.
 * Uses a state listener (like the mode indicator)
 * It's a bit silly because we get the parsed keys from the suffix
 * Turn them back into key sequences
 * Match them in a keymap...
 * Basically after parsing a keypress, we recreate it and do it again!
 * It would be more sensible to send a message/event from the key parser itself
 * that would require its own solution anyway
 */

import { addContentStateChangedListener, contentState } from "@src/content/state_content"
import * as keyseq from "@src/lib/keyseq"
import * as State from "@src/state"
import { ownTabId } from "@src/lib/webext"
import { getAsync, removeChangeListener } from "@src/lib/config"
import {
    DEFAULTS,
    USERCONFIG,
    mergeDeepCull,
    addChangeListener,
    get as confget,
} from "@src/lib/config"
import { theme } from "./styling"

let whichkeyIframe: HTMLIFrameElement

let level = "none"
let toggleLevel = "multi"

function init() {
    return createIframe()
        .then(() => listen())
        .catch(() => {
            console.error("couldn't create whichkey iframe")
        })
}

getAsync("whichkey").then(show => {
    if (show !== "none") {
        level = show
        init().then(() => {
            if (level === "all") {
                onStateChanged("mode", "normal", "normal", "normal")
            }
        })
    }
})

let completions
async function createIframe() {
    return new Promise((resolve, reject) => {
        const iframe = document.createElement("iframe")
        iframe.style.position = "fixed"
        iframe.style.right = "40px"
        iframe.style.bottom = "40px"
        iframe.style.width = "250px"
        iframe.style.height = "460px"
        iframe.style.border = "1px solid rgb(13 185 215)"
        iframe.style.borderRadius = "5px"
        // maybe place it before cmdline when possible so it doesn't overlap
        iframe.style.zIndex = "2147483647"
        iframe.style.display = level === "all" ? "" : "none"

        iframe.src = browser.runtime.getURL("static/blank.html")
        iframe.onload = () => {
            if (iframe.contentDocument) {
                const csslink = document.createElement("link")
                csslink.rel = "stylesheet"
                csslink.href = browser.runtime.getURL("static/css/whichkey.css")
                iframe.contentDocument.head.appendChild(csslink)

                theme(iframe.contentDocument.documentElement)
                iframe.contentDocument.documentElement.classList.add("WhichKeyRoot")
                const table = document.createElement("table")
                table.className = "WhichKey"
                iframe.contentDocument.body.appendChild(table)
                completions = table
                whichkeyIframe = iframe
                resolve(iframe)
            } else {
                reject(iframe)
            }
        }
        const cmdlineIframe = document.querySelector(`[src="${browser.runtime.getURL("static/commandline.html")}"]`)
        if (cmdlineIframe) {
            document.documentElement.insertBefore(iframe, cmdlineIframe)
        } else {
            document.documentElement.appendChild(iframe)
        }
    })
}

// We DON'T want to get nmaps in our vmaps and stuff
function getUniqueMaps(mapName) {
    const defUrl = DEFAULTS.subconfigs[window.location.href]?.[mapName] || {}
    const usrUrl = USERCONFIG.subconfigs?.[window.location.href]?.[mapName] || {}
    const defult = DEFAULTS[mapName] || {}
    const user = USERCONFIG[mapName] || {}
    // priority should be... user URL -> defaultURL -> user -> default ?
    // I think?
    return mergeDeepCull(
        mergeDeepCull(mergeDeepCull(defult, user), defUrl),
        usrUrl,
    )
}

// TODO: Cache these (+ invalidate cache with config listener)
function unwrapInherits(mapName) {
    const mapped = new Set()
    const ordered = []
    let name = mapName
    while (name) {
        mapped.add(name)
        const maps = getUniqueMaps(name)
        const nextname = maps["🕷🕷INHERITS🕷🕷"]
        if (nextname) delete maps["🕷🕷INHERITS🕷🕷"]
        ordered.push([
            name,
            keyseq.mapstrMapToKeyMap(new Map(Object.entries(maps))),
        ])
        name = nextname
        if (mapped.has(name)) break
    }
    return ordered
}

// Now I think we can just filter with .startsWith
function keyseqsToStrings(keymap) {
    console.log(Array.from(keymap))
    return Array.from(keymap as Iterable<[any, any]>)
        .map(([keys, cmd]: [any, any]) => [
            keys.reduce((acc: string, key: any) => acc + keyseq.PrintableKey(key), ""),
            cmd])
}

// This takes up lots of space because I'm doing a bunch of document.createElement and inline styling
// neaten those up and it'd be a lot nicer

function listen() {
    addContentStateChangedListener(onStateChanged)
}

function replaceTableChildren(newChildren: DocumentFragment) {
    completions.replaceChildren(newChildren)
    const rect = completions.getClientRects()[0]
    whichkeyIframe.style.width = Math.min(rect.width, 520) + "px"
}

function createTableHeader(text = "", subheader = true) {
    const headerThead = document.createElement("thead")
    const headerRow = document.createElement("tr")
    const header = document.createElement("th")
    header.colSpan = 5 // can I just make this a big number
    header.className = subheader ? "Subheader" : "Header"
    header.textContent = text
    headerThead.appendChild(headerRow)
    headerRow.appendChild(header)
    return headerThead
}

// Just making some functions to speed up element creation
// I bet there's already a library here somewhere to do this
function createTableRow(...cells) {
    return createElement("tr", { children: cells.map(cell => createTableCell(cell)) })
}

function createTableCell(opts) {
    return createElement("td", opts)
}

function createElement(type, opts) {
    const el = document.createElement(type)
    if (opts.children) {
        el.replaceChildren(...opts.children)
        delete opts.children
    }
    Object.entries(opts).forEach(([k,v]) => {
        el[k] = v
    })
    return el
}

// TODO: debounce

// This is a bit large now isn't it
async function onStateChanged(property, oldMode, oldValue, newValue) {
    if (level === "none") return
    if (property !== "mode" && property !== "parsedKeys" && property !== "whichkey_extra") return

    const mode = contentState.mode
    const extra = contentState.whichkey_extra

    if (mode === "gobble" && (extra === "markadd" || extra === "markjump")) {
        const localMarks = await State.getAsync("localMarks")
        const globalMarks = await State.getAsync("globalMarks")
        const currentUrl = location.href.split("#")[0]
        const marksForPage = localMarks.get(currentUrl) || []

        const frag = document.createDocumentFragment()

        frag.appendChild(createTableHeader(extra, false))

        if (extra === "markjump") {
            const beforeMark = await State.getAsync("beforeJumpMark")
            if (beforeMark) {
                const row =createTableRow(
                    { className: "KeyUnpressed", textContent: "`" },
                    { className: "Command", textContent: beforeMark.scrollX + "," + beforeMark.scrollY },
                )

                if ((await ownTabId()) !== beforeMark.tabId) {
                    row.appendChild(createTableCell({ className: "Info", textContent: "beforeMark.url" }))
                }

                frag.appendChild(row)
            }
        }

        frag.appendChild(createTableHeader("Local Marks", true))

        marksForPage.forEach((scrolls, key) => {
            frag.appendChild(createTableRow(
                { className: "KeyUnpressed", textContent: key },
                { className: "Command", textContent: scrolls.scrollX + "," + scrolls.scrollY },
            ))
        })

        frag.appendChild(createTableHeader("Global Marks", true))

        globalMarks.forEach((mark, key) => {
            frag.appendChild(createTableRow(
                { className: "KeyUnpressed", textContent: key },
                { className: "Info", textContent: mark.url },
                { className: "Command", textContent: mark.scrollX + "," + mark.scrollY },
            ))
        })

        replaceTableChildren(frag)

        whichkeyIframe.style.display = ""
        return
    }

    let mapsKey
    if (["normal", "insert", "visual"].includes(mode)) {
        mapsKey = mode[0] + "maps"
    } else {
        mapsKey = mode + "maps"
    }

    const pressed = contentState.parsedKeys
        ? contentState.parsedKeys.keys
            .reduce((acc, key) => acc + keyseq.PrintableKey(key), "")
            .replace(/^[0-9]+/, "")
        : ""

    if (pressed === "" && level !== "all") {
        whichkeyIframe.style.display = "none"
        return
    }

    const keymaps = [...unwrapInherits(mapsKey), ...unwrapInherits("browsermaps")]
        .map(([name, keymap]) => [
            name,
            keyseqsToStrings(keymap)
                .filter(([keystr, _cmd]) => {
                    return keystr.startsWith(pressed)
                })
            ]
        )

    const frag = document.createDocumentFragment()

    frag.appendChild(createTableHeader(mode + " mode " + pressed, false))

    const exaliases = confget("exaliases")

    keymaps.forEach(([name, keymap]) => {
        if (keymap.length === 0) return

        frag.appendChild(createTableHeader(name === mapsKey ? name : "inerited: " + name, true))

        keymap.forEach(([keystr, cmd]) => {
            const unpressed = keystr.slice(pressed.length)
            const cmdFirstWord = (cmd as string).split(" ", 1)[0]
            const cmdRest = (cmd as string).slice(cmdFirstWord.length)

            let hrefToAnchor
            const namespaceSplit = cmdFirstWord.split(".")
            const namespace = namespaceSplit.length > 1 ? namespaceSplit[0] : ""
            const urlPrefix = browser.runtime.getURL("static/docs/modules/_src_")
            switch (namespace) {
                case "hint": hrefToAnchor = urlPrefix + "content_hinting_.html"; break
                case "text": hrefToAnchor = urlPrefix + "lib_editor_.html"; break
                case "ex": hrefToAnchor = urlPrefix + "commandline_frame_.html"; break
                default: hrefToAnchor = urlPrefix + "excmds_.html"
            }
            const target = hrefToAnchor === location.href.split("#")[0] ? "_parent" : ` "_blank"`
            const firstCmd = namespace.length ? cmdFirstWord.slice(namespace.length + 1) : cmdFirstWord

            const href = hrefToAnchor + "#" + (exaliases[cmdFirstWord]
                ? exaliases[cmdFirstWord].split(" ", 1)[0] : firstCmd.toLowerCase())

            frag.appendChild(createTableRow(
                {
                    children: [
                        createElement("span", { className: "KeyPressed", textContent: pressed, },),
                        createElement("span", { className: "KeyUnpressed", textContent: unpressed, },),
                    ],
                },
                {
                    className: "Command",
                    children: [
                        createElement("a", {
                            textContent: cmdFirstWord,
                            href,
                            target,
                        }),
                        createElement("span", { textContent: cmdRest })
                    ]
                },
            ))
        })
    })

    whichkeyIframe.style.display = ""
    replaceTableChildren(frag)
}

addChangeListener("whichkey", configListener)

function configListener(_oldLevel, newLevel) {
    setLevel(newLevel, false)
}

export function showWhichKey(howMuch) {
    setLevel(howMuch, true)
}

function setLevel(newLevel, overrideConfig = false) {
    console.log("oldlevel ", level)
    // level = newLevel
    if (newLevel === "toggle") {
        if (level === "none") {
            level = toggleLevel
        } else {
            level = "none"
        }
    } else {
        if (newLevel !== "none") toggleLevel = newLevel
        level = newLevel
    }
    console.log("new level", level, "toggle?", toggleLevel)
    if (whichkeyIframe) {
        if (level === "none") whichkeyIframe.style.display = "none"
        if (level === "all") whichkeyIframe.style.display = ""
    } else if (level !== "none") {
        init()
    }
    if (overrideConfig) {
        removeChangeListener("whichkey", configListener)
    }
}

