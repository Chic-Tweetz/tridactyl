import * as Completions from "@src/completions"
import * as Native from "@src/lib/native"

class FileSystemCompletionOption
    extends Completions.CompletionOptionHTML
    implements Completions.CompletionOptionFuse {
    public fuseKeys = []

    constructor(public value: string, display?: string) {
        super()
        this.fuseKeys = [value]
        this.html = html`<tr class="FileSystemCompletionOption option">
            <td class="value">${display || value}</td>
        </tr>`
    }
}

export class FileSystemCompletionSource extends Completions.CompletionSourceFuse {
    public options: FileSystemCompletionOption[]

    constructor(private _parent) {
        super(
            ["saveas", "source", "js -s", "js -sc", "js -sbc", "jsb -s", "jsb -sc", "js -r", "js -rc", "js -rbc", "jsb -r", "jsb -rc"],
            "FileSystemCompletionSource",
            "FileSystem",
        )

        this._parent.appendChild(this.node)
    }

    public async onInput(exstr) {
        return this.filter(exstr)
    }

    public async filter(exstr: string) {
        if (!exstr || exstr.indexOf(" ") === -1) {
            this.state = "hidden"
            return
        }

        let [cmd, path] = this.splitOnPrefix(exstr)
        if (
            cmd === undefined ||
            (cmd === "source" && /^--url(?:\s|$)/.test(path))
        ) {
            this.state = "hidden"
            return
        }

        let pathPrefix = ""
        const fromRC = cmd.startsWith("js") && cmd.includes("-r") && !path.startsWith("/") && !path.startsWith("~")
        if (fromRC) {
            const sep = "/"
            const rcPath = (await Native.getrcpath("unix")).split(sep).slice(0, -1)
            pathPrefix = [...rcPath].join(sep) + sep
            path = [...rcPath, path].join(sep)
        }

        if (!path) path = "."

        if (!["/", "$", "~", "."].find(s => path.startsWith(s))) {
            // If the path doesn't start with a special character, it is relative to the native messenger, thus use "." as starting point
            // Does this work on windows?
            path = "./" + path
        }

        // Update lastExstr because we modified the path and scoreOptions uses that in order to assign scores
        this.lastExstr = [cmd, path.slice(pathPrefix.length)].join(" ")

        let req
        try {
            req = await Native.listDir(path)
        } catch (e) {
            // Failing silently because we can't nativegate (the user is typing stuff in the commandline)
            this.state = "hidden"
            return
        }

        if (req.isDir) {
            if (!path.endsWith(req.sep)) path += req.sep
        } else {
            path = path.substring(0, path.lastIndexOf("/") + 1)
        }

        if (fromRC) {
            this.options = req.files.map(
                p => new FileSystemCompletionOption((path.slice(pathPrefix.length) + p), path + p),
            )
        } else {
            this.options = req.files.map(
                p => new FileSystemCompletionOption(path + p),
            )
        }

        this.state = "normal"
        return this.updateChain()
    }
}
