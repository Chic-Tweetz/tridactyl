"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TupleType = void 0;
class TupleType {
    constructor(elemTypes, isDotDotDot = false, isQuestion = false) {
        this.elemTypes = elemTypes;
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "tuple";
    }
    toConstructor() {
        return (`new TupleType([` +
            // Convert every element type to its constructor representation
            this.elemTypes.map(cur => cur.toConstructor()).join(",\n") +
            `], ${this.isDotDotDot}, ${this.isQuestion})`);
    }
    toString() {
        return `[${this.elemTypes.map(e => e.toString()).join(", ")}]`;
    }
    convert(argument) {
        if (!Array.isArray(argument)) {
            try {
                argument = JSON.parse(argument);
            }
            catch (e) {
                throw new Error(`Can't convert to tuple: ${argument}`);
            }
            if (!Array.isArray(argument)) {
                throw new Error(`Can't convert to tuple: ${argument}`);
            }
        }
        if (argument.length !== this.elemTypes.length) {
            throw new Error(`Error converting tuple: number of elements and type mismatch ${argument}`);
        }
        return argument.map((v, i) => this.elemTypes[i].convert(v));
    }
}
exports.TupleType = TupleType;
