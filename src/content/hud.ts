import * as styling from "@src/content/styling"
import * as hinting from "@src/content/hinting"

let failed = false
let initQueue: (() => any)[] = []
let hudIframe = null
let hudDoc = null
let elementHost = null
let overlayHost = null
const hud = document.createElement("div")
const shadow = hud.attachShadow({mode:"closed"})
let initPromise

const allowNoIframeWorkaround = true // config setting I suppose
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
    mouseable?: true | false | "hide",
    hintable?: true | false,
    allowNoIframeFallback?: true | false,
    beforeElement?: string | Element,
    afterElement?: string | Element,
}

export function addElement(element, options: UIElementOptions = {}) {
    if (!hudIframe && !failed) {
        initQueue.push(() => addElement(element, options))
        init()
        return
    }
    if (failed && !allowNoIframeWorkaround) return

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

    if (options.hintable) {
        // hintables.add(element)
        // what if what if what if...
        element.classList.add("TridactylHUDHintable")
    }
    switch (options.mouseable) {
        case true: return addMousableElement(element)
        case "hide": return addMouseHidesElement(element)
        default: return addMouselessElement(element)
    }
}

export function getHudIframe() {
    return hudIframe
}

// Stop hinting proxies and stuff
export function isHUDElement(element) {
    return shadow.contains(element) || element === hud
}

export function getHintableElements(selectors = "*", filters: ((elem) => boolean)[] = []): Element[] {
    // return Array.from(hintables)
    return (Array.from(elementHost.querySelectorAll(selectors)))
        .filter(
            el => el.matches(".TridactylHUDHintable,.TridactylHUDHintable *") &&
            filters.every(filter => filter(el))
        )
}

export function hint() {
    hinting.hintPage(
        hinting.toHintablesArray(getHintableElements()),
        element => element.click(),
    )
}

function makeHudIframe(): Promise<HTMLIFrameElement> {
    const iframe = document.createElement("iframe")
    iframe.setAttribute(
        "src",
        browser.runtime.getURL("static/blank.html"),
    )
    iframe.style.position = "fixed"
    iframe.style.top = "0"
    iframe.style.left = "0"
    iframe.style.width = "100%"
    iframe.style.height = "100%"
    iframe.style.pointerEvents = "none"
    iframe.style.border = "none"
    iframe.style.colorScheme = "light dark"

    return new Promise((resolve, reject) => {
        iframe.addEventListener("load", () => {
            if (iframe.contentDocument && !autoFail) {
                iframe.contentDocument.body.style.margin = "0"
                iframe.contentDocument.body.style.padding = "0"

                hudDoc = iframe.contentDocument
                elementHost = hudDoc.documentElement
                overlayHost = makeHudProxiesOverlay()
                styling.theme(iframe.contentDocument.documentElement)
                resolve(iframe)
            } else {
                console.error("Could not access HUD iframe's content")
                failed = true
                if (allowNoIframeWorkaround) {
                    makeNoIframeBackupHost()
                }
                iframe.remove()
                reject()
            }
        })
        shadow.appendChild(iframe)
    })
}

function makeHud() {
    hud.className = "TridactylHud"
    document.documentElement.appendChild(hud)
    if (typeof hud.showPopover === "function") {
        hud.setAttribute("popover", "manual")
        hud.showPopover()
    }
}

// If you have no iframe and still want to allow elements to be added
// you can skip all the mouse event workarounds
// but in the meantime i guess this is fine
function makeNoIframeBackupHost() {
    const styleHolder = document.createElement("div")
    styleHolder.style.display = "none"
    styleHolder.id = "tridactyl-styles"
    styling.theme(shadow)
    elementHost = document.createElement("div")
    elementHost.style.position = "fixed"
    elementHost.style.top = "0"
    elementHost.style.left = "0"
    elementHost.style.width = "100%"
    elementHost.style.height = "100%"
    shadow.appendChild(elementHost)
    overlayHost = makeHudProxiesOverlay()
}

function makeHudProxiesOverlay() {
    const proxyOverlay = document.createElement("div")
    proxyOverlay.style.position = "fixed"
    proxyOverlay.style.top = "0"
    proxyOverlay.style.left = "0"
    proxyOverlay.style.width = "0"
    proxyOverlay.style.height = "0"
    shadow.appendChild(proxyOverlay)
    return proxyOverlay
}

async function init() {
    if (initPromise) return initPromise
    makeHud()
    try {
        initPromise = makeHudIframe()
        hudIframe = await initPromise
    } catch(_) {}
    for (const fn of initQueue) {
        fn()
    }
    initQueue = []
    // Let's just brute-force make sure the elements have their proxies in the right place
    setTimeout(onresize, 50)
    setTimeout(onresize, 500)
    setTimeout(onresize, 1000)
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
            // surrounder.style.background = "rgba(0,0,200,0.5)"
            surrounder.style.pointerEvents = "all"
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

function updateGeometry(element, proxy) {
    const r = element.getBoundingClientRect()
    proxy.style.position = "fixed"
    proxy.style.top = r.y + "px"
    proxy.style.left = r.x + "px"
    proxy.style.width = r.width + "px"
    proxy.style.height = r.height + "px"
    // proxy.style.border = "1px solid red"
}

function addMouseHidesElement(element: HTMLElement) {
    element.style.pointerEvents = "none"

    const proxy = document.createElement("div")
    proxy.style.pointerEvents = "all"
    updateGeometry(element, proxy)
    overlayHost.appendChild(proxy)

    observeElement(element)
    elementsToProxies.set(element, proxy)

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
    if (failed) return

    const proxy = document.createElement("div")
    proxy.style.pointerEvents = "all"
    updateGeometry(element, proxy)
    overlayHost.appendChild(proxy)

    observeElement(element)
    elementsToProxies.set(element, proxy)

    proxy.addEventListener("mouseenter", () => {
        proxy.style.pointerEvents = "none"

        if (!failed)
            hudIframe.style.pointerEvents = "all"

        mouseOver(proxy, () => {
            proxy.style.pointerEvents = "all"

            if (!failed)
                hudIframe.style.pointerEvents = "none"
            },
            true,
        )
    })
}

function addMouselessElement(element: HTMLElement) {
    if (!hudIframe && !failed) {
        initQueue.push(() => addMouselessElement(element))
        init()
        return
    }

    observeElement(element)
    if (failed && !allowNoIframeWorkaround) return
    if (failed) {
        element.style.pointerEvents = "none"
    }
    elementsToProxies.set(element, null)
    elementHost.appendChild(element)
}

export function removeElement(element) {
    elementsToProxies.get(element)?.remove()
    elementsToProxies.delete(element)
    // hintables.delete(element)
    element.remove()
    if (mouseOverElem === element) {
        mouseOverElem = null
        onMouseOut = null
        surrounderelems.forEach(element => element.remove())
    }
}

// Create an observer instance linked to the callback function
const observer = new MutationObserver((mutationList) => {
    const toUpdate = new Set()
    for (const mutation of mutationList) {
        toUpdate.add(mutation.target)
        // // Think I might go a different direction with this
        // // and use (element).querySelctorAll("...")
        // // on the root hintable element to get stuff
        // if (mutation.type === "childList" && hintables.has(mutation.target as Element)) {
        //     for (const node of mutation.removedNodes) {
        //         hintables.delete(node as Element)
        //     }
        //     for (const node of mutation.addedNodes) {
        //         if (node.nodeType === Node.ELEMENT_NODE) {
        //             console.log("new hintable node:", node)
        //             hintables.add(node as Element)
        //         }
        //     }
        // }
    }
    for (const elem of toUpdate) {
        const targetProxy = elementsToProxies.get(elem)
        if (targetProxy) {
            updateGeometry(elem, targetProxy)
            if (targetProxy === mouseOverElem && autoUpdateSurrounders) {
                updateSurrounders()
            }
        }

    }
})

function observeElement(element) {
    const config = { attributes: true, childList: true, subtree: true }
    observer.observe(element, config)
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

window.addEventListener("resize", onresizeDebounced)
