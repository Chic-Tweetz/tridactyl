import Logger from "@src/lib/logging"
import * as config from "@src/lib/config"
import {
    ExCommand,
    ExProgram,
    isExProgram,
    programSource,
    stripLeadingColons,
} from "@src/lib/excmd"
import { evaluate } from "@src/parsers/exdsl"
import { parser as exmode_parser } from "@src/parsers/exmode"
import * as State from "@src/state"

const logger = new Logger("controller")

type ExCmdSource = "commandline" | "content"
let currentExCmdSource: ExCmdSource
let exCmdListener: () => void

export function setExCmdListener(listener: () => void) {
    exCmdListener = listener
}

let stored_excmds: any
export function setExCmds(excmds: any) {
    stored_excmds = excmds
}

export function getExCmds() {
    return stored_excmds
}

export function setExcmdsForNamespace(namespace: string, excmds: any) {
    stored_excmds[namespace] = excmds
}

export function getCurrentExCmdSource() {
    return currentExCmdSource
}

/** Resolve an ExCmd for direct invocation without changing repeat state. */
export function resolveExCmd(exstr: string) {
    const [func, args] = exmode_parser(exstr, stored_excmds)
    return async (...extraArgs: any[]) => {
        try {
            return await func(...args, ...extraArgs)
        } catch (e) {
            logger.error("controller in excmd: ", e)
        }
    }
}

/** Parse and execute ExCmds */
export async function acceptExCmd(
    excmd: ExCommand,
    source?: ExCmdSource,
    exversion: "1" | "2" = "1",
): Promise<any> {
    const exstr = stripLeadingColons(programSource(excmd))
    if (!exstr.trim()) return
    const isV2 =
        isExProgram(excmd) || (source === "commandline" && exversion === "2")
    const recordedExcmd: ExCommand = isV2
        ? isExProgram(excmd)
            ? { ...excmd, source: exstr }
            : { source: exstr, exversion: 2 }
        : exstr
    const previousExCmdSource = currentExCmdSource
    currentExCmdSource = source || previousExCmdSource
    let lastExUpdate = Promise.resolve()
    // TODO: Errors should go to CommandLine.
    try {
        let recorded = false
        const run = (
            command: string,
            piped = false,
            value?: any,
            program?: ExProgram,
            raw?: string,
        ) => {
            const [func, args, consumed] = exmode_parser(
                command,
                stored_excmds,
                isV2 ? { piped, value } : undefined,
            )
            // A heredoc is one literal argument, not text for the legacy parser.
            if (raw !== undefined) args.push(raw)
            if (
                program &&
                !["autocmd", "bind", "bindurl", "repeat"].some(
                    name => stored_excmds[""][name] === func,
                )
            )
                throw new Error(`${command} does not accept an ex block`)
            // Stop repeat from recursing and don't store private window commands.
            if (!recorded) {
                recorded = true
                if (
                    !config
                        .get("repeatblacklist")
                        .some(excmd => func === stored_excmds[""][excmd]) &&
                    func !== stored_excmds[""].repeat &&
                    func !== stored_excmds[""].fillcmdline &&
                    func !== stored_excmds[""].fillcmdline_notrail &&
                    func !== stored_excmds[""].fillcmdline_tmp &&
                    func !== stored_excmds[""].fillcmdline_nofocus &&
                    func !== stored_excmds[""].updatecheck &&
                    exstr.search("winopen -private") < 0
                )
                    lastExUpdate = State.getAsync("last_ex_str")
                    .then(last_ex_str => {
                        if (
                            (programSource(last_ex_str) !== exstr ||
                                isExProgram(last_ex_str) !== isV2
                            ) && last_ex_str != recordedExcmd
                        ) {
                            return State.getAsync("last_ex_str").then(last_ex_str => {
                                if (last_ex_str != recordedExcmd) {
                                    return State.setAsync("last_ex_str", recordedExcmd)
                                }
                            })
                        }
                    })
                    // This seems more reliable
                    lastExUpdate.then(() => exCmdListener?.(), () => exCmdListener?.())
            }
            const commandArgs = program ? [...args, program] : args
            if (piped && !consumed) commandArgs.push(value)
            return func(...commandArgs)
        }

        if (isV2) return await evaluate(exstr, run)

        try {
            return await run(exstr)
        } catch (e) {
            // Errors from func are caught here (e.g. no next tab)
            logger.error("controller in excmd: ", e)
        }
    } catch (e) {
        // Errors from parser caught here
        logger.error("controller while accepting: ", e)
        if (isV2) throw e
    } finally {
        currentExCmdSource = previousExCmdSource

        void lastExUpdate.then(
            () => exCmdListener?.(),
            () => exCmdListener?.(),
        )
    }
}
