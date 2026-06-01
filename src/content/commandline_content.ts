/** Inject an input element into unsuspecting webpages and provide an API for interaction with tridactyl */

import Logger from "@src/lib/logging"
import * as config from "@src/lib/config"
import { theme } from "@src/content/styling"
import * as keyseq from "@src/lib/keyseq"
import * as tri_editor from "@src/lib/editor"
const logger = new Logger("messaging")
const cmdline_logger = new Logger("cmdline")

/* TODO:
    CSS
    Friendliest-to-webpage way of injecting commandline bar?
    Security: how to prevent other people's JS from seeing or accessing the bar or its output?
        - Method here is isolation via iframe
            - Web content can replace the iframe, but can't view or edit its content.
            - see doc/escalating-privilege.md for other approaches.
*/

// inject the commandline iframe into a content page

let cmdline_iframe: HTMLIFrameElement
export function makeIframe() {
    cmdline_iframe = window.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "iframe",
    ) as HTMLIFrameElement
    cmdline_iframe.className = "cleanslate"
    cmdline_iframe.setAttribute(
        "src",
        browser.runtime.getURL("static/commandline.html"),
    )
    cmdline_iframe.setAttribute("id", "cmdline_iframe")
    cmdline_iframe.setAttribute("loading", "lazy")
}
makeIframe()

let enabled = false

/** Initialise the cmdline_iframe element unless the window location is included in a value of config/noiframe */
async function init() {
    const noiframe = await config.getAsync("noiframe")
    const notridactyl = await config.getAsync("superignore")

    if (
        document.contentType != "application/xhtml+xml" &&
        document.contentType.includes("xml")
    ) {
        logger.info("Content type is xml; aborting iframe injection.")
        return
    }

    if (noiframe === "false" && notridactyl !== "true" && !enabled) {
        hide()
        document.documentElement.appendChild(cmdline_iframe)
        enabled = true
        // first theming of page root
        await theme(window.document.querySelector(":root"))

        // Fix #5050: reinsert iframe after React throws a tantrum
        config.getAsync("commandlineterriblewebsitefix").then(enabled => {
            if (enabled == "true") {
                reactIsCrap()
            } else {
                new MutationObserver(changes =>
                    changes.find(change => {
                        for (const addedNode of change.addedNodes) {
                            // detect React server-side render failure by added <link rel='modulepreload'>
                            if (
                                addedNode instanceof HTMLLinkElement &&
                                addedNode.rel === "modulepreload"
                            ) {
                                reactIsCrap()
                            }
                        }
                    }),
                ).observe(cmdline_iframe.parentNode, {
                    childList: true,
                    subtree: true,
                })
            }
        })
    }
}

let hammering_react = false
export async function reactIsCrap() {
    if (hammering_react) return
    hammering_react = true
    cmdline_logger.warning(
        "Possible react server-side render failure detected, starting iframe protection loop",
    )
    while (true) {
        if (cmdline_iframe.contentWindow == null) {
            makeIframe()
            document.documentElement.appendChild(cmdline_iframe)
        }
        await new Promise(resolve => setTimeout(resolve, 500))
    }
}

// Load the iframe immediately if we can (happens if tridactyl is reloaded or on ImageDocument)
// Else load lazily to avoid upsetting page JS that hates foreign iframes.
init().catch(() => {
    // Surrender event loop with setTimeout() to page JS in case it's still doing stuff.
    document.addEventListener("DOMContentLoaded", () =>
        setTimeout(() => {
            init().catch(e =>
                logger.error("Couldn't initialise cmdline_iframe!", e),
            )
        }, 0),
    )
})

export function ensureIframeExists() {
    if (cmdline_iframe && !cmdline_iframe.isConnected) {
        document.documentElement.appendChild(cmdline_iframe)
    }
}

/** Got to be in content if you want to supply a callback
 *  this is for the search bar so we can do incsearch
 *  but we could also do this for that IME issue
 *  https://github.com/tridactyl/tridactyl/discussions/5337
 *
 *  we're just creating an input element & putting it in place of the normal input
 *
 *  oninput only takes a string (the input value) rather than the raw event for simplicity
 *  onaccept and oncancel will listen for <Enter> or <Escape> (by default)
 *
 *  text binds (text.kill_word etc) won't do anything (right now)
 *  but you can import the editor library and make them work no problem
 *
 *  the keybind parsing is pretty janky
 *  usually it'll take exmaps and filter out most ex. binds
 *
 *  but if there's a keymap called ex[name]maps it'll use that
 *  so you can set up different binds per custom input
 *
 *  should probably at least ensure only one "alternate input" can exist
 */
export function showAlternateInput(
    oninput: (arg0: string) => void,
    onaccept?: (arg0: string) => void,
    oncancel?: (arg0: string) => void,
    name = "find",
) {
    ensureIframeExists()
    let normalInput: any
    try {
        normalInput =
            cmdline_iframe.contentDocument.querySelector("#tridactyl-input")
        normalInput.style.display = "none"
    } catch (e) {
        logger.error(e)
        return null
    }

    const inp = document.createElement("input")
    inp.oninput = _event => {
        let val = inp.value
        ;(oninput(inp.value) as any)?.then?.(()=>console.log("oninput finished", val))
    }
    // might be best to change CSS rules from IDs to classes if you wanna do this
    inp.classList.add("tridactyl-input")
    if (name) {
        inp.classList.add(name)
        cmdline_iframe.contentDocument
            .querySelector("#tridactyl-colon")
            .classList.add(name)
    }

    const cleanup = () => {
        if (name) {
            inp.classList.add(name)
            cmdline_iframe.contentDocument
                .querySelector("#tridactyl-colon")
                .classList.remove(name)
        }
        normalInput.style.display = ""
        inp.remove()
        hide_and_blur()
    }

    inp.onblur = () => {
        // actually not sure
        // normalInput.style.display = ""
        // hide_and_blur()
        // oncancel?.(inp.value)
        // inp.remove()
        cleanup()
    }

    // This does seem a bit silly
    let keymap
    try {
        keymap = keyseq.keyMap("ex" + name + "maps")
    } catch (e) {
        keymap = keyseq.keyMap("exmaps")
    }

    // Don't think we'd want any other ex. binds
    // but what if you truly wanted to call an ex. command...?
    const iter = keymap
        .entries()
        .filter(
            ([_keys, cmd]) =>
                !cmd.startsWith("ex.") ||
                cmd === "ex.accept_line" ||
                cmd === "ex.hide_and_clear",
        )

    const filteredMap = new Map()

    let next = iter.next()
    while (!next.done) {
        filteredMap.set(next.value[0], next.value[1])
        next = iter.next()
    }
    keymap = filteredMap

    let keys = []
    inp.addEventListener(
        "keydown",
        e => {
            e.stopImmediatePropagation()
            keys.push(keyseq.minimalKeyFromKeyboardEvent(e))
            const parsed = keyseq.parse(keys, keymap)
            if (parsed.isMatch) {
                e.preventDefault()
                if (parsed.value) {
                    if (parsed.value === "ex.accept_line") {
                        cleanup()
                        setTimeout(() => onaccept?.(inp.value))
                    } else if (parsed.value === "ex.hide_and_clear") {
                        normalInput.style.display = ""
                        cleanup()
                        // not convinced we're returning focus to the main window in time
                        setTimeout(() => oncancel?.(inp.value))
                    } else if (parsed.value.startsWith("text.")) {
                        const args = parsed.value
                            .slice("text.".length)
                            .split(" ")
                        editor_function(
                            inp,
                            args.shift() as keyof typeof tri_editor,
                            ...args,
                        )
                    } else {
                        acceptExCmd(parsed.value)
                    }
                    keys = []
                }
            } else {
                keys = []
            }
        },
        true,
    )

    normalInput.parentElement.appendChild(inp)
    show(true)
    // Doesn't seem to work straight away?
    setTimeout(() => inp.focus())
}

// this will work for our custom inputs yes?
function editor_function(
    input: HTMLElement,
    fn_name: keyof typeof tri_editor,
    ...args
) {
    console.log("text command!", fn_name)
    if (tri_editor[fn_name]) {
        return tri_editor[fn_name](input, ...args)
    } else {
        // The user is using the command line so we can't log message there
        // logger.error(`No editor function named ${fn_name}!`)
        console.error(`No editor function named ${fn_name}!`)
    }
}

export function show(hidehover = false) {
    try {
        /* Hide "hoverlink" pop-up which obscures command line
         *
         * Inspired by VVimpulation: https://github.com/amedama41/vvimpulation/commit/53065d015d1e9a892496619b51be83771f57b3d5
         */
        logger.debug("commandline_content show()")
        if (hidehover) {
            const a = window.document.createElement("A")
            ;(a as any).href = ""
            document.body.appendChild(a)
            a.focus({ preventScroll: true })
            document.body.removeChild(a)
        }

        ensureIframeExists()
        cmdline_iframe.inert = false
        cmdline_iframe.classList.remove("hidden")
        const height =
            cmdline_iframe.contentWindow.document.body.offsetHeight + "px"
        cmdline_iframe.setAttribute("style", `height: ${height} !important;`)
    } catch (e) {
        // Note: We can't use cmdline_logger.error because it will try to log
        // the error in the commandline, which we can't show!
        // cmdline_logger.error(e)
        console.error(e)
    }
}

export function hide() {
    try {
        cmdline_iframe.inert = true
        cmdline_iframe.classList.add("hidden")
        cmdline_iframe.setAttribute("style", "height: 0px !important;")
    } catch (e) {
        // Using cmdline_logger here is OK because cmdline_logger won't try to
        // call hide(), thus we avoid the recursion that happens for show() and
        // focus()
        cmdline_logger.error(e)
    }
}

export function blur() {
    try {
        cmdline_iframe.blur()
    } catch (e) {
        // Same as with hide(), it's ok to use cmdline_logger here
        cmdline_logger.error(e)
    }
}

export function hide_and_blur() {
    hide()
    blur()
}

export function executeWithoutCommandLine(fn) {
    let parent
    if (cmdline_iframe && cmdline_iframe.isConnected) {
        parent = cmdline_iframe.parentNode
        parent.removeChild(cmdline_iframe)
    }
    let result
    try {
        result = fn()
    } catch (e) {
        cmdline_logger.error(e)
    }
    if (cmdline_iframe) parent.appendChild(cmdline_iframe)
    return result
}

import * as Messaging from "@src/lib/messaging"
import * as SELF from "@src/content/commandline_content"
import { acceptExCmd } from "@src/lib/controller"
Messaging.addListener("commandline_content", Messaging.attributeCaller(SELF))
