/**
 *  To allow custom completions to work with objects in content
 *  get custom completions from config by prefix, make a source array
 *  map the source array to an options array, send that to the cmdline
 */

import * as config from "@src/lib/config"
import * as messaging from "@src/lib/messaging"

// TODO: Consider creating a CustomCompletion class
// functions defined from config would be member functions
// you could set vars using this.whathaveyou

// Decent default columns order (have not gone through every existing completion)
// columns with these names will appear in this order unless told otherwise
const commonColumnsOrder = [
    "prefix",
    "container",
    "icon",
    "label",
    "displayValue",
    "value",
    "name",
    "excmd",
    "theme",
    "title",
    "url",
    "content",
    "type",
    "documentation",
    "doc",
    "description",
    "extrainfo",
    "time",
]

function columnOrder(customCompletion) {
    const columns = customCompletion.columns
    if (!columns) return []
    const order = (customCompletion.columnorder?.split(",") || []).concat(commonColumnsOrder)
    const uniqueRealColumnsOrdered = []

    const unplaced = new Set(Object.keys(columns))

    order.forEach(col => {
        if (unplaced.has(col)) {
            uniqueRealColumnsOrdered.push(col)
            unplaced.delete(col)
        }
    })
    return uniqueRealColumnsOrdered
        .concat(Array.from(unplaced))
}

// Used for callbacks.
// Not sure we can currently guarantee callbacks will be called before new custom completions made
let optionsSource = []
let latestRequest = -1
let completionsConfig = {}
let completionCallbacks = {}

// Do I really need the time/id checks though?
export async function get_custom_completion(time, prefix) {
    if (latestRequest > time) return
    latestRequest = time
    const customCompletion = config.get("customcompletions", prefix)

    if (!customCompletion) return

    let response = {
        id: time,
        prefix: prefix,
        title: customCompletion.title || "custom completions",
        options: [],
        excmd: customCompletion.excmd || prefix,
        rowClass: customCompletion.class || prefix + "CompletionOption",
    }

    let sourceArray
    if (customCompletion.srcfn) {
        // Array.from lets you use things like querySelectorAll with less hassle
        sourceArray = Array.from(await eval(customCompletion.srcfn))
    } else if (customCompletion.srcstrings) {
        sourceArray = customCompletion.srcstrings.split(",")
    } else {
        sourceArray = []
    }

    let columns
    if (customCompletion.columns) {
        columns = columnOrder(customCompletion)
            .map(col => {
                const colSettings = customCompletion.columns[col]
                colSettings.class = colSettings.class || col
                if (colSettings.fn) colSettings.fn = eval(colSettings.fn)
                else if (colSettings.key) colSettings.fn = t => t[colSettings.key]
                else colSettings.fn = option => `column: "${col}" has no fn or key`
                return colSettings
            })
    } else {
        // Single column default, eg for pure string arrays
        columns = [{ class: "value", fn: option => option.toString() }]
    }

    const valuefn = customCompletion.valuefn
        ? await eval(customCompletion.valuefn)
        : (customCompletion.valuekey
        ? option => option[customCompletion.valuekey]
        : option => option.toString())

    let options = await Promise.all(sourceArray.map(async option => {
        const cols = await Promise.all(
            columns.map(async col => {
                const innerHTML = await col.fn(option)
                const fuseKey = col.ignore !== "false"
                return {
                    innerHTML,
                    fuseKey,
                    class: col.class
                }
            })
        )
        let value = valuefn(option)
        return { cols, value }
    }))


    // We should send a message instead of replying to the last one I think
    response.options = options
    optionsSource = sourceArray
    completionsConfig = customCompletion

    // We'll eval callbacks as they're used
    completionCallbacks = {}

    // Special case callback: show might as well be called now right?
    if ((completionsConfig as any).callbacks?.show) {
        try {
            eval((completionsConfig as any).callbacks.show)()
        } catch (e) {
            console.error("Custom Completion Callback: 'show' error.")
            console.error(e)
        }
    }
    return messaging.messageOwnTab("commandline_frame", "custom_completion_options", [response])

}

export function custom_completion_callback(messageId, callbackName, index, prefix, query) {
    // Should think about whether the messageId stuff is necessary
    if (latestRequest !== messageId) return
    if (callbackName === "hide") {
        // There was a reason I separated hide out (I'm sure of it)
        return hide()
    }
    // Eval once and store the function - ought to be more efficient for potentially quick things (select/deselect)
    const callbackBodies = (completionsConfig as any).callbacks
    if (!callbackBodies) return
    const selected = optionsSource[index]
    if (!selected) return

    if (!completionCallbacks[callbackName] && callbackBodies[callbackName]) {
        completionCallbacks[callbackName] = eval(callbackBodies[callbackName])
    }

    completionCallbacks[callbackName]?.(selected, prefix, query)
}

// Exporting hide so it can be called directly from wherever we might need to
export function hide() {
    // Maybe stop (... as any)ing all the time?
    if ((completionsConfig as any).callbacks?.hide) {
        try { 
            eval((completionsConfig as any).callbacks.hide)()
            ;(completionsConfig as any).callbacks.hide = undefined
        } catch (e) {
            console.error("Custom completion callback error: 'hide'")
            console.error(e)
        }
    }
}

