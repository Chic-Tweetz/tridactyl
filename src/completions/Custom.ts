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

    // I am yet to implement anything for Fuse
    public fuseKeys = []
    public indexInSource: number

    constructor(option, className) {
        super()

        // Just building <td>s for each column (would it be nice to allow for more?)
        this.html = document.createElement("tr")
        this.html.classList.add("option")
        this.html.classList.add(className)
        option.cols.forEach(col => {
            let td = document.createElement("td")
            if (col.class) td.className = col.class
            td.innerHTML = col.innerHTML || ""
            this.html.appendChild(td)
            // Is this a good idea? I'm not clear whether fuse is used if not explicitly in the filter function anyway
            // I should get make fuse working at some point though
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
        // prefixes, css class, title
        // you'd want these to change depending on the source though
        super(customPrefixes, "CustomCompletionSource", "Custom Completions")
        this._parent.appendChild(this.node)
        messaging.addListener("custom_completion_frame", (message) => this.optionsFromMessage(message))
    }

    // Added some general callbacks so you can have however many you like
    // :bind --mode=ex [bind] ex.custom_completion_action [actionName]
    // and can call some by default when choosing / selecting / etc
    // added a ...args in case that might be useful somewhere
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

    // Run script in content in case you want access to the tri object
    // or want to use the DOM / other unserialisable objects
    // the idea is we first create a "source" array
    // then map the source array according to config to an "options" array
    // trying to preserve both in case we want to call callbacks on original source objects
    private async requestCompletions(prefix: string) {
        // Using time as completion IDs so we can ignore any messages for older completion sources
        const time = Date.now()
        if (time < this.messageId) return
        this.messageId = time
        return messaging.messageOwnTab("custom_completion_content", "get_completions", [time, prefix])
    }

    // Receive message from content containing everything needed to populate options
    private async optionsFromMessage(message) {
        // Why am I not using the convenient messaging API
        if (message.command !== "new_completions") return
        if (this.messageId !== message.args[0].id) return

        // Want to be able to relate completions to source array somehow
        // index in respective arrays is fine, let's just add it here
        this.optionsSource = message.args[0].options.map((opt, i) => {
            opt.index = i
            return opt
        })

        const header = this.node.querySelector(".sectionHeader")
        if (header) header.textContent = message.args[0].title

        // If we just set them all, updateChain filters them as long as there are fuseKeys
        this.options = this.optionsSource.map(opt => new CustomCompletionOption(opt, message.rowClass))
        //     .filter(option => !option.cols.every(col => !col.innerHTML.toLowerCase().includes(query.toLowerCase())))
        //     .map(option => new CustomCompletionOption(option))

        // This message will force the resize so the input isn't pushed off-screen
        this.filter(this.lastExstr)
            .then(() => messaging.messageOwnTab("commandline_content", "show"))
    }

    // Filter as normal, but also we can pull custom completions from config using prefix
    public async filter(exstr: string, optionsSource?) {
        this.lastExstr = exstr

        // Going off of src/completions/Settings.ts for lots of this
        let [prefix, query] = this.splitOnPrefix(exstr)

        if (prefix) {
            if (this.state === "hidden") {
                this.state = "normal"
            }
        } else {
            this.state = "hidden"

            // "hide" callback might be needed to cleanup, want to call it whenever options are lost
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
            // Invalidate previous options so they'll work properly if same prefix is used again next
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

            // Needn't do this as we just store the completionConfig object now
            this.trailingSpace = this.completionConfig.trailingspace === "false" ? false : true
        this.excmdSpace = this.completionConfig.excmdspace === "false" ? "" : " "
        this.excmd = this.completionConfig.excmd || prefix
        this.autoselect = this.completionConfig.autoselect === "true"

            // filter will be called again when receiving a response
            this.requestCompletions(prefix)
            return
        }

        // TODO: This isn't how filtering should work (we have Fuse after all), just getting something working
        // this.options = this.optionsSource
        //     .filter(option => !option.cols.every(col => !col.innerHTML.toLowerCase().includes(query.toLowerCase())))
        //     .map(option => new CustomCompletionOption(option))

        return this.updateChain()
    }

    setStateFromScore(scoredOpts: Completions.ScoredOption[]) {
        super.setStateFromScore(scoredOpts, this.autoselect)
    } 

    select(option: CustomCompletionOption) {
        if (this.lastExstr !== undefined && option !== undefined) {
            const [prefix] = this.splitOnPrefix(this.lastExstr)

            // might want to let this be more flexible
            // in fact, yes we should allow the value to be set from a function
            // option => "whatever " + option.key + " more whatever"
            // that sort of thing, for now we at least allow any excmd to be set
            this.completion = [this.excmd, option.value].join(this.excmdSpace)

            this.args = option.value
            option.state = "focused"
            this.lastFocused = option

            // all this callback stuff might be useful... maybe
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

