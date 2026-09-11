import { MinimalKey } from "@src/lib/keyseq"
import * as nmode from "@src/parsers/nmode"

const key = (keyup = false) => new MinimalKey("Enter", { keyup })

// test("an initial keyup does not count unless nmode is strict", () => {
//     nmode.init("mode normal", "ignore", 1)
//     expect(nmode.parser([key(true)]).exstr).toBeUndefined()
//     expect(nmode.parser([key()]).exstr).toBe("mode normal")

//     nmode.init("mode normal", "ignore", 1, true)
//     expect(nmode.parser([key(true)]).exstr).toBe("mode normal")
// })


// KeyTries: keyups won't kick you out of nmode unless there's a matching <U-...> bind
// Perhaps you should add an arg that prevents that edge case too
test("unmatched keyups do not cause nmode to exit", () => {
    nmode.init("mode normal", "ignore", 1)
    expect(nmode.parser([key(true)]).exstr).toBeUndefined()
    expect(nmode.parser([key()]).exstr).toBe("mode normal")
})
