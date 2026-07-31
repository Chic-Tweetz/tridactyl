"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SymbolMetadata = void 0;
class SymbolMetadata {
    constructor(doc, type, hidden = false) {
        this.doc = doc;
        this.type = type;
        this.hidden = hidden;
    }
    toConstructor() {
        return `new SymbolMetadata(${JSON.stringify(this.doc)}, ${this.type.toConstructor()}, ${this.hidden})`;
    }
}
exports.SymbolMetadata = SymbolMetadata;
