/**
 * Intention: keep all Tridactyl UI contained.
 * When possible, also keep it in an iframe so we can be happy that nothing sensitive leaks to the page.
 *
 * Because they're added to a fullscreen iframe, we can't use mouse events directly because it'd block the page.
 * Instead, when UI elements are "mouseable", we add "proxy" elements over the top of them, outside of the iframe.
 * Mouse over proxy -> enable mouse for iframe + mouseable element
 * The proxy mouse events are disabled and four new elements surround it. Mousing over them returns all back to normal.
 * For the mode indicator, mousing over hides the element instead. Similar process though.
 *
 * Tridactyl UI includes: cmdline, status indicator, hint flags
 * also previously :find highlights but they now use the highlight API
 *
 * I also want to make it simple to inject any old element.
 *
 * For instance, a simple "hint to choose" display like my big old hint-to-select-tab :js script I made that one time
 *
 * That'll need its own module though. We'll just handle adding/removing UI elements here.
 */
import * as styling from "@src/content/styling"
import * as hinting from "@src/content/hinting"
import * as config from "@src/lib/config"

/* TODO:

- we could make a HUD element class that we could return when attaching them
because currently i'm passing elements to some exported functions

somethin like

class HUDElement {
    element,
    proxy?,

    resize() // for proxies
    remove()
    show()
    hide()
    popover()

    moveToTop()
    moveToBack()
    moveAfter(other)
    moveBefore(other)
}

- on that note of moving elements in a stack
might be nice to deliberately keep track of layers
and perhaps make them groupable

so stuff like the status indicator/whichkey could be in a less important group
then the commandline could just always be ahead of them when it is shown


class HUDElement {
    element: Element
    mouseProxy?: Element

    resize() {
        if (this.mouseProxy)
            updateGeometry(this.element, this.mouseProxy)
    }
}

i've added "salvage" functions for if document.write et al are called
i wonder if we could have another mechanism for handling a lost hud iframe
anything added by addElement would be "dead" and unusable (I THINK)
... just make sure on that please? I'm not actually sure which elements were dead

*/

// Perhaps what i'd want is to map elements to their options/proxies?
// that's so i can call addElement with the original options to reattach them
// i realise this is an array so elements would be reinserted in the same order
let uiElements: UIElement[] = []
class UIElement {
    public proxy?: Element
    constructor(readonly element: Element, readonly options: UIElementOptions) {}
}

let noiframe = false
let initQueue: ([Element, UIElementOptions])[] = []
let hudIframe = null

const elementHost = document.createElement("div")
maximiseElement(elementHost)

const overlayHost = makeHudProxiesOverlay()
const hud = document.createElement("div")
const shadow = hud.attachShadow({mode:"closed"})
let initPromise

// Automatically call showPopover() or removeAttribute("popover") depending on whether at least 1 popover element is visible
const visiblePopovers: Set<Element> = new Set()

// const allowNoIframeWorkaround = true // config setting I suppose? Also I've added it as an option for individual elements now
const autoFail = false // for testing

const elementsToProxies = new Map()
// const hintables: Set<Element> = new Set()
// on allowNoIframeFallback, consider:
// cmdline - in its own iframe anyway (so allow!)
// mode indicator - currently exposed so might as well allow, can show last used excmd so some may prefer blocking if no iframe
// hinting - doesn't expose anything sensitive, allow
// is there any other UI in tridactyl (by deafult)? don't think so
// however, I want to make a "hintable" option selector (similar to/enabling a version of that crazy :js tab picker i made)
// i also like the idea of adding input elements to the page that the page can't see, which i have felt may be uesful on some occasions
interface UIElementOptions {
    mouseable?: boolean | "hide",
    hintable?: boolean,
    abortIfNoIframe?: boolean,
    beforeElement?: string | Element,
    afterElement?: string | Element,
    popover?: boolean,
    name?: string,
    startHidden?: boolean,
    afterAttachedCallback?: () => void,
}

function maximiseElement(element) {
    element.style.setProperty("position", "fixed", "important")
    element.style.setProperty("top", "0", "important")
    element.style.setProperty("left", "0", "important")
    element.style.setProperty("width", "100%", "important")
    element.style.setProperty("height", "100%", "important")
}

// This should return a UIElement from which you can call its show/hide/whatever members
// It's just a bit cobbled together atm
export function query(selector) {
    return elementHost.querySelector(selector) || elementHost.querySelector(`[hudname=${selector}]`)
}

export function queryAll(selector) {
    return Array.from(elementHost.querySelectorAll(selector))
}

export function popover(pop = true) {
    if (pop && typeof hud.showPopover === "function") {
        hud.setAttribute("popover", "manual")
        hud.showPopover()
    } else if (!pop) {
        hud.removeAttribute("popover")
    }
}

export function isConnected(elementOrSelector: Element | string) {
    if (typeof elementOrSelector === "string") {
        return query(elementOrSelector) ||
            initQueue.find(([queuedEl]) =>
                queuedEl.matches(elementOrSelector) ||
                queuedEl.matches(`[hudname=${elementOrSelector}]`)
            )
    }

    return elementOrSelector.isConnected ||
        initQueue.find(([queuedEl]) => elementOrSelector === queuedEl)
}

export function show(elementOrSelector: Element | string) {
    let element
    if (typeof elementOrSelector === "string") {
        element = query(elementOrSelector)
        if (!element) return
    } else {
        element = elementOrSelector
        if (!elementHost.contains(element)) return
    }

    element.style.display = ""
    element.removeAttribute("hidden")

    if (element.hasAttribute("hudautopopover")) {
        visiblePopovers.add(element)
        popover()
    }

    const proxy = elementsToProxies.get(element)
    if (proxy) {
        updateGeometry(element, proxy)
        elementsToProxies.get(element).style.removeProperty("display")
    }
}

export function hide(elementOrSelector: Element | string) {
    let element
    if (typeof elementOrSelector === "string") {
        element = query(elementOrSelector)
        if (!element) return
    } else {
        element = elementOrSelector
        if (!elementHost.contains(element)) return
    }

    const proxy = elementsToProxies.get(element)
    if (proxy) proxy.style.display = "none"

    element.style.setProperty("display", "none", "important")
    element.setAttribute("hidden", true)

    if (element.hasAttribute("hudautopopover")) {
        visiblePopovers.delete(element)
        if (visiblePopovers.size === 0) {
            popover(false)
        }
    }
}

export function blur(element) {
    element.blur()
    hudIframe?.blur?.()
}

export function toggleHidden(elementOrSelector: Element | string) {
    let element
    if (typeof elementOrSelector === "string") {
        element = query(elementOrSelector)
        if (!element) return
    } else {
        element = elementOrSelector
        if (!elementHost.contains(element)) return
    }

    if (element.hasAttribute("hidden")) show(element)
    else hide(element)
}

// Going to use this on the mode indicator which doesn't always match its proxy
export function resize(element) {
    const proxy = elementsToProxies.get(element)
    if (proxy)
        updateGeometry(element, proxy)
}

export function addElement(element, options: UIElementOptions = {}) {
    if (!hudIframe && !noiframe) {
        initQueue.push([element, options])
        init()
        return
    }
    if (noiframe && !options.abortIfNoIframe && !(config.get("hudnoiframe") === "true")) {
        return
    }

    const hudName = options.name || element.id || Math.random().toString()

    // I intend to move away from all these functions that are passed an element
    // and instead create UIElements and return those
    // so you'd use someUiElement.hide() instead of HUD.hide(someElement) for instance
    // for now i'm just using this as a way of remembering what's been attached and with what options
    const uiElement = new UIElement(element, options)
    // if the element has been attached before, should I also be removing it/its proxies here
    // I've already forgotten quite why I needed to add the uiElements array
    // But i think it was to do with the document.write protection stuff
    // Why isn't this just a set of elements then
    // Or you can just use elementsToProxies with null for the proxies or something
    // ... yeah, dunno what's going on
    uiElements = uiElements.filter((uiEl) => (uiEl.element !== element))
    uiElements.push(uiElement)

    if (!hud.isConnected) document.documentElement.appendChild(hud)

    // We may be trying to alter the element's HUD properties or something?
    // Currently, we're just sometimes adding the status indicator twice and ending up with two proxies
    elementsToProxies.get(element)?.remove?.()

    element.setAttribute("hudname", hudName)

    if (options.hintable) {
        // hintables.add(element)
        // what if what if what if...
        // I'm using attributes elsewhere so will probably do so for this istead of a classs
        // element.classList.add("TridactylHUDHintable")
        element.setAttribute("hudhintable", true)
    }

    if (options.popover) {
        element.setAttribute("hudautopopover", true)
    }

    if (options.startHidden) {
        hide(element)
    } else {
        show(element)
    }

    let adjacentElement
    let adjacentPosition
    if (options.beforeElement) {
        if (typeof options.beforeElement === "string") {
            options.beforeElement = elementHost.querySelector(options.beforeElement)
        }
        adjacentElement = options.beforeElement
        adjacentPosition = "beforebegin"
    } else if (options.afterElement) {
        if (typeof options.afterElement === "string") {
            options.afterElement = elementHost.querySelector(options.afterElement)
        }
        adjacentElement = options.afterElement
        adjacentPosition = "afterend"
    }

    if (adjacentElement) {
        try {
            adjacentElement.insertAdjacentElement(adjacentPosition, element)
        } catch {
            elementHost.appendChild(element)
        }
    } else {
        elementHost.appendChild(element)
    }

    switch (options.mouseable) {
        case true: addMousableElement(element); break
        case "hide": addMouseHidesElement(element); break
        default: addMouselessElement(element)
    }

    options.afterAttachedCallback?.()

    setTimeout(() => {
        resize(element)
    })

    observeElement(element)
}

export function getHudIframe() {
    return hudIframe
}

export function getHudShadowHost() {
    return hud
}

// Stop hinting proxies and stuff
export function isHUDElement(element) {
    return shadow.contains(element) || element === hud
}

export function getHintableElements(selectors = "*", filters: ((ele: HTMLElement) => boolean)[] = []) {
    // return Array.from(hintables)
    if (!elementHost) return []
    return (Array.from(elementHost.querySelectorAll(selectors)))
        .filter(
            el => (el as HTMLElement).matches("[hudhintable],[hudhintable] *") &&
            filters.every(filter => filter(el as HTMLElement))
        )
}

export function hint() {
    hinting.hintPage(
        hinting.toHintablesArray(getHintableElements()),
        element => element.click(),
    )
}

function makeHudIframe(): Promise<HTMLIFrameElement> {
    if (config.get("hudnoiframe") === "true") {
        hudIframe = null
        noiframe = true
        makeNoIframeBackupHost()
        return Promise.reject()
    }

    const iframe = document.createElement("iframe")
    iframe.setAttribute(
        "src",
        browser.runtime.getURL("static/blank.html"),
    )

    maximiseElement(iframe)
    iframe.style.pointerEvents = "none"
    iframe.style.border = "none"
    iframe.style.colorScheme = "light dark"

    return new Promise((resolve, reject) => {
        iframe.addEventListener("load", () => {
            if (iframe.contentDocument && !autoFail) {
                // const win = iframe.contentWindow
                const doc = iframe.contentDocument

                doc.documentElement.appendChild(elementHost)

                // elementHost = doc.documentElement
                // overlayHost = makeHudProxiesOverlay()
                styling.theme(iframe.contentDocument.documentElement)
                hudIframe = iframe
                resolve(iframe)
            } else {
                console.error("Could not access HUD iframe's content")
                iframe.remove()
                hudIframe = null
                noiframe = true
                makeNoIframeBackupHost()
                reject()
            }
        })
        shadow.appendChild(iframe)
    })
}

// If iframe is detached, we'll lose anything in it (dead elements)
// if we know it's going to happen we can take everything out first
// e.g. if document.write is called we can do this first and reattachElements after

let salvagedQueue = []

export function salvageElements() {
    console.warn("HUD: salvaging elements after document.write/writeln/open call")
    // if (uiElements.length) {
    //     salvagedQueue = salvagedQueue.concat(uiElements.map(uiEl => [uiEl.element, uiEl.options]))
    //     uiElements = []
    // }
    if (initQueue.length) {
        salvagedQueue = salvagedQueue.concat(initQueue)
        initQueue = []
    }
    initPromise = null
    hudIframe = null
    // overlayHost = null
    // elementHost = null

    // elementsToProxies = new Map()

    elementHost.remove()
    shadow.replaceChildren()
    hud.remove()
}

let reattachDebounceTimer = null
export function reattachElements() {
    clearTimeout(reattachDebounceTimer)
    reattachDebounceTimer = setTimeout(() => {
        if (initPromise) {
            return
        }

        init()
        .catch(() => {
            hudIframe = null
        })
        .finally(() => {
            console.warn("HUD: reattaching elements")
            for (const [element, options] of salvagedQueue) {
                addElement(element, options)
            }
            salvagedQueue = []
        })
    }, 200)
}

// If you have no iframe and still want to allow elements to be added
// you can skip all the mouse event workarounds
// but in the meantime i guess this is fine
function makeNoIframeBackupHost() {
    const styleHolder = document.createElement("div")
    styleHolder.style.display = "none"
    styleHolder.id = "tridactyl-styles"
    shadow.prepend(styleHolder)
    styling.theme(shadow)
    // elementHost = document.createElement("div")
    // elementHost.style.position = "fixed"
    // elementHost.style.top = "0"
    // elementHost.style.left = "0"
    // elementHost.style.width = "100%"
    // elementHost.style.height = "100%"
    shadow.appendChild(elementHost)
    // overlayHost = makeHudProxiesOverlay()
}

function makeHudProxiesOverlay() {
    const proxyOverlay = document.createElement("div")
    proxyOverlay.style.position = "fixed"
    proxyOverlay.style.top = "0"
    proxyOverlay.style.left = "0"
    proxyOverlay.style.width = "0"
    proxyOverlay.style.height = "0"
    // shadow.appendChild(proxyOverlay)
    return proxyOverlay
}

function init() {
    if (initPromise) return initPromise
    attachHud()

    initPromise = makeHudIframe()

    initPromise
    .catch(() => {
        initPromise = null // Why do I do this?
        hudIframe = null
    })
    .finally(() => {
        shadow.appendChild(overlayHost)
        for (const [element, options] of initQueue) {
            addElement(element, options)
        }
        initQueue = []
    })

    // initPromise.then(() => {
    //     for (const [element, options] of initQueue) {
    //         addElement(element, options)
    //     }
    //     initQueue = []
    // }, () => {
    //     initPromise = null
    //     hudIframe = null
    // })

    // Let's just brute-force make sure the elements have their proxies in the right place
    // setTimeout(onresize, 50)
    // setTimeout(onresize, 500)
    // setTimeout(onresize, 1000)
    return initPromise
}

let mouseOverElem = null
let autoUpdateSurrounders = false
let onMouseOut = null
let surrounderelems
function mouseOver(elem, onmouseout, followElement = false) {
    if (onMouseOut) onMouseOut()
    mouseOverElem = elem
    onMouseOut = onmouseout
    autoUpdateSurrounders = followElement

    if (!surrounderelems) {
        surrounderelems = []
        for (let i = 0; i < 4; ++i) {
            const surrounder = document.createElement("div")
            surrounderelems.push(surrounder)
            surrounder.addEventListener("mouseover", mouseout)

            surrounder.style.position = "fixed"
            surrounder.style.pointerEvents = "all"

            config.getAsync("huddebug").then(c => {
                if (c === "true") surrounder.style.background = "rgba(0,0,200,0.5)"
            })
        }

        surrounderelems[0].style.left = "0"
        surrounderelems[0].style.top = "0"
        surrounderelems[0].style.height = "100%"

        surrounderelems[1].style.left = "0"
        surrounderelems[1].style.width = "100%"
        surrounderelems[1].style.top = "0"

        surrounderelems[2].style.right = "0"
        surrounderelems[2].style.top = "0"
        surrounderelems[2].style.height = "100%"

        surrounderelems[1].style.left = "0"
        surrounderelems[3].style.width = "100%"
        surrounderelems[3].style.bottom = "0"
    }

    updateSurrounders()
    surrounderelems.forEach(elem => overlayHost.appendChild(elem))
}

function updateSurrounders() {
    if (!surrounderelems?.length || !mouseOverElem) return
    const rect = mouseOverElem.getBoundingClientRect()
    surrounderelems[0].style.width = Math.max(0, rect.x) + "px"
    surrounderelems[1].style.height = Math.max(0, rect.y) + "px"
    surrounderelems[2].style.left = Math.max(0, rect.right) + "px"
    surrounderelems[3].style.top = Math.max(0, rect.bottom) + "px"
}

function mouseout() {
    mouseOverElem = null
    onMouseOut?.()
    onMouseOut = null
    surrounderelems.forEach(elem => elem.remove())
}

function createProxyOverlay(element) {
    const proxy = document.createElement("div")
    proxy.setAttribute("hudname", element.getAttribute("hudname"))
    updateGeometry(element, proxy)
    elementsToProxies.get(element)?.remove?.()
    elementsToProxies.set(element, proxy)
    overlayHost.appendChild(proxy)
    return proxy
}

function updateGeometry(element, proxy) {
    const r = element.getBoundingClientRect()

    proxy.style.position = "fixed"
    proxy.style.top = r.y + "px"
    proxy.style.left = r.x + "px"
    proxy.style.width = r.width + "px"
    proxy.style.height = r.height + "px"

    config.getAsync("huddebug").then(c => {
        if (c === "true") proxy.style.border = "1px solid red"
    })
}

function addMouseHidesElement(element: HTMLElement) {
    element.style.pointerEvents = "none"

    const proxy = createProxyOverlay(element)
    proxy.style.pointerEvents = "all"

    proxy.addEventListener("mouseenter", () => {
        proxy.style.pointerEvents = "none"
        element.classList.add("TridactylInvisible")
        element.style.display = "none"
        mouseOver(proxy, () => {
            proxy.style.pointerEvents = "all"
            element.classList.remove("TridactylInvisible")
            element.style.display = ""
        })
    })
}

function addMousableElement(element: HTMLElement) {
    element.style.pointerEvents = "all"
    if (noiframe) return

    const proxy = createProxyOverlay(element)
    proxy.style.pointerEvents = "all"

    proxy.addEventListener("mouseenter", () => {
        proxy.style.pointerEvents = "none"

        if (!noiframe)
            hudIframe.style.pointerEvents = "all"

        mouseOver(proxy, () => {
            proxy.style.pointerEvents = "all"

            if (!noiframe)
                hudIframe.style.pointerEvents = "none"
            },
            true,
        )
    })
}

function addMouselessElement(element: HTMLElement) {
    if (noiframe) element.style.pointerEvents = "none"
    elementsToProxies.set(element, null)
    elementHost.appendChild(element)
}

export function removeElement(element) {
    elementsToProxies.get(element)?.remove()
    elementsToProxies.delete(element)

    // seriously what did i make this array for
    uiElements = uiElements.filter((uiEl) => (uiEl.element !== element))

    // hintables.delete(element)
    if (element.hasAttribute("hudautopopover")) {
        visiblePopovers.delete(element)
        if (visiblePopovers.size === 0)
            popover(false)
    }

    element.remove()
    if (mouseOverElem === element) {
        mouseOverElem = null
        onMouseOut = null
        surrounderelems.forEach(element => element.remove())
    }
}

export function attachHud() {
    hud.className = "TridactylHud"
    document.documentElement.appendChild(hud)
    window.removeEventListener("resize", onresizeDebounced)
    window.addEventListener("resize", onresizeDebounced)
}

const resizeObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) {
        const targetProxy = elementsToProxies.get(target)
        if (targetProxy) {
            updateGeometry(target, targetProxy)
            if (targetProxy === mouseOverElem && autoUpdateSurrounders) {
                updateSurrounders()
            }
        }
    }
})

function observeElement(element) {
    // const config = { attributes: true, childList: true, subtree: true }
    // observer.observe(element, config)
    resizeObserver.observe(element)
}

let lastResize = 0
let resizeTimer = null
const RESIZE_DELAY = 50
function onresizeDebounced() {
    clearTimeout(resizeTimer)
    const now = performance.now()
    if (now > lastResize + RESIZE_DELAY) {
        lastResize = now
        onresize()
    } else {
        resizeTimer = setTimeout(() => {
            lastResize = performance.now()
            onresize()
        }, RESIZE_DELAY)
    }
}

function onresize() {
    for (const [elem, proxy] of elementsToProxies) {
        if (proxy) {
            updateGeometry(elem, proxy)
            if (proxy === mouseOverElem && autoUpdateSurrounders)
                updateSurrounders()
        }
    }
}
