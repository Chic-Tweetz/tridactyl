import { isTextEditable } from "@src/lib/dom"
import { contentState, ModeName } from "@src/content/state_content"
import Logger from "@src/lib/logging"
import * as controller from "@src/lib/controller"
import {
    KeyEventLike,
    ParserResponse,
    minimalKeyFromKeyboardEvent,
    MinimalKey,
    keyEventToString,
} from "@src/lib/keyseq"
import { deepestShadowRoot } from "@src/lib/dom"

import * as hinting from "@src/content/hinting"
import * as gobblemode from "@src/parsers/gobblemode"
import * as generic from "@src/parsers/genericmode"
import * as nmode from "@src/parsers/nmode"
import * as Messaging from "@src/lib/messaging";
import * as config from "@src/lib/config"

const logger = new Logger("controller")

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

    let prefix = ""
    if (k.keyup) {
        prefix += "U"
    }
    if (k.altKey) {
        prefix += "A"
    }
    if (k.ctrlKey) {
        prefix += "C"
    }
    if (k.shiftKey) {
        prefix += "S"
    }
    if (prefix.length > 0) {
        result = prefix + "-" + result
    }
    if (result.length > 1) {
        result = "<" + result + ">"
    }
    return result
}

let commandlineFrameReadyToReceiveMessages = false
config.getAsync("noiframe").then(noiframe => {
    if(noiframe === "true") {
        commandlineFrameReadyToReceiveMessages = true
    } else {
        Messaging.addListener("commandline_frame_ready_to_receive_messages", () => {
            logger.debug("Received commandline_frame_ready_to_receive_messages")
            commandlineFrameReadyToReceiveMessages = true
        })
    }
})

let mustBufferPageKeysForClInput = false
let bufferedPageKeys: string[] = []
let bufferingPageKeysBeginTime: number
Messaging.addListener("stop_buffering_page_keys", (message, sender, sendResponse) => {
    const bufferingDuration = performance.now() - bufferingPageKeysBeginTime;
    logger.debug("stop_buffering_page_keys request received, responding with bufferedPageKeys = ", bufferedPageKeys
        + " bufferingDuration = " + bufferingDuration + "ms")
    sendResponse(Promise.resolve(bufferedPageKeys))
    // At this point, clInput is focused and the page cannot get any more keyboard events
    // until it is refocused.
    mustBufferPageKeysForClInput = false
    bufferedPageKeys = []
})

// Was in ParserController, but buffered keys need to be cancelled too
const cancelKeyups = new Set()

let keysToFeed: KeyEventLike[] = []
let generatorIsWaiting = true

/** Accepts keyevents, resolves them to maps, maps to exstrs, executes exstrs */
function* ParserController() {
    const parsers: {
        [mode_name in ModeName]: (keys: MinimalKey[]) => ParserResponse
    } = {
        normal: keys => generic.parser("nmaps", keys),
        insert: keys => generic.parser("imaps", keys),
        input: keys => generic.parser("inputmaps", keys),
        ignore: keys => generic.parser("ignoremaps", keys),
        hint: hinting.parser,
        gobble: gobblemode.parser,
        visual: keys => generic.parser("vmaps", keys),
        nmode: nmode.parser,
    }

    // Cancel these keyups so the page doesn't receive them
    const ignoreKeyupsExplicit = new Set()
    const ignoreKeyupsContextual = new Set()
    const ignoreRepeats = new Set()

    // If we lose focus we have no idea whether keys are held
    window.addEventListener("blur", e => {
        if (!e.isTrusted) return
        cancelKeyups.clear()
        ignoreKeyupsExplicit.clear()
        ignoreKeyupsContextual.clear()
        ignoreRepeats.clear()
    })

    // Trie node properties map to functions that update key sets
    // node properties are set according to bind modifiers (not modifier keys mind you)
    // - honestly I should decide on some names to separate modifier keys and node properties
    // - also keys as in keypresses and keys as in key/value pairs in the tries!
    //   which are encoded from keys as in keypresses! Ahh!
    // :bind <D-x>, <P-x>, <R-x>, <N-x> are what set these properties
    const parserActions = {
        "ignoreKeyupExplicit": (keyevent: KeyEventLike) => {
            if (keyevent instanceof KeyboardEvent)
                ignoreKeyupsExplicit.add(keyevent.code)
        },
        "ignoreKeyupContextual": (keyevent: KeyEventLike) => {
            if (keyevent instanceof KeyboardEvent)
                ignoreKeyupsContextual.add(keyevent.code)
        },
        "ignoreRepeats": (keyevent: KeyEventLike) => {
            if (keyevent instanceof KeyboardEvent)
                ignoreRepeats.add(keyevent.code)
        },
        "noShadow": (_keyevent: KeyEventLike, response: ParserResponse) => {
            keyEvents = response.keys || []
        },
    }

    // Returns boolean indicating whether to skip the keyevent entirely
    function updateKeySetsPreParse(keyevent: KeyboardEvent) {
        if (keyevent.type === "keyup") {
            if (cancelKeyups.has(keyevent.code)) {
                keyevent.preventDefault()
                keyevent.stopImmediatePropagation()
                cancelKeyups.delete(keyevent.code)
            }

            ignoreRepeats.delete(keyevent.code)

            // Contextual ignoring depends on parser response later
            if (
                ignoreKeyupsExplicit.has(keyevent.code) &&
                !ignoreKeyupsContextual.has(keyevent.code)
            ) {
                ignoreKeyupsExplicit.delete(keyevent.code)
                return true
            }
        } else if (keyevent.repeat && ignoreRepeats.has(keyevent.code)) {
            keyevent.preventDefault()
            keyevent.stopImmediatePropagation()
            return true
        }
        return false
    }

    // Again, returns true if the keypress should be ignored
    function updateKeySetsPostParse(keyevent: KeyboardEvent, response: ParserResponse) {
        // Added a "noCancel" property which lets keys through to the page
        // Suggest only careful use with :bindurl, for instance,
        // allow gmail gi shortcut to work:
        // :bind https://mail.google.com <!N-g> noop
        // :unbindurl https://mail.goog.com gi
        // (noop doesn't exist btw, I might add it now!)
        if (response.isMatch && !response.actions?.includes?.("noCancel")) {
            keyevent.preventDefault()
            keyevent.stopImmediatePropagation()

            if (keyevent.type === "keydown") {
                cancelKeyups.add(keyevent.code)
            }
        }

        // Here's where "contextual" cancellation/ignoring happens
        if (
            keyevent.type === "keyup" &&
            ignoreKeyupsContextual.has(keyevent.code)
        ) {
            ignoreKeyupsContextual.delete(keyevent.code)
            ignoreKeyupsExplicit.delete(keyevent.code)

            if (response.didReset) {
                keyEvents.pop()
                return true
            }
        }
        return false
    }

    let keyEvents: MinimalKey[] = []
    let previousSuffix = ""

    while (true) {
        let exstr = ""
        try {
            while (true) {
                generatorIsWaiting = true
                const keyevent: KeyEventLike = keysToFeed.length ? keysToFeed.shift() : yield
                generatorIsWaiting = false

                let shadowRoot = null
                let textEditable = false

                if (keyevent instanceof KeyboardEvent) {
                    if (updateKeySetsPreParse(keyevent))
                        continue

                    shadowRoot = deepestShadowRoot(
                        (keyevent.target as Element).shadowRoot,
                    )

                    textEditable =
                        shadowRoot === null
                            ? isTextEditable(keyevent.target as Element)
                            : isTextEditable(shadowRoot.activeElement)

                    keyEvents.push(minimalKeyFromKeyboardEvent(keyevent))
                } else {
                    keyEvents.push(keyevent)
                }

                // _just to be safe_, cache this to make the following
                // code more thread-safe.
                const currentMode = contentState.mode

                // This code was sort of the cause of the most serious bug in Tridactyl
                // to date (March 2018).
                // https://github.com/tridactyl/tridactyl/issues/311
                if (
                    currentMode !== "ignore" &&
                    currentMode !== "hint" &&
                    currentMode !== "input"
                ) {
                    if (textEditable) {
                        if (currentMode !== "insert") {
                            contentState.mode = "insert"
                        }
                    } else if (currentMode === "insert") {
                        contentState.mode = "normal"
                    }
                } else if (currentMode === "input" && !textEditable) {
                    contentState.mode = "normal"
                }

                const newMode = contentState.mode
                if (newMode !== currentMode) {
                    keyEvents = keyEvents.slice(-1)
                    previousSuffix = ""
                }

                const response = (
                    parsers[contentState.mode] ||
                    (keys => generic.parser(contentState.mode + "maps", keys))
                )(keyEvents)
                logger.debug(
                    currentMode,
                    contentState.mode,
                    keyEvents,
                    response,
                )

                if (keyevent instanceof KeyboardEvent)
                    if (updateKeySetsPostParse(keyevent, response))
                        continue

                keyEvents = []

                response.actions?.forEach?.(
                    action => parserActions[action]?.(keyevent, response)
                )

                if (!response.exstr || !response.isMatch)
                    keyEvents = response.keys || []

                const suffix = keyEvents.map(x => PrintableKey(x)).join("")
                if (previousSuffix !== suffix) {
                    contentState.suffix = suffix
                    previousSuffix = suffix
                }
                logger.debug("suffix: ", suffix)

                // With "noShadow" nodes, we can land on a command node without actually matching it (how?)
                // so we want to check isMatch to make sure we've moved to a new node
                // I wish I'd kept track of the different bind types i've tried and the issues they've had >:|
                // now i don't remember what this response.isMatch check affected!
                if (response.exstr && response.isMatch) {
                    exstr = response.exstr
                    if (
                        exstr.startsWith("fillcmdline") &&
                        !exstr.startsWith("fillcmdline_tmp") &&
                        !exstr.startsWith("fillcmdline_nofocus")
                    ) {
                        logger.debug("Starting buffering of page keys")
                        bufferingPageKeysBeginTime = performance.now()
                        mustBufferPageKeysForClInput = true
                        bufferedPageKeys = []
                    }
                    break
                }
            }
            controller.acceptExCmd(exstr)
        } catch (e) {
            // Rumsfeldian errors are caught here
            logger.error("An error occurred in the content controller: ", e)
        }
    }
}

export const generator = ParserController() // var rather than let stops weirdness in repl.
generator.next()

export function keyMuncher(...keys: KeyEventLike[]) {
    if (keys.length === 0) return
    if (generatorIsWaiting) {
        keysToFeed = keysToFeed.concat(keys)
        generator.next(keysToFeed.shift())
    } else {
        keysToFeed = keysToFeed.concat(keys)
    }
}

/** Feed keys to the ParserController, unless they should be buffered to be later fed to clInput */
export function acceptKey(keyevent: KeyboardEvent) {
    function tryBufferingPageKeyForClInput(keyevent: KeyboardEvent) {
        if (!mustBufferPageKeysForClInput)
            return false;
        const bufferingDuration = performance.now() - bufferingPageKeysBeginTime;
        logger.debug("controller_content mustBufferPageKeysForClInput = " + mustBufferPageKeysForClInput
            + " bufferingDuration = " + bufferingDuration + "ms");
        const isCharacterKey = keyevent.key.length == 1
            && !keyevent.metaKey && !keyevent.ctrlKey && !keyevent.altKey && !keyevent.metaKey;
        if (isCharacterKey) {
            bufferedPageKeys.push(keyevent.key);
            logger.debug("Buffering page keys", bufferedPageKeys)
        }

        // KeyCanceller.push effectively becomes this now:
        if (keyevent instanceof KeyboardEvent) {
            keyevent.preventDefault()
            keyevent.stopImmediatePropagation()
            if (keyevent.type === "keydown") {
                cancelKeyups.add(keyevent.code)
            } else {
                cancelKeyups.delete(keyevent.code)
            }
        }
        return true
    }
    if (!commandlineFrameReadyToReceiveMessages) {
        // If the commandline frame cannot receive messages, the fillcmdline message sent by excmds.fillcmdline() to the
        // commandline frame will never be received. As a result, commandline_frame.focus() will not be called, which
        // in turn means that the stop_buffering_page_keys message will never be sent to the content/page process.
        // If the content/page process starts buffering keys for clInput, but the stop_buffering_page_keys message is never received,
        // it will keep buffering (and eating events) forever.
        logger.debug("controller_content Ignoring key event ", keyevent, " since commandline frame is not yet ready to receive messages", keyevent)
        return
    }
    if (!tryBufferingPageKeyForClInput(keyevent))
        return generator.next(keyevent)
}
