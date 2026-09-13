import { promises as fs } from "fs"
import * as path from "path"
import * as os from "os"
import * as process from "process"
import { Browser, Builder, By, Key, WebDriver, WebElement, WebElementPromise } from "selenium-webdriver"
import { Driver, Options, ServiceBuilder } from "selenium-webdriver/firefox"
import * as Until from "selenium-webdriver/lib/until"

const env = process.env
const drivers = new Set<Driver>()

/** Returns the path of the newest file in directory */
export async function getNewestFileIn(directory: string): Promise<string> {
    try {
        // Get list of files
        const names = await fs.readdir(directory)

        // Get their stat structs
        const stats = await Promise.all(
            names.map(async name => {
                const filePath = path.join(directory, name)
                const stat = await fs.stat(filePath)
                return { path: filePath, mtime: stat.mtime }
            }),
        )

        // Sort by most recent and return the path of the newest file
        return stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0]
            ?.path
    } catch (error) {
        console.error(`Error reading directory ${directory}:`, error)
        throw new Error("Couldn't find extension path")
    }
}

// // Does not work now cmdline iframe is within a hud iframe
// export async function iframeLoaded(driver: Driver) {
//     return driver.wait(Until.elementLocated(By.id("cmdline_iframe")))
// }
//

/**
 * Using HUD iframe means cmdline iframe may (should) be nested in another iframe.
 * We can't use switchTo() straight from the top window to a nested frame,
 * instead we switchTo to first switch to the HUD iframe, then the cmdlin iframe.
 *
 * Use sendColon to make sure it's on the page when `:set noiframe lazy` (default setting)
 * and you haven't sent a ":" yet
 */
export async function switchToIframe(driver: Driver, sendColon = false) {
    await driver.switchTo().defaultContent()
    if (sendColon) await sendKeys(driver, ":")

    const findIframe = () => {
        return driver.wait<WebElementPromise>(
        async (driver: Driver) => {
            try {
                return await driver.executeScript(() => {
                    // Directly in the document
                    const direct = document.querySelector("#cmdline_iframe")
                    if (direct) {
                        return direct
                    }

                    // Directly inside the HUD's open shadow root
                    // Important note: shadow is only open on Tridactyl pages (e.g. new tab)
                    const hud = document.querySelector(".TridactylHud")
                    const shadowRoot = hud?.shadowRoot

                    if (!shadowRoot) {
                        return null
                    }

                    const inShadow = shadowRoot.querySelector("#cmdline_iframe")
                    if (inShadow) {
                        return inShadow
                    }

                    let innerFrame
                    // Inside one of the HUD's iframe documents
                    const containingFrame = Array.from(
                        shadowRoot.querySelectorAll("iframe"),
                    ).find((frame) => {
                        try {
                            innerFrame = frame.contentDocument?.querySelector("#cmdline_iframe")
                            return innerFrame
                        } catch {
                            return null
                        }
                    })

                    // containingFrame should be the HUD iframe, not the commandline
                    return containingFrame || null
                }) ?? null
            } catch {
                // The HUD may not exist yet, or may be recreated while loading.
                return null
            }
        },
        10_000,
        "Could not find cmdline iframe",
    )}

    // We should have just found the HUD iframe
    // now we'll find the cmdline iframe inside it
    let iframe = await findIframe()
    await driver.switchTo().frame(iframe)
    const location: string = await driver.executeScript(`return window.location.href`)
    if (location.endsWith("commandline.html")) return iframe
    iframe = await findIframe()
    await driver.switchTo().frame(iframe)
    return iframe
}

/**
 * Ensure the iframe is on the page then set its value programatically.
 * Uses driver.switchTo() so ensure focus is set correctly after use.
 *
 * @param execute whether to send a <CR> after setting the cmdilne value
 * @param switchToDefaultFrame whether driver focus will be on the default frame (true) or the cmdline iframe (false) after calling
 */
export async function cliQuickSet(driver: Driver, value: string, execute = false, switchToDefaultFrame = true) {
    await driver.switchTo().defaultContent()
    // Send "o" rather than ":" so we can wait for the cmdline value to be "open " before setting it to value
    await sendKeys(driver, "<Esc>o")
    await switchToIframe(driver, false)

    // Avoid Tridactyl overwriting value
    const inputReady = () => {
        return driver.wait<Promise<boolean>>(
        async (driver: Driver) => {
            try {
                return await driver.executeScript(() => {
                    const input: HTMLInputElement | null = document.querySelector("#tridactyl-input")
                    return input?.value === "open "
                })
            } catch {
                return false
            }
        },
        5_000,
        "Failed to quickly set cli input value",
    )}

    await inputReady()

    await driver.executeScript(() => {
        const input: HTMLInputElement | null = document.querySelector("#tridactyl-input");
        if (input) input.value = arguments[0];
    }, value.slice(0, -1))

    await driver.switchTo().defaultContent()

    // Send the last character as a real keypress to update the cmdline state
    await sendKeys(driver, value.slice(-1))

    if (execute)
        await sendKeys(driver, "<CR>")

    if (!switchToDefaultFrame)
        await switchToIframe(driver, false)
}

export async function getDriver() {
    const extensionPath = await getNewestFileIn(
        path.resolve("web-ext-artifacts"),
    )

    const options = new Options()
    if (!env["HEADED"]) {
        options.addArguments("--headless")
    }
    const driver = new Builder()
        .forBrowser(Browser.FIREFOX)
        .setFirefoxOptions(options)
        // Required to evaluate scripts in extension pages; only for test browsers.
        .setFirefoxService(new ServiceBuilder().addArguments("--allow-system-access"))
        .build() as unknown as Driver
    drivers.add(driver)

    // This will be the default tab.
    await driver.installAddon(extensionPath, true)
    // Wait for multiple window handles to be available (extension may open in new tab)
    await driver.wait(async () => {
        const handles = await driver.getAllWindowHandles()
        return handles.length >= 2
    }, 10000)
    // Give the extension a bit more time to initialize
    await driver.sleep(500)
    let handles = await driver.getAllWindowHandles()
    // Handle edge case where extension loads in same tab (some headless configurations)
    if (handles.length === 1) {
        await driver.wait(async () => {
            const newHandles = await driver.getAllWindowHandles()
            return newHandles.length >= 2
        }, 10000)
        handles = await driver.getAllWindowHandles()
    }
    // Kill the original tab.
    await driver.switchTo().window(handles[0])
    await driver.close()
    // Switch to the new tab (extension opens in new tab)
    await driver.switchTo().window(handles[1])
    await driver.wait(() => driver.executeScript<boolean>("return Boolean(window.tri)"), 10000)
    // Now return the window that we want to use.
    return driver
}

export async function getDriverAndProfileDirs() {
    const rootDir = os.tmpdir()
    // First, find out what profile the driver is using
    const profiles = (await fs.readdir(rootDir)).map(p => path.join(rootDir, p))
    const driver = await getDriver()
    const newProfiles = (await fs.readdir(rootDir))
        .map(p => path.join(rootDir, p))
        .filter(p => p.match("moz") && !profiles.includes(p))

    // Tridactyl's tmp profile detection is broken on windows and OSX
    if (["win32", "darwin"].includes(os.platform())) {
        await sendKeys(driver, `:set profiledir ${newProfiles[0]}<CR>`)
        await driver.sleep(1000)
    }

    return { driver, newProfiles }
}

export async function quitDrivers() {
    const results = await Promise.allSettled(
        [...drivers].map(driver =>
            driver.quit().finally(() => drivers.delete(driver)),
        ),
    )
    const failure = results.find(result => result.status === "rejected")
    if (failure?.status === "rejected") {
        throw failure.reason
    }
}

const vimToSelenium = {
    Down: Key.ARROW_DOWN,
    Left: Key.ARROW_LEFT,
    Right: Key.ARROW_RIGHT,
    Up: Key.ARROW_UP,
    BS: Key.BACK_SPACE,
    Del: Key.DELETE,
    End: Key.END,
    CR: Key.ENTER,
    Esc: Key.ESCAPE,
    Home: Key.HOME,
    PageDown: Key.PAGE_DOWN,
    PageUp: Key.PAGE_UP,
    Tab: Key.TAB,
    lt: "<",
}

const modToSelenium = {
    A: Key.ALT,
    C: Key.CONTROL,
    M: Key.META,
    S: Key.SHIFT,
}

export async function sendKeys(driver: WebDriver, keys: string) {
    const delay = 100

    async function sendSingleKey(key: string) {
        await driver.actions().sendKeys(key).perform()
        await driver.sleep(delay)
    }

    async function sendSpecialKey(specialKey: string) {
        const noBrackets = specialKey.slice(1, -1)
        if (noBrackets.includes("-")) {
            const [modifiers, key] = noBrackets.split("-")
            const mods = modifiers.split("").map(mod => modToSelenium[mod])
            let actions = driver.actions()
            for (const mod of mods) {
                actions = actions.keyDown(mod)
            }
            actions = actions.sendKeys(vimToSelenium[key] || key)
            for (const mod of mods) {
                actions = actions.keyUp(mod)
            }
            await actions.perform()
        } else {
            await sendSingleKey(vimToSelenium[noBrackets] || noBrackets)
        }
    }

    keys = keys.replace(":", "<S-;>")
    const regexp = /<[^>-]+-?[^>]*>/g
    const specialKeys = keys.match(regexp) || []
    const regularKeys = keys.split(regexp)

    for (let i = 0; i < Math.max(specialKeys.length, regularKeys.length); i++) {
        if (i < regularKeys.length && regularKeys[i]) {
            for (const key of regularKeys[i].split("")) {
                await sendSingleKey(key)
            }
        }
        if (i < specialKeys.length) {
            await sendSpecialKey(specialKeys[i])
        }
    }
}
