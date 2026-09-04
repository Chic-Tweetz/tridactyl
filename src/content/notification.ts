import * as hud from "@src/content/hud"

const iframes: Set<HTMLIFrameElement> = new Set()

export function createIframe(text, timeout = 5000) {
    const iframe = document.createElement("iframe")
    iframe.setAttribute(
        "src",
        browser.runtime.getURL("static/blank.html"),
    )
    iframe.addEventListener("load", () => {
        if (iframe.contentDocument) {
            const p = iframe.contentDocument.createElement("p")
            p.textContent = text
            iframe.contentDocument.body.appendChild(p)
        }
    })

    hud.addElement(iframe, { mouseable: true, popover: true, abortIfNoIframe: false })

    iframes.add(iframe)
    setTimeout(() => {
        hud.removeElement(iframe)
        iframes.delete(iframe)
    }, timeout)
}
