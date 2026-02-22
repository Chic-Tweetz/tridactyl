import * as Completions from "@src/completions"
import * as aliases from "@src/lib/aliases"
import * as config from "@src/lib/config"
import * as messaging from "@src/lib/messaging"

// Getting completions from config (mainly for the prefixes which enable them)
let customCompletions = {}
let customPrefixes = []

config.getAsync("customcompletions")
    .then(cc => {
        customCompletions = cc
        customPrefixes = Object.keys(cc)
    }
)

config.addChangeListener("customcompletions", () => {
    customCompletions = config.get("customcompletions")
    customPrefixes = Object.keys(customCompletions)
})

// Can I be sure config.getAsync will finish before these constructors are called?
class CustomCompletionOption extends Completions.CompletionOptionHTML
    implements Completions.CompletionOptionFuse {

    public fuseKeys = []
    public indexInSource: number

    constructor(option, className) {
        super()

        this.html = document.createElement("tr")
        this.html.classList.add("option")
        this.html.classList.add(className)
        option.cols.forEach(col => {
            let td = document.createElement("td")
            if (col.class) td.className = col.class
            // Cleaning strings with <tag-like> structures (eg key binds like <Enter>) is a pain
            // make setting HTML opt-in, just set text usually
            if (col.setHTML) td.innerHTML = col.innerHTML || ""
            else td.textContent = col.innerHTML
            this.html.appendChild(td)

            // Might you ever want fuseKeys which don't show up in the options table?
            // note: textContent to avoid <html tags> being part of the fuseKey
            if (col.fuseKey) this.fuseKeys.push(td.textContent)
        })
        this.value = option.value
        this.indexInSource = option.index
    }
}

// moving listener outside of class - should be able to use it in commandline_frame.ts now
// Need to keep track of the CustomCompletionSource somehow (this'll do for me)
let source = null
export function custom_completion_options(message) {
    source?.receiveOptions(message)
}

// Added a bunch of extra fields here, probably don't need them all
export class CustomCompletionSource extends Completions.CompletionSourceFuse {
    public options: CustomCompletionOption[]
    private optionsSource = []
    private lastSource: string | null
    private excmd: string
    private excmdSpace = " "
    private messageId: number = -1
    private completionConfig
    private autoselect = false

    constructor(private _parent) {
        super(customPrefixes, "CustomCompletionSource", "Custom Completions")
        this._parent.appendChild(this.node)

        // Accidentally readding this listener whenever commandline_frame's enableCompletions is called
        // messaging.addListener("custom_completion_frame", (message) => this.optionsFromMessage(message))
        source = this
    }

    // some callbacks (exec, show, hide, select, deselect) are called automatically
    // any callback can be bound in this fashion (to work with any completion with that callback):
    // :bind --mode=ex [bind] ex.custom_completion_action [callbackName]
    public custom_callback(callbackName: string = "exec", ...args) {
        const focused = (this.lastFocused as CustomCompletionOption)

        const selectionOptional = ["show", "hide", "query"]
        const sendit = focused || selectionOptional.includes(callbackName)

        if (sendit && this.completionConfig.callbacks?.[callbackName]) {
            const [prefix, query] = this.splitOnPrefix(this.lastExstr)
            messaging.messageOwnTab(
                "commandline_content",
                "custom_completion_callback", 
                [
                    this.messageId,
                    callbackName,
                    focused ? focused.indexInSource : -1,
                    prefix,
                    query,
                    ...args,
                ]
            )
            if (callbackName === "delete") this.deleteOption(focused)
        }
    }

    // Scripts are run in content so they have access to tri object and page DOM
    private async requestCompletions(prefix: string, query?: string) {
        const time = Date.now()
        // how could time be less than the last one? What was I going for with this messageId stuff?
        // I think we could probably lose it...
        // we can check the prefix is correct if we're worried about old responses
        if (time < this.messageId) return
        this.messageId = time
        return messaging.messageOwnTab("commandline_content", "get_custom_completion", [time, prefix, query])
    }

    // I think this should be included somehow (like how :tab and :taball update themselves)
    public async refreshOptions() {
        let [prefix, _query] = this.splitOnPrefix(this.lastExstr)
        this.requestCompletions(prefix)
    }

    // let's say if you have a delete callback defined, you may reasonably expect the option to disappear?
    public async deleteOption(option?: CustomCompletionOption) {
        option = option || (this.lastFocused as CustomCompletionOption)
        if (!option) return
        const ind = this.options.indexOf(option)
        if (ind < 0) return

        this.options.splice(ind, 1)
        this.options = this.options.filter(opt => option !== opt)
        this.updateChain()

        if (this.options.length)
            this.select(this.options[Math.min(ind, this.options.length - 1)])
    }

    // Receive message from content containing everything needed to populate options
    public async receiveOptions(optionsData) {
        // again, not sure about this time ID stuff
        if (this.messageId !== optionsData.id) return

        // Add index for callbacks to source array
        this.optionsSource = optionsData.options.map((opt, i) => {
            opt.index = i
            return opt
        })

        const header = this.node.querySelector(".sectionHeader")
        if (header) header.textContent = optionsData.title

        this.options = this.optionsSource.map(opt => new CustomCompletionOption(opt, optionsData.rowClass))

        // Force a resize to not push input off screen
        this.filter(this.lastExstr)
            .then(() => messaging.messageOwnTab("commandline_content", "show"))
    }

    public async filter(exstr: string, optionsSource?) {
        this.lastExstr = exstr

        let [prefix, query] = this.splitOnPrefix(exstr)

        if (prefix) {
            if (this.state === "hidden") {
                this.state = "normal"
            }
        } else {
            this.state = "hidden"

            if ((this.completionConfig as any)?.callbacks?.hide) {
                messaging.messageOwnTab(
                    "commandline_content",
                    "custom_completion_callback", 
                    [
                        this.messageId,
                        "hide",
                        (this.lastFocused as CustomCompletionOption)?.indexInSource || -1,
                        prefix,
                        query,
                    ]
                )
            }
            this.lastSource = null
            return
        }

        if (this.lastSource !== prefix) {
            this.lastSource = prefix
            this.completionConfig = prefix ? config.get("customcompletions", prefix) : null

            if (!this.completionConfig) {
                this.state = "hidden"
                return
            }

            // Just use this.completionConfig instead of setting all these?
            this.trailingSpace = this.completionConfig.trailingspace === "false" ? false : true
            this.excmdSpace = this.completionConfig.excmdspace === "false" ? "" : " "
            this.excmd = this.completionConfig.excmd || prefix
            this.autoselect = this.completionConfig.autoselect === "true"

            // filter will be called again when receiving a response so we can return now
            this.requestCompletions(prefix, query)
            return
        }

        // Should have a timeout for these for typing fast (unless that's handled elsewhere already?)
        this.custom_callback("query");

        this.updateChain()
        // we can make a "live" excmd and hide the completions div
        if (this.options.length === 0) this.state = "hidden"
    }

    setStateFromScore(scoredOpts: Completions.ScoredOption[]) {
        super.setStateFromScore(scoredOpts, this.autoselect)
    } 

    select(option: CustomCompletionOption) {
        if (this.lastExstr !== undefined && option !== undefined) {
            const [prefix] = this.splitOnPrefix(this.lastExstr)

            this.completion = [this.excmd, option.value].join(this.excmdSpace)

            this.args = option.value
            option.state = "focused"
            this.lastFocused = option

            if (this.completionConfig.callbacks?.select) {
                this.custom_callback("select")
            }
        } else {
            throw new Error("lastExstr and option must be defined!")
        }
    }

    deselect() {
        if (this.completionConfig.callbacks?.deselect) {
            this.custom_callback("deselect")
        }
        this.completion = undefined
        if (this.lastFocused !== undefined) this.lastFocused.state = "normal"
    }
}

