"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileMetadata = void 0;
class FileMetadata {
    constructor(classes = new Map(), functions = new Map()) {
        this.classes = classes;
        this.functions = functions;
    }
    setClass(name, c) {
        this.classes.set(name, c);
    }
    getClass(name) {
        return this.classes.get(name);
    }
    getClasses() {
        return Array.from(this.classes.keys());
    }
    setFunction(name, f) {
        this.functions.set(name, f);
    }
    getFunction(name) {
        return this.functions.get(name);
    }
    getFunctions() {
        return Array.from(this.functions.entries());
    }
    getFunctionNames() {
        return Array.from(this.functions.keys());
    }
    toConstructor() {
        return (`new FileMetadata(new Map<string, ClassMetadata>([` +
            Array.from(this.classes.entries())
                .map(([n, c]) => `[${JSON.stringify(n)}, ${c.toConstructor()}]`)
                .join(",\n") +
            `]), new Map<string, SymbolMetadata>([` +
            Array.from(this.functions.entries())
                .map(([n, f]) => `[${JSON.stringify(n)}, ${f.toConstructor()}]`)
                .join(",\n") +
            `]))`);
    }
}
exports.FileMetadata = FileMetadata;
