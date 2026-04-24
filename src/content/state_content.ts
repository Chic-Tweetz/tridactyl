import Logger from "@src/lib/logging"
import * as config from "@src/lib/config"
const logger = new Logger("state")

export type ModeName =
    | "normal"
    | "insert"
    | "hint"
    | "ignore"
    | "gobble"
    | "input"
    | "visual"
    | "nmode"

export class PrevInput {
    inputId: string
    tab: number
    jumppos?: number
}

class ContentState {
    mode: ModeName = "normal"
    suffix = ""
    group = ""
    current_cmdline = ""
    cmdline_filter = ""
    pseudo_mode = ""
    blocking_keypresses = false
}

export type ContentStateProperty =
    | "mode"
    | "cmdHistory"
    | "prevInputs"
    | "suffix"
    | "typedKeys"
    | "group"
    | "pseudo_mode"
    | "blocking_keypresses"

export type ContentStateChangedCallback = (
    property: ContentStateProperty,
    oldValue: any,
    newValue: any,
    suffix: any,
) => void

const onChangedListeners: ContentStateChangedCallback[] = []

export function addContentStateChangedListener(
    callback: ContentStateChangedCallback,
) {
    onChangedListeners.push(callback)
}

export const contentState = new Proxy(
    { mode: "normal" },
    {
        get(target, property: ContentStateProperty) {
            return target[property]
        },

        set(target, property: ContentStateProperty, newValue) {
            logger.debug("Content state changed!", property, newValue)

            const oldValue = target[property]
            const mode = target.mode

            target[property] = newValue

            for (const listener of onChangedListeners) {
                listener(property, mode, oldValue, newValue)
            }
            if (property === "mode" && oldValue !== newValue) {
                const consumeKeyModes = config.get("blockpagekeypressesmodes").split(" ").filter(m => m.length > 0)
                contentState.blocking_keypresses = consumeKeyModes.includes(newValue)
            }
            return true
        },
    },
) as any as ContentState
