import { staticThemes } from "@src/.metadata.generated"
import * as config from "@src/lib/config"
import * as Logging from "@src/lib/logging"
import { browserBg, ownTabId, ownTabContainer } from "@src/lib/webext"

const logger = new Logging.Logger("styling")

const isMozExtension = window.location.protocol === "moz-extension:"

export const THEMES = staticThemes

function capitalise(str) {
    if (str === "") return str
    return str[0].toUpperCase() + str.slice(1)
}

function prefixTheme(name) {
    return "TridactylTheme" + capitalise(name)
}

// At the moment elements are only ever `:root` and so this array and stuff is all a bit overdesigned.
const THEMED_ELEMENTS = []

let insertedHintElemCSS = false
const hintElemCss = {
    allFrames: true,
    matchAboutBlank: true,
    code: "",
}

let insertedCSS = false
const customCss = {
    allFrames: true,
    matchAboutBlank: true,
    code: "",
}

export function hintElemStyles() {
    return hintElemCss.code
}

let insertedContainerCss = false
// Attempting to share stylesheets with shadow DOMs
// unfortunately, adoptedStyleSheets is often blocked anyway
let lastCombinedText = null
let lastSheet = null
export function getThemedStylesheet() {
    if (lastSheet) return lastSheet
    const styleSheet = new CSSStyleSheet()
    // what do you need to style everything in one go?
    const cssText = getThemedCssText()

    ;(styleSheet as any).replaceSync(cssText)
    lastSheet = styleSheet
    return styleSheet
}

// This won't work in shadows (which is what i wanted it for) unless you recursively unwrap imports
// that is possible (there's a CSS parsing library imported somewhere already), but not worth it!
// just getComputedStyle for whatever you're wanting to share with the shadow methinks
export function getThemedCssText() {
    if (lastCombinedText) return lastCombinedText
    // what do you need to style everything in one go?
    const defaultCss = `@import url('${browser.runtime.getURL("static/themes/auto/auto.css")}');\n`
    const hintCss = `@import url('${browser.runtime.getURL("static/css/hint.css")}');\n`
    const contentCss = `@import url('${browser.runtime.getURL("static/css/content.css")}');\n`
    const cssText = defaultCss + hintCss + contentCss + customCss.code + "\n" + hintElemCss.code
    lastCombinedText = cssText
    return cssText
}

export async function theme(element) {
    lastCombinedText = null
    lastSheet = null
    // Remove any old theme

    /**
     * DEPRECATED
     *
     * You don't need to add weird classnames to your themes any more, but you can if you want.
     *
     * Retained for backwards compatibility.
     **/
    for (const theme of THEMES.map(prefixTheme)) {
        element.classList.remove(theme)
    }
    // DEPRECATION ENDS

    // Insert hint CSS rules according to config - copying how themes are inserted
    if (isMozExtension) {
        const oldHintStyle = document.getElementById("tridactyl-hint-style")
        if (oldHintStyle) oldHintStyle.remove()
    } else if (insertedHintElemCSS) {
        await browserBg.tabs.removeCSS(await ownTabId(), hintElemCss)
        insertedHintElemCSS = false
    }

    const hintElemOptions = await config.getAsync("hintstyles")

    // This is getting out of hand now because I want to be able to change fg if using overlays vs bg :)
    const hintFgVar = hintElemOptions.overlay === "all" ? "--tridactyl-hint-highlight-fg" : "--tridactyl-hint-fg"
    const activeFgVar = hintElemOptions.overlay !== "none" ? "--tridactyl-hint-highlight-active-fg" : "--tridactyl-hint-active-fg"

    const largeHintElemBgRules =
        (hintElemOptions.bg === "all"
            ? ":root.TridactylHintElem,body.TridactylHintElem {\n    background: var(--tridactyl-large-hint-bg) !important;\n}\n"
            : "")

    const largeActiveElemBgRules =
        (hintElemOptions.bg !== "none"
            ? ":root.TridactylHintActive,body.TridactylHintActive {\n    background: var(--tridactyl-large-hint-active-bg) !important;\n}\n"
            : "")

    const hintElemRules =
        (hintElemOptions.fg === "all"
            ? `    -webkit-text-fill-color: var(${hintFgVar}) !important;\n`
            : "") +
        (hintElemOptions.bg === "all"
            ? "    background: var(--tridactyl-hint-bg) !important;\n"
            : "") +
        (hintElemOptions.outline === "all"
            ? "    outline: var(--tridactyl-hint-outline) !important;\n"
            : "")

    const activeElemRules =
        (hintElemOptions.fg !== "none"
            ? `    -webkit-text-fill-color: var(${activeFgVar}) !important;\n`
            : "") +
        (hintElemOptions.bg !== "none"
            ? "    background: var(--tridactyl-hint-active-bg) !important;\n"
            : "") +
        (hintElemOptions.outline !== "none"
            ? "    outline: var(--tridactyl-hint-active-outline) !important;\n"
            : "")

    // If these are set to "none" they won't be added to the page at all so only need to handle active
    const activeOverlayRules =
        (hintElemOptions.overlay === "active"
            ? ".TridactylHintHighlight { display:none; } .TridactylHintHighlightActive { display: block !important; }"
            : "") +
        (hintElemOptions.overlayoutline === "active"
            ? ".TridactylHintOutline { display:none; } .TridactylHintOutlineActive { display: block !important; }"
            : "")

    hintElemCss.code =
        (hintElemRules !== ""
            ? ".TridactylHintElem {\n" + hintElemRules + "}\n"
            : "") +
        (activeElemRules !== ""
            ? ".TridactylHintActive {\n" + activeElemRules + "}\n"
            : "") +
            largeHintElemBgRules +
            largeActiveElemBgRules +
            activeOverlayRules

    if (isMozExtension) {
        if (hintElemCss.code !== "") {
            const style = document.createElement("style")
            style.id = "tridactyl-hint-style"
            style.textContent = hintElemCss.code
            document.head.appendChild(style)
        }
    } else if (hintElemCss.code !== "") {
        await browserBg.tabs.insertCSS(await ownTabId(), hintElemCss)
        insertedHintElemCSS = true
    }

    if (isMozExtension) {
        const oldThemeStyle = document.getElementById("tridactyl-theme-style")
        if (oldThemeStyle) oldThemeStyle.remove()
    } else if (insertedCSS) {
        // Typescript doesn't seem to be aware than remove/insertCSS's tabid
        // argument is optional
        await browserBg.tabs.removeCSS(await ownTabId(false), customCss)
        insertedCSS = false
    }

    const newTheme = await config.getAsync("theme")

    /**
     * DEPRECATED
     *
     * You don't need to add weird classnames to your themes any more, but you can if you want.
     *
     * Retained for backwards compatibility.
     **/
    if (newTheme !== "default") {
        element.classList.add(prefixTheme(newTheme))
    }
    // DEPRECATION ENDS

    // Insert custom css if needed
    if (newTheme !== "default") {
        customCss.code = THEMES.includes(newTheme)
            ? "@import url('" +
              browser.runtime.getURL(
                  "static/themes/" + newTheme + "/" + newTheme + ".css",
              ) +
              "');"
            : await config.getAsync("customthemes", newTheme)
        if (customCss.code) {
            if (isMozExtension) {
                const style = document.createElement("style")
                style.id = "tridactyl-theme-style"
                style.textContent = customCss.code
                document.head.appendChild(style)
            } else {
                await browserBg.tabs.insertCSS(await ownTabId(), customCss)
                insertedCSS = true
            }
        } else {
            logger.error("Theme " + newTheme + " couldn't be found.")
        }
    }

    // Record for re-theming
    // considering only elements :root (page and cmdline_iframe)
    // TODO:
    //     - Find ways to check if element is already pushed
    if (
        THEMED_ELEMENTS.length < 2 &&
        element.tagName.toUpperCase() === "HTML"
    ) {
        THEMED_ELEMENTS.push(element)
    }

    // Add/overwrite a --tridactyl-container-color var that can be used for the status indicator (or whatever else)
    // As usual, slightly more complicated than anticipated!
    if (!insertedContainerCss) {
        const containerIndicator = await config.getAsync("containerindicator")
        let color
        let icon
        if (containerIndicator !== "true") {
            color = "lightgray"
            icon = ""
        } else if (browser.extension.inIncognitoContext) {
            color = "#7514CF"
            icon = "var(--tridactyl-private-window-icon-url)"
        } else {
            await ownTabContainer()
                .then(ownTab =>
                    browserBg.contextualIdentities.get(ownTab.cookieStoreId),
                )
                .then(container => {
                    color = (container as any).colorCode
                    icon = (container as any).iconUrl
                })
                .catch(_error => {
                    color = "lightgray"
                    icon = ""
                })
        }
        const rule = `:root { --tridactyl-container-color: ${color}; --tridactyl-container-icon-url: url("${icon}"); }`
        await browserBg.tabs.insertCSS(await ownTabId(), {
            allFrames: true,
            matchAboutBlank: true,
            code: rule,
        })
        insertedContainerCss = true
    }
}

function retheme() {
    THEMED_ELEMENTS.forEach(element => {
        theme(element).catch(e => {
            logger.warning(
                `Failed to retheme element "${element}". Error: ${e}`,
            )
        })
    })
}

config.addChangeListener("theme", retheme)
config.addChangeListener("hintstyles", retheme)

/**
 * DEPRECATED
 *
 * You don't need to add weird classnames to your themes any more, but you can if you want.
 *
 * Retained for backwards compatibility.
 **/
// Sometimes pages will overwrite class names of elements. We use a MutationObserver to make sure that the HTML element always has a TridactylTheme class
// We can't just call theme() because it would first try to remove class names from the element, which would trigger the MutationObserver before we had a chance to add the theme class and thus cause infinite recursion
const cb = async mutationList => {
    const theme = await config.getAsync("theme")
    mutationList
        .filter(m => m.target.className.search(prefixTheme("")) === -1)
        .forEach(m => m.target.classList.add(prefixTheme(theme)))
}

new MutationObserver(cb).observe(document.documentElement, {
    attributes: true,
    childList: false,
    characterData: false,
    subtree: false,
    attributeOldValue: false,
    attributeFilter: ["class"],
})
// DEPRECATION ENDS
