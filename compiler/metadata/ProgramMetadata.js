"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProgramMetadata = void 0;
class ProgramMetadata {
    constructor(files = new Map()) {
        this.files = files;
    }
    setFile(name, file) {
        this.files.set(name, file);
    }
    getFile(name) {
        return this.files.get(name);
    }
    toConstructor() {
        return (`new ProgramMetadata(new Map<string, FileMetadata>([` +
            Array.from(this.files.entries())
                .map(([n, f]) => `[${JSON.stringify(n)}, ${f.toConstructor()}]`)
                .join(",\n") +
            `]))`);
    }
}
exports.ProgramMetadata = ProgramMetadata;
