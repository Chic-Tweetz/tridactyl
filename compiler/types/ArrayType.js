"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArrayType = void 0;
class ArrayType {
    constructor(elemType, isDotDotDot = false, isQuestion = false) {
        this.elemType = elemType;
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "array";
    }
    toConstructor() {
        return `new ArrayType(${this.elemType.toConstructor()}, ${this.isDotDotDot}, ${this.isQuestion})`;
    }
    toString() {
        return `${this.elemType.toString()}[]`;
    }
    convert(argument) {
        if (!Array.isArray(argument)) {
            try {
                argument = JSON.parse(argument);
            }
            catch (e) {
                throw new Error(`Can't convert ${argument} to array:`);
            }
            if (!Array.isArray(argument)) {
                throw new Error(`Can't convert ${argument} to array:`);
            }
        }
        return argument.map(v => this.elemType.convert(v));
    }
}
exports.ArrayType = ArrayType;
