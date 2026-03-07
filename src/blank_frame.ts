import * as Messaging from "@src/lib/messaging"

/**
 * Seems we can't pop a link in from the normal content scfipt?
 * lemme see...
 */
function addCssFile(url) {
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = url
    document.head.appendChild(url)
}

// Messaging.addListener()
