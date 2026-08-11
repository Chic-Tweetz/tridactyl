import * as styling from "@src/content/styling"

let failed = false
const elementsToProxies = new Map()
let initQueue: (() => any)[] = []
let hudIframe = null
let hudDoc = null
let overlayHost = null
let hud = document.createElement("div")
let initPromise

export function getHudIframe() {
    return hudIframe
}

// Stop hinting proxies and stuff
export function isElementInHUD(element) {
    return (overlayHost && overlayHost.contains(element)) || element === hudIframe
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
            if (iframe.contentDocument) {
                // iframe and proxy parent should share an ancestor (probably also a shadow dom)
                // and that is what should use popover
                // okay, popover is weird and i forget what it does or how it works
                // if (typeof iframe.showPopover === "function") {
                //     iframe.setAttribute("popover", "manual")
                //     iframe.showPopover()
                // }


                hudDoc = iframe.contentDocument
                overlayHost = makeHudProxiesOverlay()
                styling.theme(iframe.contentDocument.documentElement)
                resolve(iframe)
            } else {
                console.error("Could not access HUD iframe's content")
                failed = true
                reject()
                iframe.remove()
            }
        })
        hud.appendChild(iframe)
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

function makeHudProxiesOverlay() {
    const proxyOverlay = document.createElement("div")
    proxyOverlay.style.position = "fixed"
    proxyOverlay.style.top = "0"
    proxyOverlay.style.left = "0"
    proxyOverlay.style.width = "0"
    proxyOverlay.style.height = "0"
    hud.appendChild(proxyOverlay)

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
    initPromise = makeHudIframe()
    hudIframe = await initPromise
    for (const fn of initQueue) {
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
    if (failed) return

    element.style.pointerEvents = "none"

    hudDoc.body.appendChild(element)

    const proxy = document.createElement("div")
    updateGeometry(element, proxy)
    overlayHost.appendChild(proxy)

    observeElement(element)
    elementsToProxies.set(element, proxy)

    proxy.addEventListener("mouseenter", () => {
        proxy.style.pointerEvents = "none"
        element.classList.add("TridactylInvisible")
        element.style.display = "none"
        mouseOver(proxy, () => {
            proxy.style.pointerEvents = ""
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
    if (failed) return

    hudDoc.body.appendChild(element)

    const proxy = document.createElement("div")
    updateGeometry(element, proxy)
    overlayHost.appendChild(proxy)

    observeElement(element)
    elementsToProxies.set(element, proxy)

    proxy.addEventListener("mouseenter", () => {
        proxy.style.pointerEvents = "none"
        hudIframe.style.pointerEvents = ""

        mouseOver(proxy, () => {
            proxy.style.pointerEvents = ""
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
    if (failed) return
    elementsToProxies.set(element, null)
    hudDoc.body.appendChild(element)
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

function onresizeDebounced() {
    onresize()
}

function onresize() {
    for (const [elem, proxy] of elementsToProxies) {
        if (proxy) updateGeometry(elem, proxy)
    }
}

window.addEventListener("resize", onresizeDebounced)
