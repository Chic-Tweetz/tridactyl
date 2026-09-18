# Paris changelog

# Release 2026-09-18

- WIP, should go back and remember what I've done

- New features

    - This changelog!
    - `:hint -Q` "rehint" rapid hinting - refreshes/gets new elements per hint
    - `:hint -Qd [delay]` "rehint" rapid hinting with a delay in ms
    - `:hint -/` searches for hint text
    - `:hint -j` include JS hints when `hintselectorsincludejs` is false
    - `:hint -jj` invert `hintselectorsincludejs` setting
    - `:hint -n` override `hintnames` setting
    - `:hint -chars [chars]` override `hintchars` setting
    - `:hint -m [mode]` override `hintfiltermode` setting
    - `:hint hud` hint only elements in Tridactyl's HUD
    - `:hint +hud` include elements in Tridactyl's HUD when hinting
    - better `:set` and related completions
    - set booleans with VIM-like syntax, including "no" & "inv" prefixes and "!" postfix.
    - `:set abool` = `:set abool true`
    - `:set noabool` = `:set abool false`
    - `:set nodeep.nested.bool` = `:set deep.nested.bool false`
    - `config.getWithURL` can be supplied any URL to get a config setting from
    - `config.getURLWithSources` can be used to find which subconfig URL a setting is from. This is used to display subconfig URLs in whichkey
    - `:find [--private]` flag stops searches being added to command history
    - `:setpush` and `:setpop` helpers for working with array config settings
    - `:js [-rbc]` or `[-sbc]` flags for background caching (and content caching with `-s`, `:js [-sc]`)

- Bug fixes

    - instances where hinting, scrolling or DOM's "hintworthy JS elems" threw errors due to dead elements fixed by wrapping elements in `weakRef`s
    - hint tag "deOverlapping" speed up
    - `:unset` and `:reset` should always work

- Miscellaneous

    - updates to key trie parsing and whichkey to pass old keyseq tests
    - repeat key events from held keys won't break key sequences
    - tokyonight theme now shows headers, putting them below completions
    
# Release 2026-08-28

- New features

    - Merged exversion_2 branch
    - UI elements all live in a HUD, an iframe or a div inside a shadow DOM
    `:set hudnoiframe` to not use an iframe. See hud.ts. Module is also in `tri.hud`
    - `:tab` with no args switches to the last tab in the current window
    - `:taball` with no args switches to the previous window or the previous tab in the current window failing that

- Miscellaneous

    - hide offscreen hints rather than cluttering the screen
