import * as Completions from "@src/completions"
import * as aliases from "@src/lib/aliases"
import * as config from "@src/lib/config"
import * as messaging from "@src/lib/messaging"

// Am I using all these?
let source = null
let customCompletions = {}
let customPrefixes = []
let customFuseKeys = []

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
            td.innerHTML = col.innerHTML || ""
            this.html.appendChild(td)

            // Might you ever want fuseKeys which don't show up in the options table?
            // note: textContent to avoid <html tags> being part of the fuseKey
            if (col.fuseKey) this.fuseKeys.push(td.textContent)
        })
        this.value = option.value
        this.indexInSource = option.index
    }
}

// Added a bunch of extra fields here, probably don't need them all
export class CustomCompletionSource extends Completions.CompletionSourceFuse {
    public options: CustomCompletionOption[]
    private optionsSource = []
    private lastSource: string | null
    private excmd: string
    private excmdSpace = " "
    private srcFn
    private messageId: number = -1
    private completionConfig
    private autoselect = false

    constructor(private _parent) {
        super(customPrefixes, "CustomCompletionSource", "Custom Completions")
        this._parent.appendChild(this.node)
        messaging.addListener("custom_completion_frame", (message) => this.optionsFromMessage(message))
    }

    // some callbacks (exec, show, hide, select, deselect) are called automatically
    // any callback can be bound in this fashion (to work with any completion with that callback):
    // :bind --mode=ex [bind] ex.custom_completion_action [callbackName]
    public custom_callback(callbackName: string = "exec", ...args) {
        if (this.lastFocused && this.completionConfig.callbacks?.[callbackName]) {
            const [prefix, query] = this.splitOnPrefix(this.lastExstr)
            messaging.messageOwnTab(
                "custom_completion_content",
                "source_callback", 
                [
                    this.messageId,
                    callbackName,
                    (this.lastFocused as CustomCompletionOption).indexInSource,
                    prefix,
                    query,
                    ...args,
                ]
            )
        }
    }

    // Scripts are run in content so they have access to tri object and page DOM
    private async requestCompletions(prefix: string) {
        const time = Date.now()
        if (time < this.messageId) return
        this.messageId = time
        return messaging.messageOwnTab("custom_completion_content", "get_completions", [time, prefix])
    }

    // Receive message from content containing everything needed to populate options
    private async optionsFromMessage(message) {
        // TODO: use the messaging API everything else uses!
        if (message.command !== "new_completions") return
        if (this.messageId !== message.args[0].id) return

        // Add index for callbacks to source array
        this.optionsSource = message.args[0].options.map((opt, i) => {
            opt.index = i
            return opt
        })

        const header = this.node.querySelector(".sectionHeader")
        if (header) header.textContent = message.args[0].title

        this.options = this.optionsSource.map(opt => new CustomCompletionOption(opt, message.rowClass))

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
                    "custom_completion_content",
                    "source_callback", 
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
            this.requestCompletions(prefix)
            return
        }

        return this.updateChain()
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

