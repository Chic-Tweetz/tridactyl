/** Tridactyl helper mode */

import * as keyseq from "@src/lib/keyseq"

export function parser(
    conf,
    keys: keyseq.MinimalKey[],
    useNumericPrefixes = true,
): keyseq.ParserResponse {
    const maps = keyseq.keyMap(conf)
    return keyseq.parse(keys, maps, useNumericPrefixes)
}
