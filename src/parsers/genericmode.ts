/** Tridactyl helper mode */

import * as keyseq from "@src/lib/keyseq"

export function parser(
    conf,
    keys: keyseq.MinimalKey[],
    useNumericPrefixes = true,
): keyseq.ParserResponse {
    return keyseq.parse(keys, keyseq.keyTrie(conf), useNumericPrefixes)
}
