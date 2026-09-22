import Logger from "@src/lib/logging"
import * as config from "@src/lib/config"
import { MinimalKey } from "@src/lib/keyseq"
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
    keyseq: MinimalKey[] = []
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
    | "keyseq"

export type ContentStateChangedCallback = (
    property: ContentStateProperty,
    oldMode: any,
    oldValue: any,
    newValue: any,
) => void

const onChangedListeners: ContentStateChangedCallback[] = []

export function addContentStateChangedListener(
    callback: ContentStateChangedCallback,
) {
    onChangedListeners.push(callback)
}

let consumeAllKeysModes = ["hint"]
config.addChangeListener("modesubconfigs", (_, neww) => {
    consumeAllKeysModes = Object.entries(neww)
        .filter(([_mode, { consumeallkeys }]) => consumeallkeys === "true")
        .map(([mode]) => mode)
})

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

            if (oldValue === newValue) return true
            for (const listener of onChangedListeners) {
                listener(property, mode, oldValue, newValue)
            }
            if (property === "mode" && oldValue !== newValue) {
                contentState.blocking_keypresses = consumeAllKeysModes.includes(newValue)
            }
            return true
        },
    },
) as any as ContentState
