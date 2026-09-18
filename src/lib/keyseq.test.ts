import { testAll, testAllObject } from "@src/lib/test_utils"
import * as ks from "@src/lib/keyseq"
import { mapstrToKeyseq as mks } from "@src/lib/keyseq"

function mk(k, mod?: ks.KeyModifiers) {
    return new ks.MinimalKey(k, mod)
}

function mtk(k, mod?: ks.KeyModifiers) {
    return new ks.TrieKey(k, mod)
}

test("isTrustedKeyboardEvent rejects spoofed objects", () => {
    expect(
        ks.isTrustedKeyboardEvent({
            isTrusted: true,
            view: { KeyboardEvent: { [Symbol.hasInstance]: () => true } },
        }),
    ).toBe(false)
    expect(
        ks.isTrustedKeyboardEvent(
            new Proxy({}, { get: () => { throw new Error() } }),
        ),
    ).toBe(false)
})

{
    // {{{ parse and completions

    const keymap = new Map([
        [mks("<C-u>j"), "scrollline 10"],
        [mks("gg"), "scrolltop"],
        [mks("<SA-Escape>"), "rarelyusedcommand"],
        // Test shiftKey ignoring
        [mks(":"), "fillcmdline"],
        // [mks("Av"), "whatever"],
        [mks("<D-A><U-A>v"), "whatever"], // This is more inline with how tridactyl would treat :bind Av
        [mks("i<c-j>"), "testmods"],
        [mks("0"), "panleft"],
    ])

    // Keymap for negative tests
    const keymap2 = new Map([
        [mks("gg"), "scrolltop"],
        [mks("gof"), "foo"],
        [mks("o"), "bar"],
        [mks("<c-6>"), "tablast"],
        [mks("<c-5><c-5>"), "tablast"],
    ])
    const backslashKeymap = new Map([
        [mks("\\"), "fillcmdline bare"],
        [mks("<C-\\>"), "fillcmdline control"],
    ])

    // const keytrie = ks.keyMapToKeyTrie(keymap)
    // const keytrie2 = ks.keyMapToKeyTrie(keymap2)
    // const backslashKeytrie = ks.keyMapToKeyTrie(backslashKeymap)

    // This one actually found a bug once!
    testAllObject(ks.parseMapAsTrie, [
        [[[mk("g")], keymap], { keys: [mk("g")], isMatch: true }],
        [[[mk("g"), mk("g")], keymap], { value: "scrolltop", isMatch: true }],
        [
            [[mk("Escape", { shiftKey: true, altKey: true })], keymap],
            { value: "rarelyusedcommand", isMatch: true },
        ],
        [
            [[mk(":", { shiftKey: true })], keymap],

            { value: "fillcmdline", isMatch: true },
            ,
        ],
        [
            [
                [
                    mk("A", { shiftKey: true }),
                    // // KeyTrie parsing only ignores real keyups; :bind A is not the same as :bind <D-A><U-A>
                    mk("A", { shiftKey: true, keyup: true }),
                    mk("v"),
                ],
                keymap,
            ],
            { value: "whatever", isMatch: true },
        ],
        // Test bare modifiers
        [
            [mks("i<Control><c-j>"), keymap],
            { value: "testmods", isMatch: true },
        ],
        [
            [mks("i<C-Control><c-j>"), keymap],
            { value: "testmods", isMatch: true },
        ],

        // Test count behaviour
        // Zero isn't a prefix.
        [[mks("0g"), keymap2], { keys: mks("g"), isMatch: true }],
        [
            [mks("0gg"), keymap2],
            {
                value: "scrolltop",
                exstr: "scrolltop",
                isMatch: true,
                numericPrefix: undefined,
            },
        ],
        // If zero is a map, then it should still work
        [
            [mks("0"), keymap],
            {
                value: "panleft",
                exstr: "panleft",
                isMatch: true,
                numericPrefix: undefined,
            },
        ],

        // Do match numbers starting with a non-zero
        [
            [mks("2gg"), keymap2],
            {
                value: "scrolltop",
                exstr: "scrolltop 2",
                isMatch: true,
                numericPrefix: 2,
            },
        ],
        [
            [mks("20gg"), keymap2],
            {
                value: "scrolltop",
                exstr: "scrolltop 20",
                isMatch: true,
                numericPrefix: 20,
            },
        ],
        // If zero is a map, then you can still use zero in counts.
        // [[mks("20gg"), keymap], { value: "scrolltop", exstr: "scrolltop 20", isMatch: true, numericPrefix: 20 }],
        // This test ^ fails but it works in the browser. Probably worth debugging more.

        // Don't match function keys as counts.
        [
            [mks("<F2>gg"), keymap2],
            { value: "scrolltop", exstr: "scrolltop", isMatch: true },
        ],
        [
            [mks("<C-6>"), keymap2],
            { value: "tablast", exstr: "tablast", isMatch: true },
        ],
        [
            [mks("<C-5><C-5>"), keymap2],
            { value: "tablast", exstr: "tablast", isMatch: true },
        ],

        // Test prefix problems
        [[mks("g"), keymap2], { keys: mks("g"), isMatch: true }],
        [[mks("go"), keymap2], { keys: mks("go"), isMatch: true }],
        [[mks("gog"), keymap2], { keys: mks("g"), isMatch: true }],
        [[mks("gor"), keymap2], { keys: [], isMatch: false }],
        // If you somehow go beyond a valid keymap (keymap is changed in
        // between keypresses or something) then clear the key list.
        // keyup events must not match single-key bindings
        [[[mk("o", { keyup: true })], keymap2], { keys: [], isMatch: false }],
        // But keydown (plain) events should match
        [[[mk("o")], keymap2], { value: "bar", isMatch: true }],
        [[mks("goff"), keymap2], { keys: [], isMatch: false }],
        [[mks("xxxxx"), keymap2], { keys: [], isMatch: false }],

        // Space key should be bindable via <Space>
        [
            [[mk(" ")], new Map([[mks("<Space>"), "spacetest"]])],
            { value: "spacetest", isMatch: true },
        ],
        [
            [
                [mk(" ", { shiftKey: true })],
                new Map([
                    [mks("<Space>"), "plain"],
                    [mks("<S-Space>"), "shift"],
                ]),
            ],
            { value: "shift", isMatch: true },
        ],

        // A bare key binding must not match events with extra modifiers.
        [
            [[mk("\\", { ctrlKey: true })], backslashKeymap],
            { value: "fillcmdline control", isMatch: true },
        ],
        [
            [[mk("\\")], backslashKeymap],
            { value: "fillcmdline bare", isMatch: true },
        ],
    ])

    testAllObject(ks.completionsForKeyMap, [
        [[[mk("g")], keymap], new Map([[mks("gg"), "scrolltop"]])],
        [[mks("<C-u>j"), keymap], new Map([[mks("<C-u>j"), "scrollline 10"]])],
        // -ve tests
        [[mks("x"), keymap], new Map()],
        [[mks("ggg"), keymap], new Map()],
        // Space key completions
        [
            [[mk(" ")], new Map([[mks("<Space>"), "spacetest"]])],
            new Map([[mks("<Space>"), "spacetest"]]),
        ],
    ])

    test("numeric prefixes can be disabled", () => {
        const map = new Map([[mks("qa"), "command"]])
        const response = ks.parseMapAsTrie([mk("2")], map, false)
        expect(response).toMatchObject({ keys: [], isMatch: false })
        expect(ks.parseMapAsTrie(mks("2qa"), map, false).exstr).toBe("command")
        const numericMap = new Map([[mks("2qa"), "numeric"]])
        expect(ks.parseMapAsTrie(mks("2qa"), numericMap, false).exstr).toBe("numeric")
    })

    // // KeyTries do not work this way
    // // Deliberately feeding keyups will assume you're doing it on purpose
    // // Real key events will be treated differently, where a matched keydown will (usually) cause a keyup to be ignored
    // // Handled in controller_content on the keyevents themselves, not in the parser
    // test("late keyups preserve compatible mappings", () => {
    //     const rollover = [mk("g"), mk("o"), mk("g", { keyup: true })]
    //     const ordinary = new Map([[mks("got"), "open"]])
    //     const pending = ks.parseMapAsTrie(rollover, ordinary)
    //     expect(pending.keys).toEqual([rollover[0], rollover[2], rollover[1]])
    //     expect(ks.parseMapAsTrie([...pending.keys, mk("t")], ordinary).value).toBe(
    //         "open",
    //     )
    //     expect(
    //         ks.parseMapAsTrie(rollover, new Map([[mks("<D-g>ot"), "down"]])).isMatch,
    //     ).toBe(false)

    //     const withKeyup = new Map([
    //         [mks("got"), "open"],
    //         [mks("<U-g>"), "up"],
    //     ] as [ks.MinimalKey[], string][])
    //     expect(ks.parseMapAsTrie(rollover, withKeyup).value).toBe("up")
    //     const counted = ks.parseMapAsTrie([mk("2"), ...rollover], ordinary)
    //     expect(ks.parseMapAsTrie([...counted.keys, mk("t")], ordinary).exstr).toBe(
    //         "open 2",
    //     )
    //     const repeated = [mk("g", { repeat: true }), rollover[1], rollover[2]]
    //     expect(ks.parseMapAsTrie(repeated, ordinary).isMatch).toBe(false)
    // })

    test("repeats do not abandon a compatible prefix", () => {
        const prefix = [mk("g"), mk("o")]
        const repeated = [...prefix, mk("o", { repeat: true })]
        const maps = new Map([
            [mks("got"), "quickmark"],
            [mks("o"), "open"],
            [mks("<C-o>"), "modified"],
        ])
        const parse = (keys: ks.MinimalKey[]) => ks.parseMapAsTrie(keys, maps)
        const pending = parse(repeated)
        expect(pending.keys).toEqual(prefix)
        expect(parse([...pending.keys, mk("t")]).value).toBe("quickmark")
        expect(parse([mk("o", { repeat: true })]).value).toBe("open")
        expect(ks.parseMapAsTrie(repeated, new Map([[mks("goo"), "goo"]])).value).toBe(
            "goo",
        )
        expect(
            parse([...prefix, mk("o", { ctrlKey: true, repeat: true })]).value,
        ).toBe("modified")
        // // KeyTries - I've made keydown nodes point to themselves with repeats by default
        // // But a repeat from an earlier key will still break a sequence
        // // at least on mac only the most recently pressed key gets repeats anyway
        // const counted = parse([mk("2"), ...prefix, mk("2", { repeat: true })])
        // expect(parse([...counted.keys, mk("t")]).exstr).toBe("quickmark 2")
    })

    test("preserves versioned block bindings", () => {
        const program = { source: "echo block", exversion: 2 as const }
        const map = new Map([[mks("x"), program]])
            expect(ks.parseMapAsTrie(mks("x"), map)).toEqual({
                value: program,
                exstr: program,
                isMatch: true,
                numericPrefix: undefined,
                // // KeyTries: I return matched keys and controller_content decides whether to reset
                // keys: [],
                keys: [mtk("x")],
                didReset: false,
                actions: ["ignoreKeyupContextual"], // this is basically default so i might rewrite as such one day
            })
        expect(() => ks.parseMapAsTrie(mks("2x"), map)).toThrow("Counts")
    })
} // }}}

// {{{ mapstr ->  keysequence

testAll(ks.bracketexprToKey, [
    ["<C-a><CR>", [mtk("a", { ctrlKey: true }), "<CR>"]],
    ["<M-<>", [mtk("<", { metaKey: true }), ""]],
    ["<M-<>Foo", [mtk("<", { metaKey: true }), "Foo"]],
    ["<M-a>b", [mtk("a", { metaKey: true }), "b"]],
    ["<S-Escape>b", [mtk("Escape", { shiftKey: true }), "b"]],
    ["<Tab>b", [mtk("Tab"), "b"]],
    ["<Space>b", [mtk(" "), "b"]],
    ["<>b", [mtk("<"), ">b"]],
    ["<tag >", [mtk("<"), "tag >"]],
])

testAllObject(ks.mapstrMapToKeyMap, [
    [
        new Map([
            ["j", "scrollline 10"],
            ["gg", "scrolltop"],
        ]),
        new Map([
            [[mk("j")], "scrollline 10"],
            [
                // [mk("g"), mk("g", { keyup: true, optional: true }), mk("g")],
                [mtk("g"), mtk("g")],
                "scrolltop",
            ],
        ]),
    ],
    [
        new Map([
            ["<C-u>j", "scrollline 10"],
            ["gg", "scrolltop"],
        ]),
        new Map([
            [
                [
                    mk("u", { ctrlKey: true }),
                    // mk("u", { ctrlKey: true, keyup: true, optional: true }),
                    mk("j"),
                ],
                "scrollline 10",
            ],
            [
                // [mk("g"), mk("g", { keyup: true, optional: true }), mk("g")],
                [mtk("g"), mtk("g")],
                "scrolltop",
            ],
        ]),
    ],
])

function qk(key: string, modifiers: string[] = []) {
    const k = {
        key,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        keyup: false,
        keydown: false,
        // could use a class to separate bind-only properties and keyevent-only properties
        optional: false, // bind-only
        code: undefined, // keyevent-only
        noCancel: false, // bind-only
        noReset: false, // bind-only
        translated: false, // bind-only
    }
    for (const modifier of modifiers) {
        (k as any)[modifier] = true
    }
    return k
}

function qks(keys: string[]) {
    return keys.map(key => qk(key))
}

testAllObject(ks.mapstrToKeyseq, [
    [
        "Some string",
        qks([..."Some string"]),
    ],
    [
        "hi<c-u>t<A-Enter>here",
        [qk("h"), qk("i"), qk("u", ["ctrlKey"]), qk("t"), qk("Enter", ["altKey"])].concat(qks([..."here"])),
    ],
    [
        "wat's up <s-Escape>",
        qks([..."wat's up "]).concat(qk("Escape", ["shiftKey"])),
    ],
    ["wat's up <s-Escape>", mks("wat's up <s-Escape>")],

    // <Space> should produce a minimal key with key=" "
    ["<Space>", [mk(" ")]],
])

// Check order of modifiers doesn't matter
// Check aliases
testAllObject(mks, [
    ["<SAC-cr>", mks("<ASC-return>")],
    ["<ACM-lt>", mks("<CAM-<>")],
])

testAll(ks.mapstrMatchesKey, [
    [["/", mtk("/")], true],
    [["<C-,>", mtk(",", { ctrlKey: true })], true],
    [["<C-,>", mtk(",")], false],
    [["gg", mtk("g")], false],
])

// {{{ canonicaliseMapstr

testAll(ks.canonicaliseMapstr, [
    // Explicit direction modifiers must be preserved
    ["<D-j>", "<D-j>"],
    ["<U-j>", "<U-j>"],
    // Regular keys stay the same
    ["j", "j"],
    ["<C-a>", "<C-a>"],
])

// // Not really necessary to have a .hasExplicitDirection property in KeyTries so this is gone
// testAll((k: string) => ks.parseMapstr(k).hasExplicitDirection, [
//     ["<DC-4>", true],
//     ["<UC-4>", true],
//     ["gg", false],
// ])

testAll(ks.findShadowingMapstr, [
    [["gg", ["g"]], "g"],
    [["g", ["gg"]], undefined],
    [["v", ["v"]], undefined],
    [["<C-v>", ["v"]], undefined],
    [["<D-v>", ["v"]], "v"],
])

// testAll(ks.formatKeysForModeIndicator, [
//     [[[mk("g"), mk("g", { keyup: true })], ["gg"]], "g"],
//     [[[mk("v")], ["<D-v>j"]], "<D-v>"],
//     [[[mk("v", { ctrlKey: true })], ["<CD-v>j"]], "<CD-v>"],
//     [[[mk("v", { keyup: true })], ["<U-v>j"]], "<U-v>"],
//     [
//         [[mk("v"), mk("v", { keyup: true })], ["v<U-v>j"]],
//         "<D-v><U-v>",
//     ],
// ])

// }}}
