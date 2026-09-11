/** # Binding Functions
 *
 */

import { canonicaliseMapstr } from "@src/lib/keyseq"
import { ExCommand, joinExCommand } from "@src/lib/excmd"
import * as config from "@src/lib/config"

const _mode2maps = new Map([
    ["normal", "nmaps"],
    ["ignore", "ignoremaps"],
    ["insert", "imaps"],
    ["input", "inputmaps"],
    ["ex", "exmaps"],
    ["hint", "hintmaps"],
    ["visual", "vmaps"],
    ["browser", "browsermaps"],
])

export const defaultModes = Array.from(_mode2maps.keys())
export const defaultModeMaps = Array.from(_mode2maps.values())

const _maps2mode = new Map(
    Array.from(_mode2maps.keys()).map(k => [_mode2maps.get(k), k]),
)

const modes = Array.from(_mode2maps.keys())
const modeMaps = Array.from(_maps2mode.keys())

export function getModes() {
    updateModesWithUserConfig()
    return modes
}

export function getModeMaps() {
    updateModesWithUserConfig()
    return modeMaps
}

export const mode2maps = {
    get: key => {
        updateModesWithUserConfig()
        return _mode2maps.get(key)
    },
    has: key => {
        updateModesWithUserConfig()
        return _mode2maps.has(key)
    },
}

export const maps2mode = {
    get: (key) => {
        updateModesWithUserConfig()
        return _maps2mode.get(key)
    },
    has: (key) => {
        updateModesWithUserConfig()
        return _maps2mode.has(key)
    },
}

let userModesOutdated = true

export function updateModesWithUserConfig() {
    if (!userModesOutdated) return
    userModesOutdated = false
    const conf = config.get()
    const newMaps = Object.keys(conf)
        .filter(key => key.endsWith("maps") && !_maps2mode.has(key) && typeof conf[key] === "object")

    const deletedMaps = modeMaps.filter(key => !conf[key])

    newMaps.forEach(modeMap => {
        const modeName = modeMap.slice(0, -4)
        _mode2maps.set(modeName, modeMap)
        _maps2mode.set(modeMap, modeName)
        modes.push(modeName)
        modeMaps.push(modeMap)
    })

    deletedMaps.forEach(modeMap => {
        const modeName = modeMap.slice(0, -4)
        _mode2maps.delete(modeName)
        _maps2mode.delete(modeMap)
        modes.splice(modes.indexOf(modeName), 1)
        modeMaps.splice(modeMaps.indexOf(modeMap), 1)
    })
}

browser.storage.onChanged.addListener(changes => {
    if ("userconfig" in changes)
        userModesOutdated = true
})

interface bind_args {
    mode: string
    configName: string
    key: string
    excmd: ExCommand
    isRecursive: boolean
}

export function parse_bind_args(...args: ExCommand[]): bind_args {
    if (args.length === 0) throw new Error("Invalid bind/unbind arguments.")
    updateModesWithUserConfig()

    const result = {} as bind_args
    result.mode = "normal"

    const flags: string[] = []; // --mode and --recursive
    while (typeof args[0] === "string" && args[0].startsWith("--")) {
        flags.push(args.shift() as string);
    }

    for (const flag of flags) {
        if (flag.startsWith("--mode")) {
            result.mode = flag.replace("--mode=", "");
        } else if (flag == "--recursive") {
            result.isRecursive = true;
        } else {
            throw new Error("Invalid bind/unbind arguments.");
        }
    }

    if (!_mode2maps.has(result.mode)) {
        result.configName = result.mode + "maps"
    } else {
        result.configName = _mode2maps.get(result.mode)
    }

    const key = args.shift()
    if (typeof key !== "string") throw new Error("Invalid bind key.")
    // Convert key to internal representation
    result.key = canonicaliseMapstr(key)

    result.excmd = joinExCommand(args)

    return result
}
