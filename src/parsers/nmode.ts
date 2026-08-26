/** Accept n [mode] commands then execute the other command */

import { contentState } from "@src/content/state_content"
import * as keyseq from "@src/lib/keyseq"
import { mode2maps } from "@src/lib/binding"
import { isExProgram } from "@src/lib/excmd"

/** Simple container for the nmode state. */
class NModeState {
    public numCommands = 1
    public curCommands = 0
    public mode = "normal"
    public endCommand = ""
}

let modeState: NModeState

/** Init n [mode] mode. After parsing the defined number of commands, execute
`endCmd`. `Escape` cancels the mode and executes `endCmd`. */
export function init(endCommand: string, mode = "normal", numCommands = 1) {
    contentState.mode = "nmode"
    modeState = new NModeState()
    modeState.endCommand = endCommand
    modeState.numCommands = numCommands
    modeState.mode = mode
}

/** Receive keypress. If applicable, execute a command. */
export function parser(keys: keyseq.MinimalKey[]) {
    keys = keyseq.stripOnlyModifiers(keys)
    if (keys.length === 0) return { keys: [], isMatch: false }
    const conf = mode2maps.get(modeState.mode) || modeState.mode + "maps"

    const trie = keyseq.keyTrie(conf)
    const key = keys[0].key

    if (key === "Escape") {
        const exstr = modeState.endCommand
        modeState = undefined
        return { keys: [], exstr }
    }

    const response = keyseq.parse(keys, trie)

    if (
        (response.isMatch && response.exstr !== undefined) ||
        (!response.isMatch && !keys[0].keyup)
    )
        modeState.curCommands++

    if (modeState.curCommands >= modeState.numCommands) {
        // KeyTrie change: response.exstr only executed if response.match === true
        // But if response.match === true, we cancel the key (which makes no sense for :nmode ignore ...)
        // Luckily we already have the "noCancel" action we can reuse here
        if (!response.isMatch) {
            response.actions = response.actions || []
            response.actions.push("noCancel")
            response.isMatch = true
        }

        if (isExProgram(response.exstr)) {
            response.exstr = {
                ...response.exstr,
                source: `${response.exstr.source}\n${modeState.endCommand}`,
            }
        } else {
            const prefix =
                response.exstr === undefined
                    ? ""
                    : "composite " + response.exstr + "; "
            response.exstr = prefix + modeState.endCommand // NB: this probably breaks any `js` binds
        }
        modeState = undefined
    }
    return response
}
