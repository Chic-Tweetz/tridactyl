import * as styling from "@src/content/styling"

let failed = false
const elementsToProxies = new Map()
let initQueue: (() => any)[] = []
let hudIframe = null
let hudDoc = null
let elementHost = null
let overlayHost = null
let hud = document.createElement("div")
let shadow = hud.attachShadow({mode:"closed"})
let initPromise

const allowNoIframeWorkaround = true // config setting I suppose
const autoFail = false // for testing

// on allowNoIframeFallback, consider:
// cmdline - in its own iframe anyway (so allow!)
// mode indicator - currently exposed so might as well allow, can show last used excmd so some may prefer blocking if no iframe
// hinting - doesn't expose anything sensitive, allow
// is there any other UI in tridactyl (by deafult)? don't think so
// however, I want to make a "hintable" option selector (similar to/enabling a version of that crazy :js tab picker i made)
// i also like the idea of adding input elements to the page that the page can't see, which i have felt may be uesful on some occasions
type UIElementOptions = {
    mouseable?: true | false | "hide",
    hintable?: true | false,
    allowNoIframeFallback?: true | false,
}

export function getHudIframe() {
    return hudIframe
}

// Stop hinting proxies and stuff
export function isElementInHUD(element) {
    return hud.contains(element)
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
                // iframe and proxy parent should share an ancestor (probably also a shadow dom)
                // and that is what should use popover
                // okay, popover is weird and i forget what it does or how it works
                // if (typeof iframe.showPopover === "function") {
                //     iframe.setAttribute("popover", "manual")
                //     iframe.showPopover()
                // }


                hudDoc = iframe.contentDocument
                elementHost = hudDoc.body
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
    elementHost = document.createElement("div")
    elementHost.style.position = "fixed"
    elementHost.style.top = "0"
    elementHost.style.left = "0"
    elementHost.style.width = "100%"
    elementHost.style.height = "100%"
    styling.theme(shadow)
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

    // TODO: figure out popover, use it in some parent element/shadow dom that contains the iframe and proxy overlay
    // if (typeof proxyOverlay.showPopover === "function") {
    //     proxyOverlay.setAttribute("popover", "manual")
    //     proxyOverlay.showPopover()
    // }
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
        console.log("from queue!", fn)
        fn()
    }
    initQueue = []
    return initPromise
}

let mouseOverElem = null
let onMouseOut = null
let surrounderelems
function mouseOver(elem, onmouseout) {
    if (onMouseOut) onMouseOut()
    mouseOverElem = elem
    onMouseOut = onmouseout
    const rect = elem.getBoundingClientRect()

    if (!surrounderelems) {
        surrounderelems = []
        for (let i = 0; i < 4; ++i) {
            const surrounder = document.createElement("div")
            surrounderelems.push(surrounder)
            surrounder.addEventListener("mouseover", mouseout)

            surrounder.style.position = "fixed"
            surrounder.style.background = "rgba(0,0,200,0.5)"
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

    surrounderelems[0].style.width = rect.x + "px"
    surrounderelems[1].style.height = rect.y + "px"
    surrounderelems[2].style.left = rect.right + "px"
    surrounderelems[3].style.top = rect.bottom + "px"

    surrounderelems.forEach(elem => overlayHost.appendChild(elem))
}

function mouseout() {
    onMouseOut?.()
    mouseOverElem = null
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
    proxy.style.border = "1px solid red"
}

export async function addMouseHidesElement(element: HTMLElement) {
    if (!hudIframe && !failed) {
        initQueue.push(() => addMouseHidesElement(element))
        init()
        return
    }
    if (failed && !allowNoIframeWorkaround) return


    element.style.pointerEvents = "none"
    elementHost.appendChild(element)

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

export async function addMousableElement(element: HTMLElement) {
    if (!hudIframe && !failed) {
        initQueue.push(() => addMousableElement(element))
        init()
        return
    }
    if (failed && !allowNoIframeWorkaround) return

    elementHost.appendChild(element)

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
        })
    })
}

export async function addMouselessElement(element: HTMLElement) {
    if (!hudIframe && !failed) {
        initQueue.push(() => addMouselessElement(element))
        init()
        return
    }
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
    }
    for (const elem of toUpdate) {
        const targetProxy = elementsToProxies.get(elem)
        if (targetProxy) {
            updateGeometry(elem, targetProxy)
        }
    }
})

function observeElement(element) {
    const config = { attributes: true, childList: true, subtree: true }
    observer.observe(element, config)
}

// not debounced yet mind you
function onresizeDebounced() {
    onresize()
}

function onresize() {
    for (const [elem, proxy] of elementsToProxies) {
        if (proxy) updateGeometry(elem, proxy)
    }
}

window.addEventListener("resize", onresizeDebounced)
