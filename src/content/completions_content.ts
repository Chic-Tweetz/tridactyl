/**
 *  To allow custom completions to work with objects in content
 *  get custom completions from config by prefix, make a source array
 *  map the source array to an options array, send that to the cmdline
 */

import * as config from "@src/lib/config"
import * as messaging from "@src/lib/messaging"

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
    const order = (customCompletion.columnorder || []).concat(commonColumnsOrder)
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

// callbacks run on the original objects/strings (not the options array)
// though it might be nice to also have the options available
function source_callback(messageId, callbackName, index, prefix, query) {
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
// TODO: probably clean up all our vars above when hide is called
// - notice that showing and hiding the cmdline keeps calling hide
export function hide() {
    // Maybe stop (... as any)ing all the time?
    if ((completionsConfig as any).callbacks?.hide) {
        try { 
            eval((completionsConfig as any).callbacks.hide)()
        } catch (e) {
            console.error("Custom completion callback error: 'hide'")
            console.error(e)
        }
    }
}

async function get_completions(message) {
    const [time, prefix] = message.args
    if (latestRequest > time) return
    latestRequest = time
    const customCompletion = config.get("customcompletions", prefix)

    if (!customCompletion) {
        Promise.resolve({options:[]})
    }

    let response = {
        id: time,
        prefix: prefix,
        title: customCompletion.title || "custom completions",
        options: [],
        excmd: customCompletion.excmd || prefix,
    }

    let sourceArray
    if (customCompletion.srcfn) {
        sourceArray = await eval(customCompletion.srcfn)
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

    // Made this a bit messy didn't I
    const valuefn = customCompletion.valuefn
        ? eval(customCompletion.valuefn)
        : (customCompletion.valuekey
        ? option => option[customCompletion.valuekey]
        : option => option.toString())

    let options = sourceArray.map(option => {
        const cols = columns.map(col => {
            const innerHTML = col.fn(option)
            const fuseKey = col.ignore !== "false"
            return {
                innerHTML,
                fuseKey,
                class: col.class
            }
        })
        let value = valuefn(option)
        return { cols, value }
    })


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
    return messaging.messageOwnTab("custom_completion_frame", "new_completions", [response])
}

// We don't need this to be a function
// but this whole file will be skipped if I don't use something from it in commandline_content :)
export function listenForCustomCompletions() {
    // TODO: set this up properly! Gosh
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "custom_completion_content") {
            if (message.command === "get_completions") {
                get_completions(message)
            } else if (message.command === "source_callback") {
                // What on earth
                source_callback(message.args[0], message.args[1], message.args[2], message.args[3], message.args[4])
            }
        }
    })
}

