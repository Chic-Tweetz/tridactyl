"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StringType = void 0;
class StringType {
    constructor(isDotDotDot = false, isQuestion = false) {
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "string";
    }
    toConstructor() {
        return `new StringType(${this.isDotDotDot}, ${this.isQuestion})`;
    }
    toString() {
        return this.kind;
    }
    convert(argument) {
        if (typeof argument === "string") {
            return argument;
        }
        throw new Error(`Can't convert to string: ${argument}`);
    }
}
exports.StringType = StringType;
