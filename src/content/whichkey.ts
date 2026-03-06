import { addContentStateChangedListener } from "@src/content/state_content"
import * as keyseq from "@src/lib/keyseq"
import * as State from "@src/state"
import { ownTabId } from "@src/lib/webext"
import { getAsync } from "@src/lib/config"
import {
    DEFAULTS,
    USERCONFIG,
    mergeDeepCull,
    addChangeListener,
    get as confget,
} from "@src/lib/config"

let whichkeyIframe: HTMLIFrameElement

let level = "none"
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

        // iframe.style.display = "none"
        iframe.style.position = "fixed"
        iframe.style.right = "40px"
        iframe.style.bottom = "40px"
        iframe.style.width = "250px"
        iframe.style.height = "460px"
        iframe.style.border = "1px solid rgb(13 185 215)"
        iframe.style.borderRadius = "5px"

        iframe.src = browser.runtime.getURL("static/blank.html")
        iframe.onload = () => {
            if (iframe.contentDocument) {
                const table = document.createElement("table")
                iframe.contentDocument.body.appendChild(table)
                completions = table
                whichkeyIframe = iframe
                resolve(iframe)
            } else {
                reject(iframe)
            }
        }
        document.documentElement.appendChild(iframe)
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
        const header = document.createElement("tr")
        header.textContent = extra
        frag.appendChild(header)

        if (extra === "markjump") {
            const beforeMark = await State.getAsync("beforeJumpMark")
            if (beforeMark) {
                const row = document.createElement("tr")
                const keyCol = document.createElement("td")
                const scrollCol = document.createElement("td")
                keyCol.textContent = "`"
                scrollCol.textContent =
                    beforeMark.scrollX + "," + beforeMark.scrollY
                row.appendChild(keyCol)
                if ((await ownTabId()) !== beforeMark.tabId) {
                    const urlCol = document.createElement("td")
                    urlCol.textContent = beforeMark.url
                    row.appendChild(urlCol)
                }
                row.appendChild(scrollCol)
                frag.appendChild(row)
            }
        }

        const localHeader = document.createElement("tr")
        localHeader.textContent = "local marks"
        frag.appendChild(localHeader)

        marksForPage.forEach((scrolls, key) => {
            const row = document.createElement("tr")
            const keyCol = document.createElement("td")
            const scrollCol = document.createElement("td")
            keyCol.textContent = key
            ;(scrollCol.textContent as any) =
                scrolls.scrollX + "," + scrolls.scrollY
            ;(row as any).replaceChildren(keyCol, scrollCol)
            frag.appendChild(row)
        })

        const globalHeader = document.createElement("tr")
        globalHeader.textContent = "global marks"
        frag.appendChild(globalHeader)

        globalMarks.forEach((mark, key) => {
            const { scrollX, scrollY, url } = mark
            const row = document.createElement("tr")
            const keyCol = document.createElement("td")
            const urlCol = document.createElement("td")
            const scrollCol = document.createElement("td")
            keyCol.textContent = key
            urlCol.textContent = url
            scrollCol.textContent = scrollX + "," + scrollY
            ;(row as any).replaceChildren(keyCol, urlCol, scrollCol)
            frag.appendChild(row)
        })

        completions.replaceChildren(frag)
        const cs = getComputedStyle(document.documentElement)
        whichkeyIframe.contentDocument.body.style.background =
            cs.getPropertyValue("--tridactyl-cmplt-bg")
        whichkeyIframe.contentDocument.body.style.color = cs.getPropertyValue(
            "--tridactyl-cmplt-fg",
        )
        whichkeyIframe.contentDocument.body.style.fontFamily =
            cs.getPropertyValue("--tridactyl-cmplt-font-family")
        whichkeyIframe.contentDocument.body.style.fontSize =
            cs.getPropertyValue("--tridactyl-cmplt-font-size")
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

        console.log("suffix:", suffixStripped)
        console.log("canon:", pressed)
        console.log("seq:", pressedSeq)

        let mapsKey
        if (["normal", "insert", "visual"].includes(mode)) {
            mapsKey = mode[0] + "maps"
        } else {
            mapsKey = mode + "maps"
        }

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
        const frag = document.createDocumentFragment()
        const exaliases = confget("exaliases")

        keymaps.forEach(([name, keymap]) => {
            const comps = keyseq.completions(pressedSeq, keymap)
            if (comps.size === 0) return
            const header = document.createElement("tr")
            header.textContent =
                name === mapsKey ? name : "inerited from " + name
            frag.appendChild(header)
            const keystrings = parseKeyComps(comps)

            keystrings.forEach(([unpressed, cmd]) => {
                const pressedSpan = document.createElement("span")
                const unpressedSpan = document.createElement("span")
                const keysCol = document.createElement("td")
                const cmdLink = document.createElement("a")
                const cmdRestSpan = document.createElement("span")
                const cmdCol = document.createElement("td")
                const row = document.createElement("tr")

                pressedSpan.style.color = "rgb(99, 109, 166)"
                unpressedSpan.style.color = "rgb(129, 254, 131)"
                cmdCol.style.color = "rgb(192, 153, 255)"

                const cmdFirstWord = (cmd as string).split(" ", 1)[0]
                const cmdRest = (cmd as string).slice(cmdFirstWord.length)

                pressedSpan.textContent = pressed
                unpressedSpan.textContent = unpressed as string

                let hrefToAnchor
                const namespaceSplit = cmdFirstWord.split(".")
                const namespace =
                    namespaceSplit.length > 1 ? namespaceSplit[0] : ""
                switch (namespace) {
                    case "hint":
                        hrefToAnchor =
                            "static/docs/modules/_src_content_hinting_.html#"
                        break
                    case "text":
                        hrefToAnchor =
                            "static/docs/modules/_src_lib_editor_.html#"
                        break
                    case "ex":
                        hrefToAnchor =
                            "static/docs/modules/_src_commandline_frame_.html#"
                        break
                    default:
                        hrefToAnchor = "static/docs/modules/_src_excmds_.html#"
                }
                const firstCmd = namespace.length
                    ? cmdFirstWord.slice(namespace.length + 1)
                    : cmdFirstWord

                // for aliases, you'd want to change the link
                // eg :tabclosealltoright -> :tabcloseallto
                cmdLink.href = browser.runtime.getURL(
                    hrefToAnchor +
                        (exaliases[cmdFirstWord]
                            ? exaliases[cmdFirstWord].split(" ", 1)[0]
                            : firstCmd.toLowerCase()),
                )
                cmdLink.target = "_blank"
                cmdLink.textContent = cmdFirstWord
                cmdRestSpan.textContent = cmdRest
                ;(cmdCol as any).replaceChildren(cmdLink, cmdRestSpan)
                ;(keysCol as any).replaceChildren(pressedSpan, unpressedSpan)
                ;(row as any).replaceChildren(keysCol, cmdCol)
                frag.appendChild(row)
            })
        })

        whichkeyIframe.style.display = ""
        const cs = getComputedStyle(document.documentElement)
        whichkeyIframe.contentDocument.body.style.background =
            cs.getPropertyValue("--tridactyl-cmplt-bg")
        whichkeyIframe.contentDocument.body.style.color = cs.getPropertyValue(
            "--tridactyl-cmplt-fg",
        )
        whichkeyIframe.contentDocument.body.style.fontFamily =
            cs.getPropertyValue("--tridactyl-cmplt-font-family")
        whichkeyIframe.contentDocument.body.style.fontSize =
            cs.getPropertyValue("--tridactyl-cmplt-font-size")
        completions.replaceChildren(frag)
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

addChangeListener("whichkey", (_old, neww) => {
    level = neww
    if (whichkeyIframe) {
        if (level === "none") whichkeyIframe.style.display = "none"
        if (level === "all") whichkeyIframe.style.display = ""
    } else if (level !== "none") {
        init()
    }
})
