import { messageOwnTab } from "@src/lib/messaging"
import * as State from "@src/state"
import { contentState } from "@src/content/state_content"
import * as config from "@src/lib/config"

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function awaitProxyEq(proxy, a: string, b: string) {
    let counter = 0
    while (proxy[a] != proxy[b] && counter < 50) {
        await sleep(10)
        counter += 1
    }
    return proxy[a] == proxy[b]
}

// One day we'll use typeof commandline_state from commandline_frame.ts
export function getCommandlineFns(cmdline_state: {
    [otherStuff: string]: any
    fns: ReturnType<typeof getCommandlineFns>
}) {
    return {
        /**
         * Insert the first command line history line that starts with the content of the command line in the command line.
         */
        complete: async () => {
            const fragment = cmdline_state.clInput.value
            const matches = (await State.getAsync("cmdHistory")).filter(key =>
                key.startsWith(fragment),
            )
            const mostrecent = matches[matches.length - 1]
            if (mostrecent !== undefined)
                cmdline_state.clInput.value = mostrecent
            return cmdline_state.refresh_completions(
                cmdline_state.clInput.value,
            )
        },

        /**
         * Selects the next completion.
         */
        next_completion: async () => {
            await awaitProxyEq(
                contentState,
                "current_cmdline",
                "cmdline_filter",
            )
            /*
            if (cmdline_state.activeCompletions)
                cmdline_state.activeCompletions.forEach(comp => comp.next())
            */

            // This does work, but probably a bit of a refactor in order to get multiple sources working
            const visibleCompletions = cmdline_state.activeCompletions.filter(comp => !comp.isHidden())
            if (visibleCompletions.length === 1) {
                visibleCompletions[0].next()
                return
            }
            if (visibleCompletions.length === 0) {
                return
            }

            let currcomp = -1
            let nextcomp = 0
            for (let i = 0; i < visibleCompletions.length; ++i) {
                const comp = visibleCompletions[i]
                const [currind, nextind] = await comp.currentAndNextIndex()
                if (currind > -1) {
                    currcomp = i
                    if (nextind > -1) {
                        nextcomp = currcomp
                    } else if (currcomp + 1 < visibleCompletions.length) {
                        nextcomp = currcomp + 1
                    } else {
                        nextcomp = -1
                    }
                    break
                }
            }

            visibleCompletions.forEach((comp, i) => {
                if (i !== nextcomp) {
                    comp.deselect()
                }
            })
            visibleCompletions[nextcomp]?.next()
        },

        /** Selects the next completion, or history line if none is selected. */
        next_history_or_completion: () =>
            cmdline_state.getActiveCompletionSource()
                ? cmdline_state.fns.next_completion()
                : cmdline_state.fns.next_history(),

        /**
         * Selects the previous completion.
         */
        prev_completion: async () => {
            await awaitProxyEq(
                contentState,
                "current_cmdline",
                "cmdline_filter",
            )
            /*
            if (cmdline_state.activeCompletions)
                cmdline_state.activeCompletions.forEach(comp => comp.prev())
            */
            const visibleCompletions = cmdline_state.activeCompletions.filter(comp => !comp.isHidden())
            if (visibleCompletions.length === 1) {
                visibleCompletions[0].prev()
                return
            }
            if (visibleCompletions.length === 0) {
                return
            }

            let currcomp = -1
            let nextcomp = visibleCompletions.length - 1
            for (let i = visibleCompletions.length - 1; i >= 0; --i) {
                const comp = visibleCompletions[i]
                const [currind, nextind] = await comp.currentAndNextIndex(-1)
                if (currind > -1) {
                    currcomp = i
                    if (nextind > -1) {
                        nextcomp = currcomp
                    } else if (currcomp > 0) {
                        nextcomp = currcomp - 1
                    } else {
                        nextcomp = -1
                    }
                    break
                }
            }

            visibleCompletions.forEach((comp, i) => {
                if (i !== nextcomp) {
                    comp.deselect()
                }
            })
            visibleCompletions[nextcomp]?.prev()
        },

        /** Selects the previous completion, or history line if none is selected. */
        prev_history_or_completion: () =>
            cmdline_state.getActiveCompletionSource()
                ? cmdline_state.fns.prev_completion()
                : cmdline_state.fns.prev_history(),

        /**
         * Deselects the currently selected completion.
         */
        deselect_completion: () => {
            if (cmdline_state.activeCompletions)
                cmdline_state.activeCompletions.forEach(comp => comp.deselect())
        },

        /**
         * Inserts the currently selected completion and a space in the command line.
         */
        insert_completion: async () => {
            await awaitProxyEq(
                contentState,
                "current_cmdline",
                "cmdline_filter",
            )
            const completionSource = cmdline_state.getActiveCompletionSource()
            const completion = completionSource?.completion
            if (cmdline_state.activeCompletions) {
                cmdline_state.activeCompletions.forEach(
                    comp => (comp.completion = undefined),
                )
            }
            let result = Promise.resolve([])
            if (completion) {
                cmdline_state.clInput.value =
                    completion + (completionSource?.trailingSpace ? " " : "")
                result = cmdline_state.refresh_completions(
                    cmdline_state.clInput.value,
                )
            }
            return result
        },

        /** Inserts the selected completion, or its argument/keybinding character. */
        insert_character_or_completion: (character?: string) => {
            if (cmdline_state.getActiveCompletionSource()?.completion)
                return cmdline_state.fns.insert_space_or_completion()
            if (character !== undefined) {
                expandAbbreviation(cmdline_state.clInput)
                insertCharacter(cmdline_state, character)
            }
            return cmdline_state.refresh_completions(
                cmdline_state.clInput.value,
            )
        },

        /**
         * If a completion is selected, inserts it in the command line with a space.
         * If no completion is selected, inserts a space where the caret is.
         */
        insert_space_or_completion: (noTrailingSpace = "false") => {
            const completionSource = cmdline_state.getActiveCompletionSource()
            const completion = completionSource?.completion
            const ignoreSpace = noTrailingSpace === "true"
            if (cmdline_state.activeCompletions) {
                cmdline_state.activeCompletions.forEach(
                    comp => (comp.completion = undefined),
                )
            }
            if (completion) {
                cmdline_state.clInput.value =
                    completion + (!ignoreSpace && completionSource?.trailingSpace ? " " : "")
            } else if (!ignoreSpace) {
                insertCharacter(cmdline_state)
            }
            return cmdline_state.refresh_completions(
                cmdline_state.clInput.value,
            )
        },

        /**
         * Insert a space
         */
        insert_space: () => {
            insertCharacter(cmdline_state)
        },

        /** Hide the command line and cmdline_state.clear its content without executing it. **/
        hide_and_clear: () => {
            cmdline_state.clear(true)
            cmdline_state.keyEvents = []

            // Try to make the close cmdline animation as smooth as possible.
            messageOwnTab("commandline_content", "hide")
            messageOwnTab("commandline_content", "blur")
            // Delete all completion sources - I don't think this is required, but this
            // way if there is a transient bug in completions it shouldn't persist.
            if (cmdline_state.activeCompletions)
                cmdline_state.activeCompletions.forEach(comp => {
                    comp.destroy?.()
                    cmdline_state.completionsDiv.removeChild(comp.node)
                })
            cmdline_state.activeCompletions = undefined
            cmdline_state.isVisible = false
            cmdline_state.resolveCloseWaiters?.()
        },

        /**
         * Check if the command is valid
         */
        is_valid_commandline: (command: string): boolean => {
            if (command === undefined) return false

            const func = command.trim().split(/\s+/)[0]

            return !(func.length === 0 || func.startsWith("#"))
        },

        /**
         * Save non-secret commands to the cmdHistory and update the cmdline_history_position
         */
        store_ex_string: (command: string) => {
            const [func, ...args] = command.trim().split(/\s+/)

            // Save non-secret commandlines to the history.
            if (
                !command.startsWith(" ") &&
                !browser.extension.inIncognitoContext &&
                !(func === "winopen" && args[0] === "-private")
            ) {
                State.getAsync("cmdHistory").then(c => {
                    cmdline_state.state.cmdHistory = c.concat([command])
                })
                cmdline_state.cmdline_history_position = 0
            }
        },

        /**
         * Selects the next history line.
         */
        next_history: () => cmdline_state.history(1),

        /**
         * Selects the prev history line.
         */
        prev_history: () => cmdline_state.history(-1),
        /**
         * Execute the content of the command line and hide it.
         **/
        accept_line: async () => {
            await awaitProxyEq(
                contentState,
                "current_cmdline",
                "cmdline_filter",
            )

            // Callback here perhaps? (callback for any completion with a callback.exec)
            const maybeCompletion = cmdline_state.getCompletion()
            if (maybeCompletion) {
                cmdline_state.custom_callback("exec")
            }
            const command = maybeCompletion || cmdline_state.clInput.value
            // const command =
            //     cmdline_state.getCompletion() || cmdline_state.clInput.value

            cmdline_state.fns.hide_and_clear()

            if (cmdline_state.fns.is_valid_commandline(command) === false)
                return

            cmdline_state.fns.store_ex_string(command)

            // Send excmds directly to our own tab, which fixes the
            // old bug where a command would be issued in one tab but
            // land in another because the active tab had
            // changed. Background-mode excmds will be received by the
            // own tab's content script and then bounced through a
            // shim to the background, but the latency increase should
            // be acceptable becuase the background-mode excmds tend
            // to be a touch less latency-sensitive.
            return messageOwnTab("controller_content", "acceptExCmd", [command, "commandline"])
        },

        execute_ex_on_completion_args: (excmd: string) =>
            execute_ex_on_x(true, cmdline_state, excmd),

        execute_ex_on_completion: (excmd: string) =>
            execute_ex_on_x(false, cmdline_state, excmd),

        execute_ex_on_all_completions: (excmd: string) =>
            execute_ex_on_all(cmdline_state, excmd),

        copy_completion: () => {
            const command = cmdline_state.getCompletion()
            cmdline_state.fns.hide_and_clear()
            return messageOwnTab("controller_content", "acceptExCmd", [
                "clipboard yank " + command,
            ])
        },

        // can't seem to focus the commandline from here??
        editor: () => {
            messageOwnTab(
                "controller_content",
                "acceptExCmd",
                ["editor_excmd fillcmdline_notrail " + cmdline_state.clInput.value],
            ).then(() => {
                cmdline_state.clInput.focus()
            })
        },

        // Why did I name this action and everything else callback? Why comment about it instead of changing it??
        custom_completion_action: (callbackName: string) => {
            const completion = cmdline_state.getCompletion()
            if (completion) {
                cmdline_state.custom_callback(callbackName)
            }
        },
    }
}

function execute_ex_on_x(
    args_only: boolean,
    cmdline_state,
    excmd: string,
    args?: string,
) {
    const maybeCompletion = cmdline_state.getCompletion(args_only)
    args ??=
        maybeCompletion || cmdline_state.clInput.value
    if (maybeCompletion) {
        cmdline_state.custom_callback("execute_ex_on_x", { excmd, args })
    }
    const cmdToExec = (excmd ? excmd + " " : "") + args
    cmdline_state.fns.store_ex_string(cmdToExec)

    return messageOwnTab("controller_content", "acceptExCmd", [cmdToExec])
}

async function execute_ex_on_all(cmdline_state, excmd: string) {
    await cmdline_state.refresh_completions(cmdline_state.clInput.value)
    return Promise.all(
        cmdline_state
            .getCompletions()
            .map(command =>
                execute_ex_on_x(false, cmdline_state, excmd, command),
            ),
    )
}

/** @hidden */
export function expandAbbreviation(input) {
    const selectionStart = input.selectionStart
    const selectionEnd = input.selectionEnd
    const abbreviation = input.value.substring(0, selectionStart).match(/\S+$/)?.[0]
    if (!abbreviation) return
    const expansion = config.get("abbreviations", abbreviation)
    if (typeof expansion !== "string") return
    input.setRangeText(expansion, selectionStart - abbreviation.length, selectionStart, "end")
    input.selectionEnd = selectionEnd + expansion.length - abbreviation.length
}

function insertCharacter(cmdline_state, character = " ") {
    const selectionStart = cmdline_state.clInput.selectionStart
    const selectionEnd = cmdline_state.clInput.selectionEnd
    cmdline_state.clInput.value =
        cmdline_state.clInput.value.substring(0, selectionStart) +
        character +
        cmdline_state.clInput.value.substring(selectionEnd)
    cmdline_state.clInput.selectionStart = cmdline_state.clInput.selectionEnd =
        selectionStart + character.length
}
