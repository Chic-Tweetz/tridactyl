import * as Completions from "@src/completions"
import * as config from "@src/lib/config"
import {
    defaultConfigMembers,
    memberDoc,
    memberType,
    typeToString,
    isBoolString,
} from "@src/.metadata.generated"

class SettingsCompletionOption extends Completions.CompletionOptionHTML implements Completions.CompletionOptionFuse {
    public fuseKeys = []

    constructor(
        public value: string,
        setting: { name: string; value: string; type: string; doc: string },
    ) {
        super()
        this.html = html`<tr class="SettingsCompletionOption option">
            <td class="title">${setting.name}</td>
            <td class="content">${setting.value}</td>
            <td class="type">${setting.type}</td>
            <td class="doc">${setting.doc}</td>
        </tr>`
    }
}

export class SettingsCompletionSource extends Completions.CompletionSourceFuse {
    public options: SettingsCompletionOption[]

    constructor(private _parent) {
        super(
            ["set", "setnull", "get", "unset", "seturl", "unseturl", "viewconfig", "setmode", "unsetmode"],
            "SettingsCompletionSource",
            html`<table>
                <tr>
                    <td class="title">Settings</td>
                    <td class="content">Current value</td>
                    <td class="type">Possible values</td>
                    <td class="doc">Documentation</td>
                </tr>
            </table>`,
        )

        this._parent.appendChild(this.node)
    }

    public async filter(exstr: string) {
        this.lastExstr = exstr
        let [prefix, query] = this.splitOnPrefix(exstr)
        let options = ""

        // Hide self and stop if prefixes don't match
        if (prefix) {
            // Show self if prefix and currently hidden
            if (this.state === "hidden") {
                this.state = "normal"
            }
        } else {
            this.state = "hidden"
            return
        }
        prefix = this.canonicalisePrefix(prefix)

        if (prefix === "unseturl" && !query.includes(" ")) {
            this.options = Object.keys(config.get("subconfigs"))
                .filter(pattern => pattern.startsWith(query))
                .sort()
                .map(
                    pattern =>
                        new SettingsCompletionOption(pattern, {
                            name: pattern,
                            value: "",
                            type: "URL Pattern",
                            doc: "",
                        }),
                )
            return this.updateChain()
        }

        // Ignoring command-specific arguments
        // It's terrible but it's ok because it's just a stopgap until an actual commandline-parsing API is implemented
        // copy pasting code is fun and good
        if (
            prefix === "seturl" ||
            prefix === "unseturl" ||
            (prefix === "viewconfig" &&
                (query.startsWith("--user") || query.startsWith("--default")))
        ) {
            const args = query.split(" ")
            options = args.slice(0, 1).join(" ")
            query = args.slice(1).join(" ")
        }

        options += options ? " " : ""

        const settings = config.get()

        if (settings === undefined) {
            return
        }

        // Ideally these would work with deepKeys like `:set noa.b.c` => `:set a.b.c false`
        // Or `:set a.b.c!` or `:set inva.b.c`
        const vimSugarPrefix = prefix.startsWith("set") ? ["no", "inv"].find(boolPrefix => query.startsWith(boolPrefix)) : undefined
        // const queryNoPrefix = vimSugarPrefix ? query.slice(vimSugarPrefix.length) : undefined

        // Some tweaks to show completions for nested objects
        // would be nice to get this working for keys a "." in them like autocmd urls
        const deepQuery = query.split(/[\. ]/)

        if (deepQuery.length > 1 && vimSugarPrefix && !settings.hasOwnProperty(deepQuery[0]))
            deepQuery[0] = deepQuery[0].slice(vimSugarPrefix.length)

        query = deepQuery.pop()

        let target = settings
        deepQuery.every(key => {
            const next = target[key]
            if (typeof next === "object") target = next
            else target = {}
            return next
        })

        const deepKeys = deepQuery.length ? deepQuery.join(".") + "." : ""

        const vimSugarPostfix = ["!"].find(boolPostfix => query.endsWith(boolPostfix))

        let matches
        if (vimSugarPrefix && deepQuery.length === 0) {
            const slicedQuery = query.slice(vimSugarPrefix.length)
            matches = Object.keys(target)
                .filter(x => x.startsWith(query) || (
                    isBoolString(defaultConfigMembers[x]?.type) &&
                    x.startsWith(slicedQuery)
                ))
        } else if (vimSugarPostfix) {
            const slicedQuery = query.slice(0, -vimSugarPostfix.length)
            matches = Object.keys(target)
                .filter(x => (
                        isBoolString(defaultConfigMembers[x]?.type) &&
                        x.startsWith(slicedQuery)
                    ) || (x.startsWith(query)))
        } else {
            matches = Object.keys(target)
               .filter(x => x.startsWith(query))
        }

        if (matches.length === 0 && query !== "")
            matches = Object.keys(settings).filter(x => x.includes(query))

        this.options = matches
            .sort()
            .map((setting) => {
                const md = defaultConfigMembers[setting]
                return new SettingsCompletionOption(options + (vimSugarPrefix || "") + deepKeys + setting + (vimSugarPostfix || ""), {
                    name: setting,
                    value: JSON.stringify(settings[setting]),
                    doc: memberDoc(md),
                    type: md ? typeToString(memberType(md)) : "",
                })
            })

        return this.updateChain()
    }

    updateChain() {
        // Options are pre-trimmed to the right length.
        this.options.forEach(option => (option.state = "normal"))

        // Call concrete class
        return this.updateDisplay()
    }
}
