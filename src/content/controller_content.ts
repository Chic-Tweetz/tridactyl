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

// Cancel these keyups so the page doesn't receive them
const cancelKeyups = new Set()

// "Consume" these keyevents - neither the page or Tridactyl will use them
// Some system like this is essential for situations like ":bind <U-g>" interfering with ":bind gg"
// Contextual keyups should let us be more lenient with the :bind grammar (like "g<U-g>" working as well as "<D-g><U-g>")
//    x  binds contextually cancel keyups
// <P-x> binds cancel all repeats and keyups
// <D-x> binds cancel repeats
// What does that leave?
//  - cancel neither
//  - cancel keyup (non-contextual/explicit)
const consumeKeyups = new Set()
const consumeKeyupsContextual = new Set() // Ignore these keyups only if the parser didn't have to reset to the trie root
const consumeRepeats = new Set()

// If we lose focus we have no idea whether keys are held
window.addEventListener("blur", e => {
    if (!e.isTrusted) return
    cancelKeyups.clear()
    consumeKeyups.clear()
    consumeKeyupsContextual.clear()
    consumeRepeats.clear()
})

let keysToFeed: KeyEventLike[] = []
let generatorIsWaiting = true

// Thinking we could pass a state object to the key parser to keep things easy
export interface ParserState {
    trie: Map<string, any>
    resetNode?: Map<string, any>
    currentNode?: Map<string, any>
    numericPrefix?: string | undefined
    heldKeys: Set<string>
    cancelKeyups: Set<string>
    ignoreKeyupsContextual: Set<string>
    ignoreKeyupsExplicit: Set<string>
    ignoreRepeats: Set<string>
}

/** Accepts keyevents, resolves them to maps, maps to exstrs, executes exstrs */
function* ParserController() {
    const parsers: {
        [mode_name in ModeName]: (keys: MinimalKey[], startNode?: Map<string, any>) => ParserResponse
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

    const parserState: ParserState = {
        heldKeys: new Set(),
        cancelKeyups: new Set(),
        ignoreKeyupsContextual: new Set(),
        ignoreKeyupsExplicit: new Set(),
        ignoreRepeats: new Set(),
    }

    // Removed the "startNode" stuff and now I think it would be better to have it
    // just to make "noShadow" easier
    // here's a problem case:
    // :bind <DN-x> ...
    // - so we cancel repeats, but not the keyup
    // - we stay on the same node thanks to N
    // - so press x - do command - release x - do command again!? Ugh!
    // We return the same node because we pass a keyseq like [<D-x>, <U-x>]
    // <U-x> doesn't match anything, but ... oh no i'm confused again!

    // I've just noticed the nested while loops and am now wondering about this
    // let node: Map<string, any> | null = null
    // let lastMode = contentState.mode
    let keyEvents: MinimalKey[] = [] // Moved out of loop to let noShadow work
    let noShadowNode: Map<String, any> | null = null
    let previousSuffix = ""

    while (true) {
        let exstr = ""
        try {
            while (true) {
                generatorIsWaiting = true
                const keyevent: KeyEventLike = keysToFeed.length ? keysToFeed.shift() : yield
                generatorIsWaiting = false

                // keyEvents = []

                // Getting nice and confusing at this point
                if (keyevent.code && keyevent instanceof KeyboardEvent) {
                    if (keyevent.type === "keyup") {
                        if (cancelKeyups.has(keyevent.code)) {
                            if (keyevent instanceof KeyboardEvent) {
                                keyevent.preventDefault()
                                keyevent.stopImmediatePropagation()
                            }
                            cancelKeyups.delete(keyevent.code)
                        }
                        consumeRepeats.delete(keyevent.code)

                        if (consumeKeyups.has(keyevent.code) && !consumeKeyupsContextual.has(keyevent.code)) {
                            consumeKeyups.delete(keyevent.code)

                            // If we've matched a keydown, we want to cancel the keyup no matter what
                            // so key cancelling should be separated from key "consuming"
                            // consuming is basically preventing any tridactyl binds as well as the page
                            if (keyevent instanceof KeyboardEvent) {
                                keyevent.preventDefault()
                                keyevent.stopImmediatePropagation()
                            }
                            continue
                        }
                    } else if (keyevent.repeat && consumeRepeats.has(keyevent.code)) {
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
                    // node = null
                    keyEvents = keyEvents.slice(-1)
                    previousSuffix = null
                }

                // if (newMode !== lastMode) {
                //     node = null
                // }

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

                // Think canceller needs a rethink? We'll cancel keyups when checking our sets now
                // Hmm. I'm throwing these preventDefaults and stopImmediatePropagations around now though
                if (response.isMatch && keyevent instanceof KeyboardEvent) {
                    // canceller.push(keyevent)
                    // This is basically what a new version of canceller.push would be:
                    if (keyevent instanceof KeyboardEvent) {
                        keyevent.preventDefault()
                        keyevent.stopImmediatePropagation()
                    }

                    if (keyevent.type === "keydown") {
                        cancelKeyups.add(keyevent.code)
                    }
                }

                // we're saying, if we want to cancel a keyup contextually, we should only do it if the parser didn't have to start over
                // so if you had "x" bound and typed "gx", that would be a "reset" because we didn't use the "g" node
                if (keyevent instanceof KeyboardEvent &&
                    keyevent.type === "keyup" &&
                    consumeKeyupsContextual.has(keyevent.code)
                ) {
                    consumeKeyupsContextual.delete(keyevent.code)
                    consumeKeyups.delete(keyevent.code)

                    if (response.didReset) {
                        keyEvents.pop()
                        continue
                    }
                }


                // Don't think you're reliably getting rid of the noShadowNode right now
                // Umm, you're also not using it at all :)
                if (response.trieNode?.has("noShadow") && noShadowNode === response.trieNode) {
                    noShadowNode = null
                }

                // node = response.trieNode || null

                if (response.cancelKeyupsContextual?.length && keyevent instanceof KeyboardEvent) {
                    for (const keyCode of response.cancelKeyupsContextual) {
                        consumeKeyupsContextual.add(keyCode)
                    }
                } else if (response.cancelKeyups?.length && keyevent instanceof KeyboardEvent) {
                    for (const keyCode of response.cancelKeyups) {
                        consumeKeyups.add(keyCode)
                    }
                }

                if (response.cancelRepeats?.length && keyevent instanceof KeyboardEvent) {
                    for (const keyCode of response.cancelRepeats) {
                        consumeRepeats.add(keyCode)
                    }
                }

                // With "noShadow" nodes, we can land on a command node without actually matching it (how?)
                // so we want to check isMatch to make sure we've moved to a new node
                // I wish I'd kept track of the different bind types i've tried and the issues they've had >:|
                // now i don't remember what this response.isMatch check affected!
                if (response.exstr && response.isMatch) {
                    keyEvents = []
                    // stickyRepeat -> remain on same node so repeats keep firing this command even if in a sequence
                    if (response.trieNode?.has("stickyRepeat") && keyevent.code) {
                        // make sure we can escape the sticky node by not consuming keyups
                        consumeKeyups.delete(keyevent.code)
                        consumeKeyupsContextual.delete(keyevent.code)
                        consumeRepeats.delete(keyevent.code)

                        keyEvents = response.keys || []
                    }

                    if (response.trieNode?.has("noShadow")) {
                        noShadowNode = response.trieNode
                        keyEvents = response.keys || []
                    } else {
                        noShadowNode = null
                    }

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

                    const suffix = keyEvents.map(x => PrintableKey(x)).join("")
                    if (previousSuffix !== suffix) {
                        contentState.suffix = suffix
                        previousSuffix = suffix
                    }

                    break
                } else {
                    keyEvents = response.keys || []

                    // show current keyEvents as a suffix of the contentState
                    const suffix = keyEvents.map(x => PrintableKey(x)).join("")
                    if (previousSuffix !== suffix) {
                        contentState.suffix = suffix
                        previousSuffix = suffix
                    }
                    logger.debug("suffix: ", suffix)
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
