import { staticThemes } from "@src/.metadata.generated"
import * as config from "@src/lib/config"
import * as Logging from "@src/lib/logging"
import { browserBg, ownTabId } from "@src/lib/webext"

const logger = new Logging.Logger("styling")

export const THEMES = staticThemes

function capitalise(str) {
    if (str === "") return str
    return str[0].toUpperCase() + str.slice(1)
}

function prefixTheme(name) {
    return "TridactylTheme" + capitalise(name)
}

function removeThemeClasses(element: Element) {
    for (const className of Array.from(element.classList)) {
        if (className.startsWith(prefixTheme(""))) {
            element.classList.remove(className)
        }
    }
}

function isShadowRoot(target: any): target is ShadowRoot {
    return (
        target &&
        target.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
        typeof (target as ShadowRoot).host === "object"
    )
}

function getRootDocument(target: Element | Document | ShadowRoot): Document {
    if (isShadowRoot(target)) {
        return target.host.ownerDocument
    }
    // Can't do instanceof Document if target is an iframe document
    // return target instanceof Document ? target : target.ownerDocument

    // But Document.ownerDocument will just be null anyway so
    return target.ownerDocument || target as Document
}

function getStyleRoot(target: Element | Document | ShadowRoot) {
    if (isShadowRoot(target)) {
        return target
    }
    const rootNode = target.nodeType === Node.DOCUMENT_NODE
        ? target
        : target.getRootNode()
    return isShadowRoot(rootNode) ? rootNode : getRootDocument(target)
}

function getStyleElementById(target: Document | ShadowRoot, id: string) {
    return isShadowRoot(target)
        ? target.querySelector(`#${id}`)
        : target.getElementById(id)
}

const SHADOW_ROOT_BASE_STYLE_ID = "tridactyl-base-theme-style"
const SHADOW_ROOT_BASE_STYLE_IMPORTS = [
    "static/css/content.css",
    "static/css/hint.css",
    "static/themes/default/default.css",
]

function appendStyle(target: Document | ShadowRoot, id: string, code: string) {
    const style = getRootDocument(target).createElement("style")
    style.id = id
    style.textContent = code
    if (isShadowRoot(target)) {
        (target.querySelector("#tridactyl-styles") || target).appendChild(style)
    } else {
        target.head.appendChild(style)
    }
}

async function appendBaseShadowStyle(root: ShadowRoot) {
    const oldBaseStyle = root.querySelector(`#${SHADOW_ROOT_BASE_STYLE_ID}`)
    if (oldBaseStyle) oldBaseStyle.remove()

    const code = SHADOW_ROOT_BASE_STYLE_IMPORTS
        .map(
            source =>
                `@import url('${browser.runtime.getURL(source)}');`,
        )
        .join("\n")

    appendStyle(root, SHADOW_ROOT_BASE_STYLE_ID, code)
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

export async function theme(element: Element | Document | ShadowRoot) {
    const root = getStyleRoot(element)
    const doc = getRootDocument(root)
    const isShadow = isShadowRoot(root)
    const isMozExtension = doc.defaultView.location.protocol === "moz-extension:"
    const classTarget = isShadow
        ? root.host
        : element.nodeType === Node.DOCUMENT_NODE
        ? doc.documentElement
        : element

    // Remove any old theme

    /**
     * DEPRECATED
     *
     * You don't need to add weird classnames to your themes any more, but you can if you want.
     *
     * Retained for backwards compatibility.
     **/
    if (classTarget.nodeType === Node.ELEMENT_NODE) {
        removeThemeClasses(classTarget as Element)
    }
    // DEPRECATION ENDS

    if (
        classTarget.nodeType === Node.ELEMENT_NODE &&
        classTarget === doc.documentElement &&
        !THEMED_ELEMENTS.includes(classTarget)
    ) {
        THEMED_ELEMENTS.push(classTarget)
    } else if (
        isShadow &&
        !THEMED_ELEMENTS.includes(root)
    ) {
        THEMED_ELEMENTS.push(root)
    }

    if (isShadow) {
        await appendBaseShadowStyle(root)
    }

    // Insert hint CSS rules according to config - copying how themes are inserted
    if (isMozExtension || isShadow) {
        const oldHintStyle = getStyleElementById(root, "tridactyl-hint-style")
        if (oldHintStyle) oldHintStyle.remove()
    } else if (insertedHintElemCSS) {
        await browserBg.tabs.removeCSS(await ownTabId(), hintElemCss)
        insertedHintElemCSS = false
    }

    const hintElemOptions = await config.getAsync("hintstyles")

    // Allow for different hint text colours if using overlays (can help visibility issues)
    const hintFgVar =
        hintElemOptions.overlay === "all"
            ? "--tridactyl-hint-highlight-fg"
            : "--tridactyl-hint-fg"
    const activeFgVar =
        hintElemOptions.overlay === "all"
            ? "--tridactyl-hint-highlight-active-fg"
            : "--tridactyl-hint-active-fg"

    const hintElemRules =
        (hintElemOptions.fg === "all"
            ? `    color: var(${hintFgVar}) !important;\n`
            : "") +
        (hintElemOptions.bg === "all"
            ? "    background: var(--tridactyl-hint-bg) !important;\n"
            : "") +
        (hintElemOptions.outline === "all"
            ? "    outline: var(--tridactyl-hint-outline) !important;\n"
            : "")

    const activeElemRules =
        (hintElemOptions.fg !== "none"
            ? `    color: var(${activeFgVar}) !important;\n`
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
        activeOverlayRules

    if (isMozExtension || isShadow) {
        if (hintElemCss.code !== "") {
            const style = getRootDocument(root).createElement("style")
            style.id = "tridactyl-hint-style"
            style.textContent = hintElemCss.code
            if (isShadow) {
                (root.querySelector("#tridactyl-styles") || root).appendChild(style)
            } else {
                doc.head.appendChild(style)
            }
        }
    } else if (hintElemCss.code !== "") {
        await browserBg.tabs.insertCSS(await ownTabId(), hintElemCss)
        insertedHintElemCSS = true
    }

    if (isMozExtension || isShadow) {
        const oldThemeStyle = getStyleElementById(root, "tridactyl-theme-style")
        if (oldThemeStyle) oldThemeStyle.remove()
    } else if (insertedCSS) {
        // Typescript doesn't seem to be aware than remove/insertCSS's tabid
        // argument is optional
        await browserBg.tabs.removeCSS(await ownTabId(), customCss)
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
    if (config.get("themeprivacy") !== "true" && classTarget.nodeType === Node.ELEMENT_NODE) {
        (classTarget as Element).classList.add(prefixTheme(newTheme))
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
            if (isMozExtension || isShadow) {
                const style = getRootDocument(root).createElement("style")
                style.id = "tridactyl-theme-style"
                style.textContent = customCss.code
                if (isShadow) {
                    (root.querySelector("#tridactyl-styles") || root).appendChild(style)
                } else {
                    doc.head.appendChild(style)
                }
            } else {
                await browserBg.tabs.insertCSS(await ownTabId(), customCss)
                insertedCSS = true
            }
        } else {
            logger.error("Theme " + newTheme + " couldn't be found.")
        }
    }
}

function retheme() {
    console.log("retheme:", THEMED_ELEMENTS)
    THEMED_ELEMENTS.forEach(element => {
        theme(element).catch(e => {
            logger.warning(
                `Failed to retheme element "${element}". Error: ${e}`,
            )
        })
    })
}

config.addChangeListener("theme", retheme)
config.addChangeListener("themeprivacy", retheme)
config.addChangeListener("hintstyles", retheme)

/**
 * DEPRECATED
 *
 * You don't need to add weird classnames to your themes any more, but you can if you want.
 *
 * Retained for backwards compatibility.
 **/
// Sometimes pages overwrite class names. Keep the root element's TridactylTheme classes consistent with themeprivacy.
// We can't just call theme() because it would first try to remove class names from the element, which would trigger the MutationObserver before we had a chance to add the theme class and thus cause infinite recursion
const cb = async mutationList => {
    const theme = await config.getAsync("theme")
    if (config.get("themeprivacy") !== "false") {
        removeThemeClasses(document.documentElement)
        return
    }
    mutationList
        .filter(m => !m.target.classList.value.includes(prefixTheme("")))
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
