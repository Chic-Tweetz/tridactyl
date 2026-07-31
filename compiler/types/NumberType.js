"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NumberType = void 0;
class NumberType {
    constructor(isDotDotDot = false, isQuestion = false) {
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "number";
    }
    toConstructor() {
        return `new NumberType(${this.isDotDotDot}, ${this.isQuestion})`;
    }
    toString() {
        return this.kind;
    }
    convert(argument) {
        const n = parseFloat(argument);
        if (!Number.isNaN(n)) {
            return n;
        }
        throw new Error(`Can't convert to number: ${argument}`);
    }
}
exports.NumberType = NumberType;
