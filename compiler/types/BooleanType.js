"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BooleanType = void 0;
class BooleanType {
    constructor(isDotDotDot = false, isQuestion = false) {
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "boolean";
    }
    toConstructor() {
        return `new BooleanType(${this.isDotDotDot}, ${this.isQuestion})`;
    }
    toString() {
        return this.kind;
    }
    convert(argument) {
        if (argument === "true") {
            return true;
        }
        else if (argument === "false") {
            return false;
        }
        throw new Error("Can't convert ${argument} to boolean");
    }
}
exports.BooleanType = BooleanType;
