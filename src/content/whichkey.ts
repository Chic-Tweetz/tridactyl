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
import * as config from "@src/lib/config"
import { theme } from "./styling"

let whichkeyIframe: HTMLIFrameElement
let level = "none" // none | multi | all
let toggleLevel = "multi" // level to be set when :whichkey toggles it on
let completions
let keystringsToCmdsCache = new Map()
const keymapConfigListeners = new Set()
let stateChangeDebounceTimer = -1
let debounceMs = 100

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

function init() {
    return createIframe()
        .then(() => listen())
        .catch(() => {
            console.error("couldn't create whichkey iframe")
        })
}

// Currently hard-coding position/size which we'd certainly want to be customisable
async function createIframe() {
    return new Promise((resolve, reject) => {
        const iframe = document.createElement("iframe")
        iframe.style.position = "fixed"
        iframe.style.opacity = "0.9"
        iframe.style.left = "10%"
        iframe.style.bottom = "40px"
        iframe.style.width = "80%"
        iframe.style.height = "460px"
        iframe.style.border = "1px solid rgb(13 185 215)"
        iframe.style.borderRadius = "5px"
        iframe.style.zIndex = "2147483647"
        ;(iframe.style as any).colorScheme = "light dark" // Allow transparency
        iframe.style.display = level === "all" ? "" : "none"

        // Made blank.html with the idea that it could be used for anything
        iframe.src = browser.runtime.getURL("static/blank.html")
        iframe.onload = () => {
            if (iframe.contentDocument) {
                // We can inject our .css files without having to
                // include <link>s (or <script>s) in the blank.html src
                // so that's a nice way of styling a general purpose blank.html iframe
                const csslink = document.createElement("link")
                csslink.rel = "stylesheet"
                csslink.href = browser.runtime.getURL("static/css/whichkey.css")
                iframe.contentDocument.head.appendChild(csslink)

                // Along with theme() for applying colour schemes
                theme(iframe.contentDocument.documentElement)
                iframe.contentDocument.documentElement.classList.add(
                    "WhichKeyRoot",
                )

                // Displaying binds in a table seems good to me
                const table = document.createElement("table")
                table.className = "WhichKey"
                iframe.contentDocument.body.appendChild(table)
                completions = table
                whichkeyIframe = iframe

                // It would be nice to be able to scroll / filter the iframe with key presses
                // but for now, if you click a link (excmd binds will link to the help page) or something,
                // return focus to the main window
                iframe.contentWindow.addEventListener("focus", () =>
                    window.focus(),
                )
                resolve(iframe)
            } else {
                reject(iframe)
            }
        }
        // Inserting before the cmdline so the cmdline should appear on top
        const cmdlineIframe: HTMLIFrameElement = document.querySelector(
            `[src="${browser.runtime.getURL("static/commandline.html")}"]`,
        )
        if (cmdlineIframe) {
            document.documentElement.insertBefore(iframe, cmdlineIframe)
        } else {
            document.documentElement.appendChild(iframe)
        }
    })
}

// Update whichkey display after keypresses
function listen() {
    addContentStateChangedListener((...args) => {
        clearTimeout(stateChangeDebounceTimer)
        stateChangeDebounceTimer = setTimeout(
            () => onStateChanged(...args),
            debounceMs,
        )
    })
    addBindUrlListener()
}

// Invalidate cache when a key map changes
function addKeymapConfigListener(mapName) {
    if (keymapConfigListeners.has(mapName)) return
    keymapConfigListeners.add(mapName)
    config.addChangeListener(mapName, () => {
        keystringsToCmdsCache = new Map()
        if (whichkeyIframe.style.display !== "none") onStateChanged()
    })
}

// Invalidate cache after :bindurl if it affects the current url
function addBindUrlListener() {
    config.addChangeListener("subconfigs", (_oldValue, newValue) => {
        const affectsThisTab = !Object.keys(newValue).every(
            url => !url.match(window.location.href),
        )
        if (affectsThisTab) {
            keystringsToCmdsCache = new Map()
            if (whichkeyIframe.style.display !== "none") onStateChanged()
        }
    })
}

// Pass a map name ("nmaps", "imaps", "inputmaps"...) and a PrintableKey-style string
// to filter only the binds beginning with that string
function getFilteredBinds(mapName, pressed = "") {
    return pressed === ""
        ? getBindsForMapName(mapName)
        : getBindsForMapName(mapName).map(({ name, urlBinds, binds }) => ({
              name,
              binds: binds.filter(([bind, _cmd]) =>
                  bind.join("").startsWith(pressed),
              ),
              urlBinds: urlBinds.filter(([bind, _cmd]) =>
                  bind.join("").startsWith(pressed),
              ),
          }))
}

// Returns an array of arrays of map names with PrintableKey-style keymaps,
// where each item beyond the first is inherited
// eg [["vmaps", {...}], ["nmaps", {...}], ["browsermaps", {...}]]
// which is a bit convoluted and tricky to unravel so should probably neaten it up
function getBindsForMapName(mapName) {
    if (keystringsToCmdsCache.has(mapName)) {
        return keystringsToCmdsCache.get(mapName)
    }
    const keystrMap = unwrapInherits(mapName).map(
        ({ name, urlBinds, binds }) => ({
            name,
            urlBinds: keyseqsToStrings(urlBinds),
            binds: keyseqsToStrings(binds),
        }),
    )
    keystringsToCmdsCache.set(mapName, keystrMap)
    return keystrMap
}

// Get keymaps, but separate out inherited binds (eg vmaps inherits nmaps)
// and separate url binds too, to return an array of objects the form
// [{ name, urlBinds, binds }...]
// where "name" is the map name in order of inherits found, eg for vmaps:
// [{ name: "vmaps", urlBinds: {...}, binds: {...}, { name: "nmaps", binds: {...}, urlBinds: {...} },]
// by default, browsermaps is added to the end of any array as they're available in any mode
function unwrapInherits(mapName, includeBrowserMaps = true) {
    let maps = []
    while (mapName) {
        maps.push({
            name: mapName,
            urlBinds: config.getURL(window.location.href, [mapName]) || {},
            binds: config.get(mapName),
        })
        const map = maps[maps.length - 1]
        Object.keys(map.urlBinds).forEach(bind => delete map.binds[bind])

        addKeymapConfigListener(mapName)
        mapName = map.binds["🕷🕷INHERITS🕷🕷"]
        delete map.binds["🕷🕷INHERITS🕷🕷"]

        if (!mapName && includeBrowserMaps) {
            includeBrowserMaps = false
            mapName = "browsermaps"
        }
    }

    // Remove duplicates from inherited binds and convert config objects to KeyMaps
    for (let i = 0; i < maps.length - 1; ++i) {
        maps[i].binds = keyseq.mapstrMapToKeyMap(
            new Map(
                Object.entries(maps[i].binds).filter(
                    ([bind, cmd]) => maps[i + 1].binds[bind] !== cmd,
                ) as any,
            ),
        )
        maps[i].urlBinds = keyseq.mapstrMapToKeyMap(
            new Map(
                Object.entries(maps[i].urlBinds).filter(
                    ([bind, cmd]) => maps[i + 1].urlBinds[bind] !== cmd,
                ) as any,
            ),
        )
    }
    maps[maps.length - 1].urlBinds = keyseq.mapstrMapToKeyMap(
        new Map(Object.entries(maps[maps.length - 1].urlBinds)),
    )
    maps[maps.length - 1].binds = keyseq.mapstrMapToKeyMap(
        new Map(Object.entries(maps[maps.length - 1].binds)),
    )

    return maps
}

// Convert MinimalKey arrays to PrintableKey arrays
// this lets us filter them by our content state suffix
function keyseqsToStrings(keymap) {
    return Array.from(keymap as Iterable<[any, any]>).map(
        ([keys, cmd]: [any, any]) => [
            keys.map(key => keyseq.PrintableKey(key)),
            cmd,
        ],
    )
}

// Just exploring ideas
// This lets us get strings from the help pages
// currently by fetch()ing that page - can we access that data otherwise?
// (like we can get with "@src/.metadata.generated")
let excmdHelpDocFrag = null // essentially storing all the elements of the excmds help page in here

// transform is passed the top element of the excmd's help entry
// which can be used to find text... like the text in the <li>s explaining what hint args do
// I think what would be nicer is some config object that has some nice whichkey-friendly strings in it
// You could use that to document binds or aliases
// eg :composite and :js binds/aliases aren't necessarily self documenting
// yes I do think that would be better... this was fun though
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
        // can now query excmdHelpDocFrag like it's the document in the help pages
        excmdHelpDocFrag = template.content
    }

    // Ideally this element has all the bits we're after for the given excmd
    const section = excmdHelpDocFrag.querySelector(
        `[name='${excmd}']`,
    ).parentElement

    return transform(section)
}

// Parse the list explaining each :hint arg and map the flags to their explanation
let hintFlagsHelp: Map<string, string> = null
// Pass a hint flag (eg "-b") and get that flag's explanation (ideally)
// Not complete (won't work with :hint -qb for instance) and probably won't complete
// Because I prefer the idea of a documentation config object I reckon
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
                            // -J* and -q*
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

    return hintFlagsHelp.get(flag)
}

// commenting this out in favour of "docs" config object
// hintFlagsToHelpDescription("hint")

// Some HTML element helpers follow
// I wouldn't be surprised if a nice library for this sort of thing is already imported
function replaceTableChildren(newChildren: DocumentFragment) {
    completions.replaceChildren(newChildren)
    const rect = completions.getClientRects()[0]
    // whichkeyIframe.style.width = Math.max(Math.min(rect.width, 350), 250) + "px"
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

// Wouldn't it be nice if there was a globally used command parser in src/lib or something?
// could use it in every excmd that has flags
// could add doc strings to instances of it
// could add optional short docstrs for use with things like this
/*
// just thinking it through a little
// IDK, it'd just be kinda neat
// 
hintFlagRules = {
    strictness: "error", // throw error if unrecognised arg is passed
    b: {
        type: "bool", // default type - you could omit this
        docstr: "open the selected element's href in a new background tab",
        docshort: "background tab",
    }, ...
    c: {
        type: "next 1", // some way to say that -c should use the next arg
    },
    pipe: {
        type: "next 2", // and pipe would use the next 2
    },
    F: {
        type: "next rest", // all proceding args are for -F
    },
    ...
}

bindFlagRules = {
    strictness: "none", // treat args beginning with - as the start of the bind
    // "-" + "-mode" = "--mode" - you'd want to specify double hyphen prefixes like this (or some other way yes)
    "-mode": {
        type: "setter", // --mode=visual ...
    }
}

parse(flagRules, excmd) {
    ...
}

parse(bindFlagRules, "bind --mode=visual b js ...")
=== {
        command: "bind",
        flags: {
            "-mode": "visual",
        },
        rest: ["b", "js ..."],
    }

*/
function parseFlags(cmd, validFlags) {
    const parts = cmd.trim().split(/\s+/)
    const cmdName = parts[0]
    const rest = parts.slice(1)

    // Sort flags longest-first for greedy matching
    const sortedFlags = [...validFlags].sort((a, b) => b.length - a.length)

    const flags = []
    let i = 0

    while (i < rest.length && rest[i].startsWith("-")) {
        let token = rest[i]

        // Remove leading hyphens
        token = token.replace(/^-+/, "")

        // Greedy prefix matching
        while (token.length > 0) {
            let matched = false

            for (const f of sortedFlags) {
                if (token.startsWith(f)) {
                    flags.push(f)
                    token = token.slice(f.length)
                    matched = true
                    break
                }
            }

            if (!matched) {
                // No valid flag prefix found → stop parsing this token
                break
            }
        }

        i++
    }

    const args = rest.slice(i)
    return { cmdName, flags, args }
}

// This could use some tidying up now
// Reconsider how we get all the strings we want (keymaps, "docs" config, ... )
// As well as the work we do in here - the excmd help url, strings per span...
// I suspect a lot of that can be cached along with the keymaps
// Then this function should just convert strings we've already built to elements
function keystrMapsToElems(
    keystrMap,
    pressedLength = 0,
    pressedSpans = document.createDocumentFragment(),
    mapName: "nmaps",
): HTMLElement[] {
    const exaliases = config.get("exaliases")

    // TODO: if you keep this "docs" config stuff, cache it with the rest of the keymap stuff
    const docs = config.get("docs")

    return keystrMap.map(([keystrs, cmd]) => {
        const unpressedSpans = keystrs.slice(pressedLength).flatMap(str => [
            createElement("span", {
                className: "KeyUnpressed",
                textContent: str,
            }),
            document.createElement("wbr"),
        ])

        const cmdFirstWord = (cmd as string).split(" ", 1)[0]
        const cmdRest = (cmd as string).slice(cmdFirstWord.length)

        const validFlags = Object.keys(docs.excmds[cmdFirstWord]?.flags || {})
        const parsedFlags = parseFlags(cmd, validFlags)

        let hrefToAnchor
        const namespaceSplit = cmdFirstWord.split(".")
        const namespace = namespaceSplit.length > 1 ? namespaceSplit[0] : ""
        const urlPrefix = browser.runtime.getURL("static/docs/modules/_src_")
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
                ? `"_parent"`
                : `"_blank"`
        const firstCmd = namespace.length
            ? cmdFirstWord.slice(namespace.length + 1)
            : cmdFirstWord

        const href =
            hrefToAnchor +
            "#" +
            (exaliases[cmdFirstWord]
                ? exaliases[cmdFirstWord].split(" ", 1)[0]
                : firstCmd.toLowerCase())

        // Also get help text for hint args
        // will probably replace this with something less specific
        // like customisable doc strings in a config object
        const extraEls = []
        // just gonna comment this out - better to have one source of custom strings, might as well be the "docs" config object?
        // if (cmdFirstWord === "hint" && cmdRest.startsWith(" -")) {
        //     const docstr = hintFlagsToHelpDescription(
        //         cmdRest.split("-", 2)[1],
        //     )
        //     if (docstr) {
        //         extraEls.push(
        //             createElement("span", {
        //                 className: "Info",
        //                 textContent: " " + docstr + " ",
        //             }),
        //         )
        //     }
        // }

        // just real quick here for checkin
        // yeah i quite like it actually
        // maybe worth doing well
        if (docs.excmds?.[cmdFirstWord]) {
            if (
                cmdFirstWord === cmd.trim() &&
                docs.excmds[cmdFirstWord]?.noargs
            ) {
                extraEls.push(
                    createElement("span", {
                        className: "Info",
                        textContent:
                            " " + docs.excmds[cmdFirstWord].noargs + " ",
                    }),
                )
            } else if (typeof docs.excmds[cmdFirstWord] === "string") {
                extraEls.push(
                    createElement("span", {
                        className: "Info",
                        textContent: " " + docs.excmds[cmdFirstWord] + " ",
                    }),
                )
            } else {
                // args eg :hint -qb
                for (const flag of parsedFlags.flags) {
                    extraEls.push(
                        createElement("span", {
                            className: "Info",
                            textContent:
                                " " +
                                docs.excmds[cmdFirstWord].flags[flag] +
                                " ",
                        }),
                    )
                }
            }
        }
        // would have to ensure binds and docs' binds are formatted the same
        // mainly(?) the order of modifiers in bracket expressions <AS-UpArrow> and the like
        if (docs[mapName]?.[keystrs.join("")]) {
            extraEls.push(
                createElement("span", {
                    className: "Info",
                    textContent: " " + docs[mapName][keystrs.join("")] + " ",
                }),
            )
        }

        const cols = [
            {
                className: "Keyseq",
                children: [pressedSpans.cloneNode(true), ...unpressedSpans],
            },
        ]

        if (extraEls.length) {
            cols.push({
                className: "Docs",
                children: extraEls,
            })
        }

        cols.push({
            className: "Command",
            children: [
                createElement("a", {
                    textContent: cmdFirstWord,
                    href,
                    target,
                }),
                createElement("span", { textContent: cmdRest }),
            ],
        })

        return createTableRow(...cols)
    })
}

// Update the popup when keys are pressed or mode changes
// Currently I've hardcoded several specific cases
// The main one being displaying keybinds for the current mode
// The other two being markjump/markadd and quickmark, where existing marks are shown
async function onStateChanged(property?, oldMode?, oldValue?, newValue?) {
    if (level === "none") return

    // Just grabbing straight from the contentState object rather than using the callback's args
    // Is that alright? I'm certainly finding it easier
    let mode: string = contentState.mode // just gonna see what this does for me...

    // currently pseudo_mode is only ever set by :gobble,
    // to the name of the excmd :gobble will call when it's done
    // (this is also a nice addition for the modeindicator which can show things like "gobble|markadd")
    const extra = contentState.pseudo_mode

    // Display existing marks and their urls & scroll locations
    // Scroll locations are probably useless info... but you never know
    // just gives us something to display in our fancy new whichkey box
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
                            textContent: beforeMark.url,
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
            ...Object.entries(config.get("nmaps"))
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
    if (extra && property !== "mode") mode = extra
    // if (extra !== "") mode = extra

    // The name of the keymap we'll use
    let mapsKey
    if (["normal", "insert", "visual"].includes(mode)) {
        mapsKey = mode[0] + "maps"
    } else {
        mapsKey = mode + "maps"
    }

    // PrintableKey-style suffix, the key(s) that have been pressed so far
    const pressed = contentState.suffix || ""

    if (pressed === "" && level !== "all") {
        whichkeyIframe.style.display = "none"
        return
    }

    const keymaps = getFilteredBinds(mapsKey, pressed)

    const frag = document.createDocumentFragment()

    // const exaliases = config.get("exaliases")

    const firstBind = keymaps.find(
        km => km.binds.length > 0 || km.urlBinds.length > 0,
    )

    if (!firstBind) return

    const firstBindKeystrs =
        firstBind.binds.length > 0
            ? firstBind.binds[0][0]
            : firstBind.urlBinds[0][0]
    let toSlice = pressed.length
    let unpressedStart = 0
    while (toSlice > 0) {
        toSlice -= firstBindKeystrs[unpressedStart].length
        ++unpressedStart
    }
    const pressedSpans: any = document.createDocumentFragment()

    // It's nicer if we don't split multi-char over multiple lines
    // as in for long keys/modifier combos like <AS-Backspace>
    pressedSpans.replaceChildren(
        ...firstBindKeystrs.slice(0, unpressedStart).flatMap(str => [
            createElement("span", {
                className: "KeyPressed",
                textContent: str,
            }),
            document.createElement("wbr"),
        ]),
    )

    // I don't like the "pretty" symbols after all
    // frag.appendChild(
    //     createTableHeader(mode + " mode " +
    //         Array.from(pressedSpans.children)
    //             .map(span => prettyPrint((span as HTMLElement).textContent))
    //             .join("")
    //         , false
    //     )
    // )

    const header =
        config.get("docs").headings[mode]?.[pressed] ||
        mode + " mode " + pressed
    frag.appendChild(createTableHeader(header, false))

    keymaps.forEach(({ name, urlBinds, binds }) => {
        if (binds.length === 0 && urlBinds.length === 0) return

        if (urlBinds.length > 0) {
            frag.appendChild(
                createTableHeader(
                    "url " + (name === mapsKey ? name : "inerited: " + name),
                    true,
                ),
            )
            frag.append(
                ...keystrMapsToElems(
                    urlBinds,
                    unpressedStart,
                    pressedSpans,
                    name,
                ),
            )
        }
        if (binds.length > 0) {
            frag.appendChild(
                createTableHeader(
                    name === mapsKey ? name : "inerited: " + name,
                    true,
                ),
            )
            frag.append(
                ...keystrMapsToElems(binds, unpressedStart, pressedSpans, name),
            )
        }
    })

    whichkeyIframe.style.display = ""
    replaceTableChildren(frag)
}

config.addChangeListener("whichkey", whichkeyConfigListener)

function whichkeyConfigListener(_oldLevel, newLevel) {
    setLevel(newLevel, false)
}

export function showWhichKey(howMuch) {
    setLevel(howMuch, true)
}

function setLevel(newLevel, overrideConfig = false) {
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

// felt cute might use this in the header row like "normal mode ␣" idk
function prettyPrint(angledString) {
    if (!angledString.startsWith("<") || !angledString.endsWith(">"))
        return angledString
    if (angledString.indexOf("-") === -1)
        angledString = angledString.slice(1, angledString.length - 1)
    const swaps = [
        ["Space", "␣"],
        ["Enter", "⏎"],
        ["ArrowUp", "↑"],
        ["ArrowDown", "↓"],
        ["ArrowLeft", "←"],
        ["ArrowRight", "→"],
        ["Backspace", "⌫"],
        ["Delete", "␡"],
        ["Escape", "⎋"],
        ["Tab", "↹"],
    ]
    for (const [long, short] of swaps) {
        if (angledString.includes(long))
            return angledString.replace(long, short)
    }
    return angledString
}
