"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FunctionType = void 0;
class FunctionType {
    constructor(args, ret, isDotDotDot = false, isQuestion = false) {
        this.args = args;
        this.ret = ret;
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "function";
    }
    toConstructor() {
        return (`new FunctionType([` +
            // Convert every argument type to its string constructor representation
            this.args.map(cur => cur.toConstructor()) +
            `], ${this.ret.toConstructor()}, ${this.isDotDotDot}, ${this.isQuestion})`);
    }
    toString() {
        return `(${this.args.map(a => a.toString()).join(", ")}) => ${this.ret.toString()}`;
    }
    convert(argument) {
        // Possible strategies:
        // - eval()
        // - window[argument]
        // - tri.excmds[argument]
        throw new Error(`Conversion to function not implemented: ${argument}`);
    }
}
exports.FunctionType = FunctionType;
