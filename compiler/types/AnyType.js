"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnyType = void 0;
class AnyType {
    constructor(isDotDotDot = false, isQuestion = false) {
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "any";
    }
    toConstructor() {
        return `new AnyType(${!this.isDotDotDot}, ${this.isQuestion})`;
    }
    toString() {
        return this.kind;
    }
    convert(argument) {
        return argument;
    }
}
exports.AnyType = AnyType;
