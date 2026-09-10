import { isTextEditable, activeElement } from "@src/lib/dom"
import { contentState, ModeName } from "@src/content/state_content"
import Logger from "@src/lib/logging"
import * as controller from "@src/lib/controller"
import {
    KeyEventLike,
    ParserResponse,
    minimalKeyFromKeyboardEvent,
    MinimalKey,
    PrintableKey,
    // formatKeysForModeIndicator,
    isTrustedKeyboardEvent,
    TrustedKeyboardEvent,
} from "@src/lib/keyseq"
import { ExCommand } from "@src/lib/excmd"

import * as hinting from "@src/content/hinting"
import * as gobblemode from "@src/parsers/gobblemode"
import * as generic from "@src/parsers/genericmode"
import * as nmode from "@src/parsers/nmode"
import * as Messaging from "@src/lib/messaging"
import * as config from "@src/lib/config"
import { mode2maps } from "@src/lib/binding"

const logger = new Logger("controller")

function _mapstrsForMode(mode: string) {
    const maps = config.getDynamic(mode2maps.get(mode) || mode + "maps")
    return Object.keys(maps || {})
}

function isCountAware() {
    return (
        config.get("modesubconfigs", contentState.mode, "countaware") ??
        config.get("countaware")
    ) === "true"
}

let mustBufferPageKeysForClInput = false
let bufferedPageKeys: string[] = []
let bufferingPageKeysBeginTime: number
Messaging.addListener(
    "stop_buffering_page_keys",
    (message, sender, sendResponse) => {
        const bufferingDuration = performance.now() - bufferingPageKeysBeginTime
        logger.debug(
            "stop_buffering_page_keys request received, responding with bufferedPageKeys = ",
            bufferedPageKeys +
                " bufferingDuration = " +
                bufferingDuration +
                "ms",
        )
        sendResponse(Promise.resolve(bufferedPageKeys))
        // At this point, clInput is focused and the page cannot get any more keyboard events
        // until it is refocused.
        mustBufferPageKeysForClInput = false
        bufferedPageKeys = []
    },
)

// Was in ParserController, but buffered keys need to be cancelled too
const cancelKeyups = new Set()

let keysToFeed: KeyEventLike[] = []
let generatorIsWaiting = true

/** Accepts keyevents, resolves them to maps, maps to exstrs, executes exstrs */
function* ParserController() {
    const parsers: {
        [mode_name in ModeName]: (keys: MinimalKey[]) => ParserResponse
    } = {
        normal: keys => generic.parser("nmaps", keys, isCountAware()),
        insert: keys => generic.parser("imaps", keys, isCountAware()),
        input: keys => generic.parser("inputmaps", keys, isCountAware()),
        ignore: keys => generic.parser("ignoremaps", keys, isCountAware()),
        hint: hinting.parser,
        gobble: gobblemode.parser,
        visual: keys => generic.parser("vmaps", keys, isCountAware()),
        nmode: nmode.parser,
    }

    const ignoreKeyupsExplicit = new Set()

    // I believe "ignoreKeyupsContextual" should be default behaviour
    // instead, <D-x> type binds should add to a set to do the opposite (explicitly allow keyups to match nothing/reset keyseq), e.g.
    // const allowResetKeyups = new Set()
    // Currently, moving between same-origin iframes is not great, partly because of this
    const ignoreKeyupsContextual = new Set()
    const ignoreRepeats = new Set()
    let keyEvents: MinimalKey[] = []
    let previousSuffix = ""

    // If we lose focus we have no idea whether keys are held
    // Though we could try to listen in the top window for iframes that receive focus
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
            if (isTrustedKeyboardEvent(keyevent))
                ignoreKeyupsExplicit.add(keyevent.code)
        },
        "ignoreKeyupContextual": (keyevent: KeyEventLike) => {
            if (isTrustedKeyboardEvent(keyevent))
                ignoreKeyupsContextual.add(keyevent.code)
        },
        "ignoreRepeats": (keyevent: KeyEventLike) => {
            if (isTrustedKeyboardEvent(keyevent))
                ignoreRepeats.add(keyevent.code)
        },
        "noReset": (_keyevent: KeyEventLike, response: ParserResponse) => {
            keyEvents = response.keys || []
        },
    }

    function preParseUpdateStateAndShouldSkip(keyevent: KeyEventLike) {
        if (!(isTrustedKeyboardEvent(keyevent))) return false
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

    function postParseUpdateStateAndShouldSkip(keyevent: KeyEventLike, response: ParserResponse) {
        if (!(isTrustedKeyboardEvent(keyevent))) return false
        // Added a "noCancel" property which lets keys through to the page
        // Suggest only careful use with :bindurl, for instance,
        // allow gmail gi shortcut to work:
        // :bind https://mail.google.com <!N-g> noop
        // :unbindurl https://mail.goog.com gi
        // (noop doesn't exist btw, I might add it now!)
        if ((response.isMatch && !response.actions?.includes?.("noCancel")) || contentState.blocking_keypresses) {
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

    while (true) {
        let exstr: ExCommand = ""
        try {
            while (true) {
                generatorIsWaiting = true
                const keyevent: KeyEventLike = keysToFeed.length
                    ? keysToFeed.shift()
                    : yield
                generatorIsWaiting = false

                if (
                    !(keyevent instanceof MinimalKey) &&
                    !isTrustedKeyboardEvent(keyevent)
                ) {
                    logger.warning("Skipped spoofed key event", keyevent)
                    continue
                }

                let textEditable = false

                if (preParseUpdateStateAndShouldSkip(keyevent)) continue

                if (!(keyevent instanceof MinimalKey)) {
                    const deepTarget = activeElement(keyevent.target as HTMLElement) || keyevent.target as HTMLElement
                    textEditable = isTextEditable(deepTarget)
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
                if (shouldEnterInsertMode(currentMode, textEditable)) {
                    contentState.mode = "insert"
                } else if (shouldExitInsertMode(currentMode, textEditable)) {
                    contentState.mode = "normal"
                }

                const newMode = contentState.mode
                if (newMode !== currentMode) {
                    keyEvents = keyEvents.slice(-1)
                    previousSuffix = ""
                }

                const response = (
                    parsers[contentState.mode] ||
                    (keys => generic.parser(contentState.mode + "maps", keys, isCountAware()))
                )(keyEvents)
                logger.debug(
                    currentMode,
                    contentState.mode,
                    keyEvents,
                    response,
                )

                if (postParseUpdateStateAndShouldSkip(keyevent, response)) continue

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

                if (response.exstr && response.isMatch) {
                    exstr = response.exstr
                    break
                }
            }
            // contentState.suffix = ""
            controller
                .acceptExCmd(exstr, "content")
                .catch(e => logger.error("Error executing key binding: ", e))
        } catch (e) {
            // Rumsfeldian errors are caught here
            logger.error("An error occurred in the content controller: ", e)
        }
    }
}

export const generator = ParserController() // var rather than let stops weirdness in repl.
generator.next()

export function startBufferingPageKeys() {
    logger.debug("Starting buffering of page keys")
    bufferingPageKeysBeginTime = performance.now()
    mustBufferPageKeysForClInput = true
    bufferedPageKeys = []
}

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
export function acceptKey(keyevent: TrustedKeyboardEvent) {
    function tryBufferingPageKeyForClInput(keyevent: TrustedKeyboardEvent) {
        if (!mustBufferPageKeysForClInput) return false
        const key = minimalKeyFromKeyboardEvent(keyevent)
        if (
            keyevent.type === "keydown" &&
            (keyevent.key === "Escape" || key.toMapstr() === "<C-[>")
        ) {
            mustBufferPageKeysForClInput = false
            bufferedPageKeys = []
            return false
        }
        const bufferingDuration = performance.now() - bufferingPageKeysBeginTime
        logger.debug(
            "controller_content mustBufferPageKeysForClInput = " +
                mustBufferPageKeysForClInput +
                " bufferingDuration = " +
                bufferingDuration +
                "ms",
        )
        const isCharacterKey =
            keyevent.type === "keydown" &&
            keyevent.key.length == 1 &&
            !keyevent.metaKey &&
            !keyevent.ctrlKey &&
            !keyevent.altKey &&
            !keyevent.metaKey
        if (isCharacterKey) {
            bufferedPageKeys.push(keyevent.key)
            logger.debug("Buffering page keys", bufferedPageKeys)
        }

        // KeyCanceller.push effectively becomes this now:
        if (isTrustedKeyboardEvent(keyevent)) {
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
    if (!tryBufferingPageKeyForClInput(keyevent))
        return generator.next(keyevent)
}

// Allow custom modes which inherit from insert mode to not exit to insert mode automatically
let doExitInsertModes = ["insert", "input"]
let dontEnterInsertModes = ["insert", "input", "hint", "ignore"]
config.getAsync("noinsertmodes")
.then((noinsert) => {
    doExitInsertModes = insertLikeModes()
    .concat(noinsert)
    dontEnterInsertModes = doExitInsertModes.concat(["ignore", "hint"])
})

export function shouldEnterInsertMode(currentMode, textEditable) {
    return textEditable && !dontEnterInsertModes.includes(currentMode)
}

export function shouldExitInsertMode(currentMode, textEditable) {
    return !textEditable && doExitInsertModes.includes(currentMode)
}

function insertLikeModes() {
    return Object.keys(config.get())
        .filter(k => k.endsWith("maps") && inheritsImaps(k))
        .map(k => {
            const mode = k.slice(0, -4)
            return mode === "i" ? "insert" : mode
        })
}

function inheritsImaps(confkey) {
    if (confkey === "imaps") return true
    let conf = config.get(confkey)
    let inherits = conf["🕷🕷INHERITS🕷🕷"]
    while (inherits) {
        if (inherits === "imaps") return true
		conf = config.get(inherits)
        inherits = conf["🕷🕷INHERITS🕷🕷"]
    }
    return false
}

Messaging.addListener("tab_changes", msg => {
    if (msg.command === "tab_left") {
        // TODO: make a new exportable key canceller - I guess just empty the sets
        // canceller.clearQueue()
    }
})

export function acceptTrustedKey(
    keyevent: Event,
    accept: (keyevent: TrustedKeyboardEvent) => unknown = acceptKey,
) {
    if (!isTrustedKeyboardEvent(keyevent)) return
    return accept(keyevent)
}

