"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypeReferenceType = void 0;
class TypeReferenceType {
    constructor(kind, args, isDotDotDot = false, isQuestion = false) {
        this.kind = kind;
        this.args = args;
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
    }
    toConstructor() {
        return (`new TypeReferenceType(${JSON.stringify(this.kind)}, [` +
            // Turn every type argument into its constructor representation
            this.args.map(cur => cur.toConstructor()).join(",\n") +
            `], ${this.isDotDotDot}, ${this.isQuestion})`);
    }
    toString() {
        return `${this.kind}<${this.args.map(a => a.toString()).join(", ")}>`;
    }
    convert(argument) {
        throw new Error("Conversion of simple type references not implemented.");
    }
}
exports.TypeReferenceType = TypeReferenceType;
