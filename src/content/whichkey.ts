import { addContentStateChangedListener } from "@src/content/state_content"
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
let lastExtra
// This is a bit large now isn't it
async function onStateChanged(property, oldMode, oldValue, newValue) {
    if (level === "none") return
    let mode = newValue
    let suffix = ""
    // hacky workaround to display stuff for gobble (markadd/markjump)
    // might be nice to have some way to display non-keymap stuff after all
    let extra = ""

    // let result = ""
    if (property !== "mode") {
        if (property === "suffix") {
            mode = oldMode
            suffix = newValue
            if (mode === "gobble") {
                extra = lastExtra
            }
        } else if (property === "group") {
            mode = oldMode
        } else if (property === "whichkey_extra") {
            mode = oldMode
            extra = newValue
            lastExtra = extra
        }
    }

    if ((mode === "gobble" && extra === "markadd") || extra === "markjump") {
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

    const suffixStripped = suffix.replace(/^[0-9]+/, "")
    if (suffixStripped !== "" || level === "all") {
        const pressed = keyseq.canonicaliseMapstr(
            (suffixStripped as any).replaceAll(
                /(?<=<[ACMS]+-) (?=>)/g,
                "Space",
            ),
        )
        const pressedSeq = keyseq.mapstrToKeyseq(pressed)

        let mapsKey
        if (["normal", "insert", "visual"].includes(mode)) {
            mapsKey = mode[0] + "maps"
        } else {
            mapsKey = mode + "maps"
        }

        const frag = document.createDocumentFragment()

        frag.appendChild(createTableHeader(mode + " mode " + suffix, false))

        const parseKeyComps = (comps: Iterable<[any, any]>) => {
            const keystrings = []
            Array.from(comps).forEach(([ks, cmd]) => {
                const keystring = ks.reduce(
                    (acc, cur) => acc + PrintableKey(cur),
                    "",
                )
                const unpressed = keystring.slice(pressed.length)
                keystrings.push([unpressed, cmd])
            })
            return keystrings
        }

        const keymaps = unwrapInherits(mapsKey)
        keymaps.push(...unwrapInherits("browsermaps"))
        const exaliases = confget("exaliases")

        keymaps.forEach(([name, keymap]) => {
            const comps = keyseq.completions(pressedSeq, keymap)
            if (comps.size === 0) return

            frag.appendChild(createTableHeader(name === mapsKey ? name : "inerited: " + name, true))

            const keystrings = parseKeyComps(comps)

            keystrings.forEach(([unpressed, cmd]) => {
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

    } else {
        whichkeyIframe.style.display = "none"
    }
}

// copied from controller_content - this is how we recieve keys
// so i guess we can start by converting keymaps into these too
// added meta key and Space-ing
function PrintableKey(k) {
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
    if (k.key === " ") result = "Space"

    let mod = ""
    if (k.altKey) {
        mod += "A"
    }
    if (k.ctrlKey) {
        mod += "C"
    }
    if (k.metaKey) {
        mod += "M"
    }
    if (k.shiftKey) {
        mod += "S"
    }
    if (mod.length) {
        result = mod + "-" + result
    }
    if (result.length > 1) {
        result = "<" + result + ">"
    }
    return result
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

