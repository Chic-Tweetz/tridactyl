/**
 * Tridactyl shared state
 *
 * __NB__: Here be dragons.
 *
 * In the background script, "state" can be used as a normal object. Just "import state from "@src/state"
 *
 * In the content scripts, "state" can be set as a normal object and changes will propagate to the background script.
 *
 * In the content scripts, "state" must be read using "import * as State from "@src/state" and "State.getAsync(property)". If you read it directly with `state` you should get an error at runtime. Certain methods like `concat` will not throw an error but their behaviour is not defined and should be avoided.
 */

import Logger from "@src/lib/logging"
import { ExCommand } from "@src/lib/excmd"
import * as messaging from "@src/lib/messaging"
import { notBackground } from "@src/lib/webext"
import * as R from "ramda"

const logger = new Logger("state")

class State {
    lastSearchQuery: string = undefined
    lastInputSelector: string = undefined
    lastSearchRegex = undefined
    cmdHistory: string[] = []
    prevInputs: Array<{ inputId: string; tab: number; jumppos?: number }> = [
        {
            inputId: undefined,
            tab: undefined,
            jumppos: undefined,
        },
    ]
    last_ex_str: ExCommand = "echo"
    globalMarks: Map<
        string,
        {
            url: string
            scrollX: number
            scrollY: number
            tabId: number
        }
    > = new Map()
    localMarks: Map<
        string,
        Map<
            string,
            {
                scrollX: number
                scrollY: number
            }
        >
    > = new Map()
    beforeJumpMark: {
        url: string
        scrollX: number
        scrollY: number
        tabId: number
    } = undefined
}

// Store these keys in the local browser storage to persist between restarts
const PERSISTENT_KEYS: Array<keyof State> = ["cmdHistory", "globalMarks"]

// Don't change these from const or you risk breaking the Proxy below.
const defaults = Object.freeze(new State())

const overlay = {} as State

// Incognito tabs cab have their own state, local only to that tab and with no persistence
const localOverrides: Map<string, any> = new Map()

browser.storage.local
    .get("state")
    .then(res => {
        if ("state" in res) {
            logger.debug("Loaded initial state:", res.state)
            Object.assign(overlay, res.state)
        }
    })
    .catch((...args) => logger.error(...args))

const state = new Proxy(overlay, {
    /** Give defaults if overlay doesn't have the key */
    get(target, property) {
        if (notBackground())
            throw new Error(
                "State object must be accessed with getAsync in content",
            )
        if (property in target) {
            return target[property]
        } else {
            return defaults[property]
        }
    },

    set(target, property: keyof State, value) {
        logger.debug("State changed!", property, value)
        if (notBackground()) {
            void setAsync(property, value)
            return true
        }

        // Do we need a global storage lock?
        target[property] = value

        // Persist "sets" to storage in the background for some keys
        if (PERSISTENT_KEYS.includes(property)) {
            // Ensure we don't accidentally store anything sensitive
            // Note: This would only prevent writing to persistent storage.
            // The message listener instead prevents writing to state at all.
            if (browser.extension.inIncognitoContext) {
                console.error(
                    "Attempted to write to storage in private window.",
                )
                return false
            }
            browser.storage.local.set({
                state: R.pick(PERSISTENT_KEYS, target),
            })
        }
        return true
    },
})

export async function setAsync<K extends keyof State>(
    property: K,
    value: State[K],
): Promise<void> {
    if (notBackground()) {
        // If trying to set a property inIncognitoContext throws an error,
        // why do we bother sending the message? I've added this else
        // because it just adds errors to the log for no reason imo
        const inIncognitoContext = browser.extension.inIncognitoContext
        if (inIncognitoContext)
            setLocal(property, value)
        else await browser.runtime.sendMessage({
            type: "state",
            command: "stateUpdate",
            args: { property, value, inIncognitoContext },
        })
    } else state[property] = value
}

export async function getAsync<K extends keyof State>(
    property: K,
): Promise<State[K]> {
    if (notBackground()) {
        const stateValue = await browser.runtime.sendMessage({
            type: "state",
            command: "stateGet",
            args: [{ prop: property }],
        })

        return localOverrides.has(property)
            ? localOverrides.get(property)
            : stateValue
    } else {
        return state[property]
    }
}

// Skip this in mock testing - the mock doesn't like notBackground
// Keep instances of state.ts synchronised with each other
if (notBackground && !notBackground()) {
    // Map of properties -> [ tabId, once] }
    // For stateUpdate callbacks for those properties,
    // where if once == true, the callback only triggers once
    // currently, once will always be true so that could be skipped
    // but in theory this could be extended to support proper state change callbacks
    const propertyListeners: Map<string, Map<number, boolean>> = new Map()

    // Clean up listeners when tabs are closed
    browser.tabs.onRemoved.addListener((tabId) => {
        const emptied = []
        for (const [property, tabIdMap] of propertyListeners) {
            tabIdMap.delete(tabId)
            if (tabIdMap.size === 0) emptied.push(property)
        }
        for (const property of emptied) {
            propertyListeners.delete(property)
        }
    })

    messaging.addListener("state", (message, sender, sendResponse) => {
        if (message.command == "stateUpdate") {
            const property = message.args.property
            const value = message.args.value
            // Ensure we don't accidentally store anything sensitive
            const inIncognitoContext = message.args.inIncognitoContext
            if (inIncognitoContext) {
                console.error(
                    "Attempted to write to storage in private window.",
                )
                return
            }
            logger.debug("State changed!", property, value)

            const oldValue = state[property]
            state[property] = value

            // Property listener change callbacks (message tabs listening for property changes)
            for (const [tabId, once] of propertyListeners.get(property) || []) {
                messaging.messageTab(tabId, "state", "statePropertyUpdated", [property, value, oldValue])
                if (once) propertyListeners.get(property).delete(tabId)
            }
        } else if (message.command == "stateGet") {
            sendResponse(state[message.args[0].prop])
        } else if (message.command == "stateAddPropertyUpdateListener") {
            const property = message.args.property
            const tabIds = propertyListeners.get(property) || new Map()
            tabIds.set(sender.tab.id, message.args.once || false)
            propertyListeners.set(message.args.property, tabIds)
            logger.debug("State property:", property, "listener added for tab:", sender.tab.id)
        }else
            throw new Error(
                "Unsupported message to state, type " + message.command,
            )
    })
}

// Update a property in localOverrides for this tab only
// until that property is updated in global state
function setLocal(property, value) {
    addLocalOverrideListener(property)
    localOverrides.set(property, value)
}

// We could have more general onPropertyUpdated-like callbacks
// but I'm just going to do this incognito tab-scoped state stuff for now
let stopListeningForLocalOverrides = () => undefined
let listeningForLocalPropertyOverrides = false

function addLocalOverrideListener(property) {
    if (localOverrides.has(property)) return

    // If the property is updated in global state, remove it from local overrides
    browser.runtime.sendMessage({
        type: "state",
        command: "stateAddPropertyUpdateListener",
        args: { property, once: true },
    })

    if (listeningForLocalPropertyOverrides) return
    stopListeningForLocalOverrides = messaging.addListener(
        "state",
        ({ command, args }) => {
            if (command == "statePropertyUpdated") {
                localOverrides.delete(args[0])
                if (localOverrides.size === 0) {
                    stopListeningForLocalOverrides()
                    listeningForLocalPropertyOverrides = false
                }
            }
        }
    )
    listeningForLocalPropertyOverrides = true
}

export { state as default }
