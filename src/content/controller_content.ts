import { isTextEditable } from "@src/lib/dom"
import { contentState, ModeName } from "@src/content/state_content"
import Logger from "@src/lib/logging"
import * as controller from "@src/lib/controller"
import {
    KeyEventLike,
    ParserResponse,
    minimalKeyFromKeyboardEvent,
    MinimalKey,
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

    if (k.altKey) {
        result = "A-" + result
    }
    if (k.ctrlKey) {
        result = "C-" + result
    }
    if (k.shiftKey) {
        result = "S-" + result
    }
    if (result.length > 1) {
        result = "<" + result + ">"
    }
    return result
}

/**
 * KeyCanceller: keep track of keys that have been cancelled in the keydown
 * handler (which takes care of dispatching ex commands) and also cancel them
 * in keypress/keyup event handlers. This fixes
 * https://github.com/tridactyl/tridactyl/issues/234.
 *
 * If you make modifications to this class, keep in mind that keyup events
 * might not arrive in the same order as the keydown events (e.g. user presses
 * A, then B, releases B and then A).
 */
class KeyCanceller {
    private keyPress: KeyboardEvent[] = []
    private keyUp: KeyboardEvent[] = []

    constructor() {
        this.cancelKeyUp = this.cancelKeyUp.bind(this)
        this.cancelKeyPress = this.cancelKeyPress.bind(this)
    }

    push(ke: KeyboardEvent) {
        ke.preventDefault()
        ke.stopImmediatePropagation()
        this.keyPress.push(ke)
        this.keyUp.push(ke)
    }

    public cancelKeyPress = (ke: KeyboardEvent) => {
        if (!ke.isTrusted) return
        this.cancelKey(ke, this.keyPress)
    }

    public cancelKeyUp = (ke: KeyboardEvent) => {
        if (!ke.isTrusted) return
        this.cancelKey(ke, this.keyUp)
    }

    private cancelKey(ke: KeyboardEvent, kes: KeyboardEvent[]) {
        const index = kes.findIndex(
            ke2 =>
                ke.altKey === ke2.altKey &&
                ke.code === ke2.code &&
                ke.composed === ke2.composed &&
                ke.ctrlKey === ke2.ctrlKey &&
                ke.metaKey === ke2.metaKey &&
                ke.shiftKey === ke2.shiftKey &&
                ke.target === ke2.target,
        )
        if (index >= 0 && ke instanceof KeyboardEvent) {
            ke.preventDefault()
            ke.stopImmediatePropagation()
            kes.splice(index, 1)
        }
    }
}

export const canceller = new KeyCanceller()

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

// Most key binds like "a", "<D-a>", sort of "<R-a>" can prevent repeats and the keyup for "a" from doing anything
// "<R-a>" would prevent the keyups but allow repeats, good for something like j/k (without keydown/keyup smoothscrolling that is)
// Like the normal key canceller, these need to be reset when the page loses focus because we won't know that they're released otherwise
let consumeKeyups = new Set()
let consumeRepeats = new Set()

/** Accepts keyevents, resolves them to maps, maps to exstrs, executes exstrs */
function* ParserController() {
    const parsers: {
        [mode_name in ModeName]: (keys: MinimalKey[], startNode?: Map<string, any>) => ParserResponse
    } = {
        normal: (keys, node) => generic.parser("nmaps", keys, node),
        insert: (keys, node) => generic.parser("imaps", keys, node),
        input: (keys, node) => generic.parser("inputmaps", keys, node),
        ignore: (keys, node) => generic.parser("ignoremaps", keys, node),
        hint: hinting.parser,
        gobble: gobblemode.parser,
        visual: (keys, node) => generic.parser("vmaps", keys, node),
        nmode: nmode.parser,
    }

    while (true) {
        let exstr = ""
        let previousSuffix = null
        let keyEvents: MinimalKey[] = []
        let node: Map<string, any> | null = null
        try {
            while (true) {
                const keyevent: KeyEventLike = yield
                keyEvents = []
                console.log("parsing:", keyevent)

                if (keyevent.code) {
                    if (
                        (
                            (keyevent as KeyboardEvent).type === "keyup" ||
                            (keyevent as MinimalKey).keyup
                        )
                        && consumeKeyups.has(keyevent.code)
                    ) {
                        if (consumeKeyups.has(keyevent.code)) {
                            consumeKeyups.delete(keyevent.code)
                            consumeRepeats.delete(keyevent.code)

                            console.log("consuming keyup:", keyevent.code, consumeKeyups, consumeRepeats)

                            // Presumably we'd already have pushed to the canceller?
                            // if (keyevent instanceof KeyboardEvent) {
                            //     keyevent.preventDefault()
                            //     keyevent.stopImmediatePropagation()
                            // }

                            continue
                        }
                    } else if (keyevent.repeat && consumeRepeats.has(keyevent.code)) {
                        console.log("cancelling repeat:", keyevent.code)
                        if (keyevent instanceof KeyboardEvent) {
                            keyevent.preventDefault()
                            keyevent.stopImmediatePropagation()
                        }
                        continue
                    }
                }

                let shadowRoot = null
                let textEditable = false

                if (keyevent instanceof KeyboardEvent) {
                    shadowRoot = deepestShadowRoot(
                        (keyevent.target as Element).shadowRoot,
                    )

                    textEditable =
                        shadowRoot === null
                            ? isTextEditable(keyevent.target as Element)
                            : isTextEditable(shadowRoot.activeElement)
                    // Accumulate key events. The parser will cut this
                    // down whenever it's not a valid prefix of a known
                    // binding, so it can't grow indefinitely unless you
                    // have a combination of maps that permits bindings of
                    // unbounded length.
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
                    node = null
                    keyEvents = keyEvents.slice(-1)
                    previousSuffix = null
                }

                console.log("NODE BEFORE", node)

                const response = (
                    parsers[contentState.mode] ||
                    ((keys, node) => generic.parser(contentState.mode + "maps", keys, node))
                )(keyEvents, node || undefined)
                logger.debug(
                    currentMode,
                    contentState.mode,
                    keyEvents,
                    response,
                )

                if (response.isMatch && keyevent instanceof KeyboardEvent) {
                    canceller.push(keyevent)
                }
                
                console.log("response", response)
                node = response.trieNode || null
                console.log("NODE AFTER", node)

                if (response.cancelKeyups && keyevent instanceof KeyboardEvent) {
                    for (const keyCode of response.cancelKeyups) {
                        consumeKeyups.add(keyCode)
                        console.log("keyups to consume:", consumeKeyups)
                    }
                }

                if (response.cancelRepeats && keyevent instanceof KeyboardEvent) {
                    for (const keyCode of response.cancelRepeats) {
                        consumeRepeats.add(keyCode)
                        console.log("repeats to consume:", consumeRepeats)
                    }
                }

                if (response.exstr) {
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
                } else {
                    // If I change to start nodes, we don't want to remember the full path
                    // keyEvents = response.keys

                    // show current keyEvents as a suffix of the contentState
                    const suffix = keyEvents.map(x => PrintableKey(x)).join("")
                    if (previousSuffix !== suffix) {
                        contentState.suffix = suffix
                        previousSuffix = suffix
                    }
                    logger.debug("suffix: ", suffix)
                }
            }
            contentState.suffix = ""
            controller.acceptExCmd(exstr)
        } catch (e) {
            // Rumsfeldian errors are caught here
            logger.error("An error occurred in the content controller: ", e)
        }
    }
}

export const generator = ParserController() // var rather than let stops weirdness in repl.
generator.next()

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
        canceller.push(keyevent)
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
