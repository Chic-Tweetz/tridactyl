"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoidType = void 0;
class VoidType {
    constructor(isDotDotDot = false, isQuestion = false) {
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "void";
    }
    toConstructor() {
        return `new VoidType(${this.isDotDotDot}, ${this.isQuestion})`;
    }
    toString() {
        return this.kind;
    }
    convert(argument) {
        return null;
    }
}
exports.VoidType = VoidType;
