/**
 * Add a whichkey style popup to the page.
 * Uses a state listener (like the mode indicator)
 * Filters keymaps using the suffix. Which means we filter the keypresses twice.
 * (once for the actual keypress and again here).
 * But I do want to separate inherited keymaps out.
 * And I don't know how to do that if I don't re-filter here, so that's just the way it is.
 */

import {
    addContentStateChangedListener,
    contentState,
} from "@src/content/state_content"
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
        toggleLevel = show
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
                iframe.contentDocument.documentElement.classList.add(
                    "WhichKeyRoot",
                )
                const table = document.createElement("table")
                table.className = "WhichKey"
                iframe.contentDocument.body.appendChild(table)
                completions = table
                whichkeyIframe = iframe

                // It would be nice to be able to scroll / filter the iframe with key presses
                // but for now, if you click a link or something, return focus to the main window
                iframe.contentWindow.addEventListener("focus", () =>
                    window.focus(),
                )
                resolve(iframe)
            } else {
                reject(iframe)
            }
        }
        const cmdlineIframe = document.querySelector(
            `[src="${browser.runtime.getURL("static/commandline.html")}"]`,
        )
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
    const usrUrl =
        USERCONFIG.subconfigs?.[window.location.href]?.[mapName] || {}
    const defult = DEFAULTS[mapName] || {}
    const user = USERCONFIG[mapName] || {}
    // priority should be... user URL -> defaultURL -> user -> default ?
    // I think?
    return mergeDeepCull(
        mergeDeepCull(mergeDeepCull(defult, user), defUrl),
        usrUrl,
    )
}

// Now we get keymaps and separate their 🕷🕷INHERITS🕷🕷 maps out
// Then map their key sequences to a single bind-style key string
// That's the important one, so it's what we'll cache
// Changes to any map we've found will invalidate the cache
// TODO: check if :bindurl triggers this callback, otherwise listen for "subconfigs" too
let keystringsToCmdsCache = new Map()
const keymapConfigListeners = new Set()
function addKeymapConfigListener(mapName) {
    if (keymapConfigListeners.has(mapName)) return
    keymapConfigListeners.add(mapName)
    addChangeListener(mapName, () => {
        console.log("keystrings map cache cleared")
        keystringsToCmdsCache = new Map()
    })
}

function getFilteredBinds(mapName, pressed = "") {
    return pressed === ""
        ? getBindsForMapName(mapName)
        : getBindsForMapName(mapName).map(([name, keymap]) => [
              name,
              keymap.filter(([bind, _cmd]) =>
                  bind.join("").startsWith(pressed),
              ),
          ])
}

// Pass unwrapInherits result, that's an array of arrays: [mapName, keyMap]
function getBindsForMapName(mapName) {
    console.log("getBindsForMapName", mapName)
    if (keystringsToCmdsCache.has(mapName)) {
        console.log(mapName, "was cached!")
        return keystringsToCmdsCache.get(mapName)
    }
    console.log(mapName, "was NOT cached")
    const keystrMap = unwrapInherits(mapName).map(([name, keymap]) => [
        name,
        keyseqsToStrings(keymap),
    ])
    keystringsToCmdsCache.set(mapName, keystrMap)
    return keystrMap
}

// Separate 🕷🕷INHERITS🕷🕷 from keymaps and return all maps in order of inheritance
// Usually there's 0 or 1 🕷🕷INHERITS🕷🕷 keys, but a user could add some themselves
// also adds browsermaps binds to the end of the list as they're always available
function unwrapInherits(mapName, includeBrowserMaps = true) {
    const mapped = new Set()
    const ordered = []
    let wantBrowserMaps = includeBrowserMaps
    let name = mapName
    while (name) {
        addKeymapConfigListener(name)
        mapped.add(name)
        const maps = getUniqueMaps(name)
        const nextname = maps["🕷🕷INHERITS🕷🕷"]
        if (nextname) delete maps["🕷🕷INHERITS🕷🕷"]
        const keymap = keyseq.mapstrMapToKeyMap(new Map(Object.entries(maps)))
        if (keymap.size) {
            ordered.push([name, keymap])
        }
        name = nextname
        if (mapped.has(name) || !name) {
            if (includeBrowserMaps) {
                name = "browsermaps"
                includeBrowserMaps = false
            } else break
        }
    }
    return ordered
}

// Now I think we can just filter with .startsWith
function keyseqsToStrings(keymap) {
    return Array.from(keymap as Iterable<[any, any]>).map(
        ([keys, cmd]: [any, any]) => [
            keys.map(key => keyseq.PrintableKey(key)),
            cmd,
        ],
    )
}

let excmdHelpDocFrag = null
async function queryExcmdHelp(
    excmd: string,
    transform: (HTMLElement) => any = el => el,
) {
    if (!excmdHelpDocFrag) {
        const html = await fetch(
            browser.runtime.getURL("static/docs/modules/_src_excmds_.html"),
        ).then(f => f.text())
        const template = document.createElement("template")
        template.innerHTML = html
        excmdHelpDocFrag = template.content
        console.log("fetched help", excmdHelpDocFrag)
    }

    const section = excmdHelpDocFrag.querySelector(
        `[name='${excmd}']`,
    ).parentElement
    console.log(excmd, "help", section)
    const transformed = transform(section)
    console.log("transformed!", transformed)
    return transform(section)
}

let hintFlagsHelp: Map<string, string> = null
function hintFlagsToHelpDescription(flag) {
    if (!hintFlagsHelp) {
        hintFlagsHelp = new Map()
        queryExcmdHelp(
            "hint",
            hintSection =>
                new Map(
                    Array.from(
                        hintSection.querySelectorAll(".tsd-parameters li"),
                    )
                        .map(li => (li as HTMLElement).textContent.trim())
                        .filter(text => text.startsWith("-"))
                        .map(text => {
                            let flagKey = text.split(" ", 1)[0].slice(1)
                            if (flagKey[1] === "*") {
                                flagKey = flagKey.slice(0, 1)
                            }
                            return [
                                flagKey,
                                text.slice(flagKey.length + 1).trim(),
                            ]
                        }),
                ),
        ).then(map => (hintFlagsHelp = map))
    }
    console.log(
        "have hint flag?",
        "'" + flag + "'",
        hintFlagsHelp,
        hintFlagsHelp.get(flag),
    )
    return hintFlagsHelp.get(flag)
}

hintFlagsToHelpDescription("hint")

// This takes up lots of space because I'm doing a bunch of document.createElement and inline styling
// neaten those up and it'd be a lot nicer
let stateChangeDebounceTimer = -1
let debounceMs = 100
function listen() {
    addContentStateChangedListener((...args) => {
        clearTimeout(stateChangeDebounceTimer)
        stateChangeDebounceTimer = setTimeout(
            () => onStateChanged(...args),
            debounceMs,
        )
    })
}

function replaceTableChildren(newChildren: DocumentFragment) {
    completions.replaceChildren(newChildren)
    const rect = completions.getClientRects()[0]
    whichkeyIframe.style.width = Math.max(Math.min(rect.width, 350), 250) + "px"
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
    return createElement("tr", {
        children: cells.map(cell => createTableCell(cell)),
    })
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
    Object.entries(opts).forEach(([k, v]) => {
        el[k] = v
    })
    return el
}

// This is a bit large now isn't it
async function onStateChanged(property, oldMode, oldValue, newValue) {
    console.log(contentState, property, oldValue, newValue, "STATE CHANGE ")
    if (level === "none") return
    // if (property !== "mode" && property !== "suffix" && property !== "whichkey_extra") return

    const mode = contentState.mode
    const extra = contentState.whichkey_extra

    // Display existing marks and their urls & scroll locations
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
                const row = createTableRow(
                    { className: "Keyseq KeyUnpressed", textContent: "`" },
                    {
                        className: "Command",
                        textContent:
                            beforeMark.scrollX + "," + beforeMark.scrollY,
                    },
                )

                if ((await ownTabId()) !== beforeMark.tabId) {
                    row.appendChild(
                        createTableCell({
                            className: "Info",
                            textContent: "beforeMark.url",
                        }),
                    )
                }

                frag.appendChild(row)
            }
        }

        frag.appendChild(createTableHeader("Local Marks", true))

        marksForPage.forEach((scrolls, key) => {
            frag.appendChild(
                createTableRow(
                    { className: "Keyseq KeyUnpressed", textContent: key },
                    {
                        className: "Command",
                        textContent: scrolls.scrollX + "," + scrolls.scrollY,
                    },
                ),
            )
        })

        frag.appendChild(createTableHeader("Global Marks", true))

        globalMarks.forEach((mark, key) => {
            frag.appendChild(
                createTableRow(
                    { className: "Keyseq KeyUnpressed", textContent: key },
                    {
                        className: "Command",
                        textContent: mark.scrollX + "," + mark.scrollY,
                    },
                    { className: "Info", textContent: mark.url },
                ),
            )
        })

        replaceTableChildren(frag)

        whichkeyIframe.style.display = ""
        return
    }

    // Display existing quickmarks and their keys
    if (mode === "gobble" && extra === "quickmark") {
        const frag = document.createDocumentFragment()
        ;(frag as any).replaceChildren(
            createTableHeader("Quickmark", false),
            ...Object.entries(confget("nmaps"))
                .filter(
                    ([k, cmd]) =>
                        k.startsWith("go") &&
                        (cmd as string).startsWith("open "),
                )
                .map(([k, cmd]) =>
                    createTableRow(
                        { className: "KeyUnpressed", textContent: k.slice(2) },
                        {
                            className: "Info",
                            textContent: (cmd as string).slice(5),
                        },
                    ),
                ),
        )
        replaceTableChildren(frag)
        return
    }

    // We have no other special gobble displays
    // We could have such displays be configurable mind you
    if (mode === "gobble") return

    let mapsKey
    if (["normal", "insert", "visual"].includes(mode)) {
        mapsKey = mode[0] + "maps"
    } else {
        mapsKey = mode + "maps"
    }

    const pressed = contentState.suffix || ""

    if (pressed === "" && level !== "all") {
        whichkeyIframe.style.display = "none"
        return
    }

    // const keymaps = [...unwrapInherits(mapsKey), ...unwrapInherits("browsermaps")]
    //     .map(([name, keymap]) => [
    //         name,
    //         keyseqsToStrings(keymap)
    //             .filter(([keystrs, _cmd]) => {
    //                 return keystrs.join("").startsWith(pressed)
    //             })
    //         ]
    //     )

    const keymaps = getFilteredBinds(mapsKey, pressed)

    const frag = document.createDocumentFragment()

    frag.appendChild(createTableHeader(mode + " mode " + pressed, false))

    const exaliases = confget("exaliases")

    try {
        let yikes = keymaps[0][1][0][0]
    } catch (e) {
        console.error(
            "we tried to index a keymap when we shouldn't",
            keymaps,
            contentState,
            property,
            oldValue,
            newValue,
        )
    }

    const firstBind = keymaps[0][1][0][0]
    let toSlice = pressed.length
    let unpressedStart = 0
    while (toSlice > 0) {
        toSlice -= firstBind[unpressedStart].length
        ++unpressedStart
    }
    const pressedSpans: any = document.createDocumentFragment()

    // It's nicer if we don't let multi-char binds break
    // Keys/modifier combos like <AS-Backspace> for example
    pressedSpans.replaceChildren(
        ...firstBind
            .slice(0, unpressedStart)
            .flatMap(str => [
                createElement("span", {
                    className: "KeyPressed",
                    textContent: str,
                }),
                document.createElement("wbr"),
            ]),
    )

    keymaps.forEach(([name, keymap]) => {
        if (keymap.length === 0) return

        frag.appendChild(
            createTableHeader(
                name === mapsKey ? name : "inerited: " + name,
                true,
            ),
        )

        // Separate pressed keys & unpressed keys
        // Get the first word for bound commands and add a link to its entry in the help/docs
        keymap.forEach(async ([keystrs, cmd]) => {
            const unpressedSpans = keystrs
                .slice(unpressedStart)
                .flatMap(str => [
                    createElement("span", {
                        className: "KeyUnpressed",
                        textContent: str,
                    }),
                    document.createElement("wbr"),
                ])

            const cmdFirstWord = (cmd as string).split(" ", 1)[0]
            const cmdRest = (cmd as string).slice(cmdFirstWord.length)

            let hrefToAnchor
            const namespaceSplit = cmdFirstWord.split(".")
            const namespace = namespaceSplit.length > 1 ? namespaceSplit[0] : ""
            const urlPrefix = browser.runtime.getURL(
                "static/docs/modules/_src_",
            )
            switch (namespace) {
                case "hint":
                    hrefToAnchor = urlPrefix + "content_hinting_.html"
                    break
                case "text":
                    hrefToAnchor = urlPrefix + "lib_editor_.html"
                    break
                case "ex":
                    hrefToAnchor = urlPrefix + "commandline_frame_.html"
                    break
                default:
                    hrefToAnchor = urlPrefix + "excmds_.html"
            }

            const target =
                hrefToAnchor === location.href.split("#")[0]
                    ? "_parent"
                    : ` "_blank"`
            const firstCmd = namespace.length
                ? cmdFirstWord.slice(namespace.length + 1)
                : cmdFirstWord

            const href =
                hrefToAnchor +
                "#" +
                (exaliases[cmdFirstWord]
                    ? exaliases[cmdFirstWord].split(" ", 1)[0]
                    : firstCmd.toLowerCase())

            const extraEls = []
            if (cmdFirstWord === "hint" && cmdRest.startsWith(" -")) {
                console.log("hint with arg:", cmdRest.split(" ", 2)[1])
                const docstr = hintFlagsToHelpDescription(
                    cmdRest.split("-", 2)[1],
                )
                if (docstr) {
                    console.log("have docstring:", docstr)
                    extraEls.push(
                        createElement("span", {
                            className: "Info",
                            textContent: docstr,
                        }),
                    )
                    console.log(extraEls)
                }
            }

            frag.appendChild(
                createTableRow(
                    {
                        className: "Keyseq",
                        children: [
                            pressedSpans.cloneNode(true),
                            ...unpressedSpans,
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
                            createElement("span", { textContent: cmdRest }),
                            ...extraEls,
                        ],
                    },
                ),
            )
        })
    })

    whichkeyIframe.style.display = ""
    replaceTableChildren(frag)
}

addChangeListener("whichkey", whichkeyConfigListener)

function whichkeyConfigListener(_oldLevel, newLevel) {
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
    if (overrideConfig && newLevel !== "toggle") {
        removeChangeListener("whichkey", whichkeyConfigListener)
    }
}
