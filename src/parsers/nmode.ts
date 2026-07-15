/** Accept n [mode] commands then execute the other command */

import { contentState } from "@src/content/state_content"
import * as keyseq from "@src/lib/keyseq"
import { mode2maps } from "@src/lib/binding"

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
    // const maps = keyseq.keyMap(conf)
    const trie = keyseq.keyTrie(conf)
    const key = keys[0].key

    if (key === "Escape") {
        const exstr = modeState.endCommand
        modeState = undefined
        return { keys: [], exstr }
    }
    // const response = keyseq.parse(keys, maps)
    const response = keyseq.parse(keys, trie)

    // What if the nmode bind also has corresponding a keyup bind in the temporary mode?
    // Like :bind b nmode...  :bind --mode=whatever <U-b>  ...
    // We'd want to ignore that entirely wouldn't we
    // Would quite like to "capture" keypresses entirely in situations like this, cancelling the keyup/repeats completely
    let inc = 1
    if (!response.isMatch && keys[0].keyup) {
        inc = 0
    }

    if ((response.exstr !== undefined && response.isMatch) || !response.isMatch)
        modeState.curCommands += inc
    if (modeState.curCommands >= modeState.numCommands) {
        const prefix =
            response.exstr === undefined
                ? ""
                : "composite " + response.exstr + "; "
        response.exstr = prefix + modeState.endCommand // NB: this probably breaks any `js` binds
        response.isMatch = true
        modeState = undefined
    }
    return response
}
