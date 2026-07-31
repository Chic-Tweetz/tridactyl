"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiteralTypeType = void 0;
class LiteralTypeType {
    constructor(value, isDotDotDot = false, isQuestion = false) {
        this.value = value;
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "LiteralType";
    }
    toConstructor() {
        return `new LiteralTypeType(${JSON.stringify(this.value)}, ${this.isDotDotDot}, ${this.isQuestion})`;
    }
    toString() {
        return JSON.stringify(this.value);
    }
    convert(argument) {
        if (argument === this.value) {
            return argument;
        }
        throw new Error(`Argument does not match expected value (${this.value}): ${argument}`);
    }
}
exports.LiteralTypeType = LiteralTypeType;
