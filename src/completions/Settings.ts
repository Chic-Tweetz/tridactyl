import * as Completions from "@src/completions"
import * as config from "@src/lib/config"
import {
    defaultConfigMembers,
    memberDoc,
    memberType,
    typeToString,
    isBoolString,
} from "@src/.metadata.generated"
import * as urlUtil from "@src/lib/url_util"
import { getLocation } from "@src/commandline_frame"

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
        this.trailingSpace = true
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

        let contentLocation = await getLocation()
        let url
        if (prefix.endsWith("url")) {
            contentLocation = await getLocation()
            url = urlUtil.symbolsToHref(query.split(" ")[0], contentLocation)
        } else {
            url = contentLocation
        }

        if (prefix.endsWith("url") && !query.includes(" ")) {
            this.options = Object.keys(config.get("subconfigs"))
                .filter(pattern => pattern.startsWith(url))
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

            if (url !== query && !this.options.find(({ value }) => value === url)) {
                this.options = [
                    new SettingsCompletionOption(url, {
                            name: url,
                            value: "",
                            type: "URL Pattern",
                            doc: "",
                        })
                    ].concat(this.options)
            }
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

        let settings
        if (url) {
            // Display completions relative to the content location (not the iframe's href)
            settings = config.getWithURL(url)
        } else {
            settings = config.get()
        }

        if (settings === undefined) {
            return
        }

        const isSetCmd = prefix.startsWith("set")

        const vimSugarPrefix = isSetCmd ? ["no", "inv"].find(boolPrefix => query.startsWith(boolPrefix)) : undefined
        const doubleSugarPrefix = vimSugarPrefix && query.startsWith(vimSugarPrefix + vimSugarPrefix)

        const deepQuery = query.split(/[\. ]/)
        if (deepQuery.length > 1 && vimSugarPrefix && !settings.hasOwnProperty(deepQuery[0]))
            deepQuery[0] = deepQuery[0].slice(vimSugarPrefix.length)

        query = deepQuery.pop().toLowerCase()

        let target = settings
        for (const key of deepQuery) {
            const next = target[key]
            if (typeof next === "object" && !Array.isArray(next))
                target = next
            else {
                target = {}
                break
            }
        }

        const deepKeys = deepQuery.length ? deepQuery.join(".") + "." : ""
        const vimSugarPostfix = ["!"].find(boolPostfix => query.endsWith(boolPostfix))

        let matches
        if (vimSugarPrefix && deepQuery.length === 0) {
            const slicedQuery = query.slice(vimSugarPrefix.length)
            matches = Object.keys(target)
                .filter(x => x.toLowerCase().startsWith(query) || (
                    isBoolString(defaultConfigMembers[x]?.type) &&
                    x.toLowerCase().startsWith(slicedQuery)
                ))
            if (matches.length === 0) {
                matches = Object.keys(target).filter(x => x.toLowerCase().startsWith(slicedQuery) || x.toLowerCase().startsWith(query))
            }
        } else if (vimSugarPostfix) {
            const slicedQuery = query.slice(0, -vimSugarPostfix.length)
            matches = Object.keys(target)
                .filter(x => (
                        isBoolString(defaultConfigMembers[x]?.type) &&
                        x.toLowerCase().startsWith(slicedQuery)
                    ) || (x.toLowerCase().startsWith(query)))
        } else {
            matches = Object.keys(target)
               .filter(x => x.toLowerCase().startsWith(query))
        }

        if (matches.length === 0) {
            if (query !== "") {
                matches = Object.keys(target).filter(x => x.toLowerCase().includes(query))
            } else if (deepQuery.length && isSetCmd) {
                query = deepQuery.pop()
                target = settings
                for (const key of deepQuery) {
                    const next = target[key]
                    if (typeof next === "object" && !Array.isArray(next))
                        target = next
                    else {
                        target = {}
                        break
                    }
                }

                const exactMatch = target?.[query]

                if (exactMatch !== undefined) {
                    const completionValue = options + (deepQuery.length ? deepQuery.join(".") + "." : "") + query +
                        (typeof exactMatch === "object"
                            ? Array.isArray(exactMatch) ? " " + JSON.stringify(exactMatch) : ""
                            : " " + exactMatch)

                    const md = defaultConfigMembers[deepKeys[0] || query]
                    this.options = [
                        new SettingsCompletionOption(completionValue, {
                            name: "",
                            value: JSON.stringify(exactMatch),
                            doc: memberDoc(md),
                            type: md ? typeToString(memberType(md)) : ""
                        })
                    ]
                    this.trailingSpace = false
                    return this.updateChain()
                }
            }
        }

        this.options = matches
            .sort()
            .map((setting) => {
                let completionPrefix = vimSugarPrefix || ""
                // Silly edge cases like
                // :set nonoiframe
                // Where we want the completion to add a no sometimes but not always
                // :set nono => :set nonoiframe
                // :set no => :set noiframe
                if (vimSugarPrefix && !doubleSugarPrefix && setting.startsWith(vimSugarPrefix))
                    completionPrefix = ""

                // const md = defaultConfigMembers[setting]
                const md = defaultConfigMembers[deepKeys[0] || setting]
                return new SettingsCompletionOption(options + completionPrefix + deepKeys + setting + (vimSugarPostfix || ""), {
                    name: setting,
                    value: JSON.stringify(target[setting]),
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
