"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnionType = void 0;
class UnionType {
    constructor(types, isDotDotDot = false, isQuestion = false) {
        this.types = types;
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "union";
    }
    toConstructor() {
        return (`new UnionType([` +
            // Convert every type to its string constructor representation
            this.types.map(cur => cur.toConstructor()).join(",\n") +
            `], ${this.isDotDotDot}, ${this.isQuestion})`);
    }
    toString() {
        return this.types.map(t => t.toString()).join(" | ");
    }
    convert(argument) {
        for (const t of this.types) {
            try {
                return t.convert(argument);
            }
            catch (e) { }
        }
        throw new Error(`Can't convert "${argument}" to any of: ${this.types}`);
    }
}
exports.UnionType = UnionType;
